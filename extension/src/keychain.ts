// Батч 27: Keychain — профили ключей и циклический failover.
// Батч 28: новая модель профилей — профиль = провайдер + НЕСКОЛЬКО ключей
// этого провайдера (KeychainKey[]). Цикл failover строится из профилей:
// 429 ротирует enabled-ключи внутри профиля циклически; когда все ключи
// профиля спят — переход к следующему профилю по порядку стрелок (cycle++);
// спят все везде — пауза до ближайшего пробуждения и новый цикл.
// Здесь живёт ВСЯ логика: CRUD несекретного списка в settings
// (codescout.keychain), секретов на ключ (keychain.<profileId>.<keyId> в
// SecretStorage), миграции (одиночный ключ → профиль «default»; профили
// батча 27 без ключей → keys[0] со старым секретом), runtime-метки
// sleep/broken на ключ и решатель цепочки. extension.ts — тонкая проводка.
// Решатель чистый (now и профили приходят аргументами) — тестируется без
// таймеров и без сети; мутация runtime — в функциях mark*/is*.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { assertHttpBaseUrl, defaultModel, normalizeProvider, type ProviderName } from '../../src/providers';

// Батч 28: один ключ профиля. secretId — адрес секрета в SecretStorage
// (несекретный указатель), сам ключ там и лежит.
export interface KeychainKey {
  id: string;
  label: string;
  // keychain.<profileId>.<keyId> — всегда пересчитывается при нормализации:
  // settings не должен указывать на чужие секреты.
  secretId: string;
  // false = ключ вне ротации (выключен пользователем), никогда не дёргается.
  enabled: boolean;
}

export interface KeychainProfile {
  id: string;
  label: string;           // «groq·основной», «openrouter·alt»
  provider: ProviderName;
  model?: string;
  // Батч 27.1, п.1: per-profile override эндпоинта. Приоритет резолва в
  // providers.resolveBaseUrl: profile.baseUrl → codescout.baseUrl (только
  // custom/local) → PROVIDERS[provider].baseUrl. Пустое = «как у провайдера».
  baseUrl?: string;
  // Батч 28: массив ключей этого провайдера (всегда >=1 после нормализации).
  keys: KeychainKey[];
}

// vscode.SecretStorage отдаёт Thenable (не Promise) — берём PromiseLike,
// чтобы подходили и секреты VS Code, и тестовые Map-backed моки.
export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const KEYCHAIN_SETTING = 'keychain';
export const KEYCHAIN_ACTIVE_SETTING = 'keychain.active';
export const KEYCHAIN_SECRET_PREFIX = 'keychain.';
export const KEYCHAIN_MIGRATED_FLAG = 'codescout.keychainMigrated';
// Батч 28: однократная миграция «профиль с одним секретом» → «профиль с
// keys[0]»; после неё все секреты живут по secretId ключей.
export const KEYCHAIN_KEYS_MIGRATED_FLAG = 'codescout.keychainKeysMigrated';
// Профиль «default» — обязательный id для миграции старого одиночного ключа.
export const DEFAULT_PROFILE_ID = 'default';
// Батч 27.1, п.2: профиль онбординга — мастер пишет сюда, а не в legacy-слот
// (legacy трогается только при пустом keychain, см. onboard* в extension.ts).
export const ONBOARDED_PROFILE_ID = 'onboarded';
// Идентичатор «первого» ключа профиля (миграция и пустой add) — label по
// спеке «default», enabled=true.
export const DEFAULT_KEY_ID = 'default';
// Профиль без retry-after засыпает по этой лестнице (секунды), шаг
// растёт с каждым новым 429 на этом КЛЮЧЕ (батч 28: лестница на ключ,
// а не на профиль).
export const FAILOVER_SLEEP_LADDER_SECONDS = [120, 300, 600];
const MAX_PROFILES = 20;
const MAX_KEYS_PER_PROFILE = 10;

function validProvider(value: unknown): ProviderName | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  try {
    return normalizeProvider(raw);
  } catch {
    return undefined;
  }
}

// Адрес секрета ключа: keychain.<profileId>.<keyId> (спека батча 28).
export function keySecretId(profileId: string, keyId: string): string {
  return `${KEYCHAIN_SECRET_PREFIX}${profileId}.${keyId}`;
}

// Legacy-адрес батча 27: один секрет на профиль. Остался только для
// миграции и fallback-чтения немигрированных установок.
export function secretKeyForProfile(id: string): string {
  return `${KEYCHAIN_SECRET_PREFIX}${id}`;
}

export function defaultKeyFor(profileId: string): KeychainKey {
  return { id: DEFAULT_KEY_ID, label: 'default', secretId: keySecretId(profileId, DEFAULT_KEY_ID), enabled: true };
}

// Нормализация ключей профиля: id обязателен, дубли выкидываем, label по
// умолчанию = id/«ключ-N», enabled=false только явный, secretId ВСЕГДА
// пересчитываем из (profileId, keyId) — чужой secretId из settings игнорируется.
function normalizeKeys(profileId: string, raw: unknown): KeychainKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeychainKey[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : `ключ-${out.length + 1}`;
    out.push({ id, label, secretId: keySecretId(profileId, id), enabled: entry.enabled !== false });
    if (out.length >= MAX_KEYS_PER_PROFILE) break;
  }
  return out;
}

// Нормализация списка из settings: мусор/дубли id выкидываем, id/label
// обязательны, provider — только известный, model опционален. Профиль без
// валидных ключей получает default-ключ (профили батча 27 работают после
// обновления без действий пользователя; секрет мигрирует flag'ом ниже).
export function normalizeProfiles(raw: unknown): KeychainProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeychainProfile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const provider = validProvider(entry.provider);
    if (!id || !provider || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id;
    const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined;
    const base = profileBaseUrl(entry.baseUrl);
    const keys = normalizeKeys(id, entry.keys);
    out.push({ id, label, provider, ...(model ? { model } : {}), ...(base ? { baseUrl: base } : {}), keys: keys.length ? keys : [defaultKeyFor(id)] });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

// Батч 27.1, п.1: baseUrl профиля валидируем строго (http(s), http только
// localhost). Битый URL ронять профиль не должен — просто игнорируем поле,
// резолв упадёт на PROVIDERS[provider].baseUrl.
export function profileBaseUrl(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!value) return undefined;
  try {
    return assertHttpBaseUrl(value);
  } catch {
    return undefined;
  }
}

export function readProfiles(): KeychainProfile[] {
  const config = vscode.workspace.getConfiguration('codescout');
  return normalizeProfiles(config.get<unknown[]>(KEYCHAIN_SETTING));
}

export async function writeProfiles(profiles: KeychainProfile[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('codescout');
  await config.update(KEYCHAIN_SETTING, profiles.map((p) => ({ ...p })), vscode.ConfigurationTarget.Global);
}

export function readActiveId(): string {
  const config = vscode.workspace.getConfiguration('codescout');
  return config.get<string>(KEYCHAIN_ACTIVE_SETTING, '').trim();
}

export async function writeActiveId(id: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('codescout');
  await config.update(KEYCHAIN_ACTIVE_SETTING, id, vscode.ConfigurationTarget.Global);
}

// ── Секреты на ключ ──────────────────────────────────────────────────────────

export async function readKeySecret(secrets: SecretsLike, profile: KeychainProfile, key: KeychainKey): Promise<string | undefined> {
  const value = await secrets.get(key.secretId);
  if (value?.trim()) return value;
  // Fallback немигрированной установки (батч 27): секрет лежал на
  // keychain.<profileId>. Только для первого default-ключа.
  if (key.id === DEFAULT_KEY_ID && profile.keys[0]?.id === DEFAULT_KEY_ID) return await secrets.get(secretKeyForProfile(profile.id));
  return undefined;
}

export async function storeKeySecret(secrets: SecretsLike, key: KeychainKey, value: string): Promise<void> {
  await secrets.store(key.secretId, value);
}

// Секрет «рабочей» ключа профиля: тот, которым пойдёт следующий запрос
// (первый enabled, предпочтительно не broken), fallback на default-ключ.
export async function readProfileSecret(secrets: SecretsLike, profileId: string): Promise<string | undefined> {
  const profile = readProfiles().find((candidate) => candidate.id === profileId);
  if (!profile) return await secrets.get(secretKeyForProfile(profileId));
  const key = pickActiveKey(profile) ?? profile.keys[0];
  return key ? await readKeySecret(secrets, profile, key) : undefined;
}

export async function storeProfileSecret(secrets: SecretsLike, profileId: string, value: string): Promise<KeychainKey | undefined> {
  const profiles = readProfiles();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) { const fresh = defaultKeyFor(profileId); await storeKeySecret(secrets, fresh, value.trim()); return fresh; }
  // МИКРО-БАТЧ 28.9: сохранённый ключ = свежий ключ: чистим broken-метку и
  // возвращаем выключенный ключ в ротацию (иначе «Сохранить» писал бы в
  // ключ, который решатель никогда не возьмёт, — источник формально один,
  // а рабочий ключ мёртвый).
  const key = pickActiveKey(profile) ?? profile.keys[0];
  await storeKeySecret(secrets, key, value.trim());
  clearKeyBroken(profileId, key.id);
  if (!key.enabled) await setKeyEnabled(profileId, key.id, true);
  return key;
}

// Удаление всех секретов профиля: каждый key.secretId + legacy-адрес.
export async function deleteProfileSecret(secrets: SecretsLike, profileId: string): Promise<void> {
  const profiles = readProfiles();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  const ids = new Set<string>([secretKeyForProfile(profileId), defaultKeyFor(profileId).secretId]);
  for (const key of profile?.keys ?? []) ids.add(key.secretId);
  for (const id of ids) await secrets.delete(id);
}

function slugify(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || `profile-${randomBytes(3).toString('hex')}`;
}

export function makeProfileId(label: string, existing: readonly KeychainProfile[]): string {
  const taken = new Set(existing.map((profile) => profile.id));
  const base = slugify(label);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

// id ключа: ТОЛЬКО [a-z0-9-] (без точек!) — secretId составной
// keychain.<profile>.<key>, точки внутри id создавали бы коллизии адресов.
function slugKey(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || `key-${randomBytes(3).toString('hex')}`;
}

export function makeKeyId(label: string, existing: readonly KeychainKey[]): string {
  const taken = new Set(existing.map((key) => key.id));
  const base = slugKey(label);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

// Добавить профиль: первый ключ создаём сразу (spec: keys[0] «default»),
// секрет — по secretId ключа. Первый профиль становится активным.
export async function addProfile(secrets: SecretsLike, input: { label: string; provider: ProviderName; model?: string; key: string; baseUrl?: string }): Promise<KeychainProfile> {
  const profiles = readProfiles();
  const label = input.label.trim() || input.provider;
  const id = makeProfileId(label, profiles);
  const base = profileBaseUrl(input.baseUrl);
  const key: KeychainKey = { id: DEFAULT_KEY_ID, label: 'default', secretId: keySecretId(id, DEFAULT_KEY_ID), enabled: true };
  const profile: KeychainProfile = { id, label, provider: input.provider, ...(input.model?.trim() ? { model: input.model.trim() } : {}), ...(base ? { baseUrl: base } : {}), keys: [key] };
  await storeKeySecret(secrets, key, input.key.trim());
  await writeProfiles([...profiles, profile]);
  if (!readActiveId() || !profiles.some((p) => p.id === readActiveId())) await writeActiveId(id);
  return profile;
}

// Батч 28: добавить КЛЮЧ в существующий профиль (вставкой). label пустой →
// «ключ-N». Возвращает обновлённый профиль или undefined (нет профиля /
// потолок ключей).
export async function addKey(secrets: SecretsLike, profileId: string, input: { label?: string; key: string }): Promise<KeychainProfile | undefined> {
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target || target.keys.length >= MAX_KEYS_PER_PROFILE) return undefined;
  const label = input.label?.trim() || `ключ-${target.keys.length + 1}`;
  const keyId = makeKeyId(label, target.keys);
  const key: KeychainKey = { id: keyId, label, secretId: keySecretId(profileId, keyId), enabled: true };
  await storeKeySecret(secrets, key, input.key.trim());
  const next = profiles.map((profile) => (profile.id === profileId ? { ...profile, keys: [...profile.keys, key] } : profile));
  await writeProfiles(next);
  return next.find((profile) => profile.id === profileId);
}

export async function renameKey(profileId: string, keyId: string, label: string): Promise<KeychainProfile | undefined> {
  const profiles = readProfiles();
  const next = profiles.map((profile) => profile.id !== profileId ? profile : {
    ...profile,
    keys: profile.keys.map((key) => key.id === keyId ? { ...key, label: label.trim() || key.label } : key)
  });
  await writeProfiles(next);
  return next.find((profile) => profile.id === profileId);
}

// Последний ключ профиля НЕ удаляем: профиль без ключа неработоспособен —
// удалите профиль целиком. Возврат: ok=false при отказе/несуществующих id.
export async function removeKey(secrets: SecretsLike, profileId: string, keyId: string): Promise<{ ok: boolean; reason?: 'lastKey' | 'unknown'; profile?: KeychainProfile }> {
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target) return { ok: false, reason: 'unknown' };
  const key = target.keys.find((candidate) => candidate.id === keyId);
  if (!key) return { ok: false, reason: 'unknown' };
  if (target.keys.length <= 1) return { ok: false, reason: 'lastKey' };
  const next = profiles.map((profile) => profile.id !== profileId ? profile : { ...profile, keys: profile.keys.filter((candidate) => candidate.id !== keyId) });
  await secrets.delete(key.secretId);
  await writeProfiles(next);
  deleteRuntimeForKey(profileId, keyId);
  return { ok: true, profile: next.find((profile) => profile.id === profileId) };
}

export async function setKeyEnabled(profileId: string, keyId: string, enabled: boolean): Promise<KeychainProfile | undefined> {
  const profiles = readProfiles();
  const next = profiles.map((profile) => profile.id !== profileId ? profile : {
    ...profile,
    keys: profile.keys.map((key) => key.id === keyId ? { ...key, enabled } : key)
  });
  await writeProfiles(next);
  return next.find((profile) => profile.id === profileId);
}

// Батч 28: «стрелки» — порядок профилей в списке = порядок цикла failover.
export async function moveProfile(profileId: string, direction: -1 | 1): Promise<KeychainProfile[] | undefined> {
  const profiles = readProfiles();
  const index = profiles.findIndex((profile) => profile.id === profileId);
  if (index < 0) return undefined;
  const target = index + direction;
  if (target < 0 || target >= profiles.length) return profiles;
  const next = [...profiles];
  const moved = next.splice(index, 1)[0];
  next.splice(target, 0, moved);
  await writeProfiles(next);
  return next;
}

// Рабочий ключ профиля для старта скана/резолва: первый enabled,
// предпочтительно не broken; если broken все enabled — первый enabled
// (честный 401-путь обновит метку). Ни одного enabled — undefined.
export function pickActiveKey(profile: KeychainProfile | undefined): KeychainKey | undefined {
  if (!profile) return undefined;
  const enabled = profile.keys.filter((key) => key.enabled);
  if (!enabled.length) return undefined;
  return enabled.find((key) => !isKeyBroken(profile.id, key.id)) ?? enabled[0];
}

// МИКРО-БАТЧ 28.10 (opt-out): есть ли в цепочке хоть один ВКЛЮЧЁННЫЙ ключ.
// «Выключено = удалено для фолбэка»: ноль профилей ИЛИ ноль включённых
// ключей → кейчейн спит, источник ключа — legacy-карточка центра.
// Секреты при этом НЕ теряются: тумблер только выводит ключ из ротации.
export function hasEnabledKey(profiles: KeychainProfile[] = readProfiles()): boolean {
  return profiles.some((profile) => profile.keys.some((key) => key.enabled));
}

// Профиль-источник в ключевом пути: активный id среди профилей с
// включёнными ключами, иначе первый такой профиль; ни одного включённого
// ключа во всём списке — undefined (простой режим, legacy-фолбэк).
export function activeUsableProfile(profiles: KeychainProfile[] = readProfiles(), activeId = readActiveId()): KeychainProfile | undefined {
  const usable = profiles.filter((profile) => profile.keys.some((key) => key.enabled));
  return usable.find((profile) => profile.id === activeId) ?? usable[0];
}

// Кнопка «Выключить все ключи (простой режим)»: один клик вместо N
// тумблеров. enabled=false у всех ключей всех профилей одним writeProfiles;
// секретные записи не трогаются — обратный переход (включить любой ключ)
// возвращает кейчейн как источник без потери секретов.
export async function disableAllKeys(): Promise<{ profiles: KeychainProfile[]; disabled: number }> {
  const profiles = readProfiles();
  let disabled = 0;
  const next = profiles.map((profile) => ({
    ...profile,
    keys: profile.keys.map((key) => {
      if (!key.enabled) return key;
      disabled += 1;
      return { ...key, enabled: false };
    })
  }));
  if (disabled > 0) await writeProfiles(next);
  return { profiles: next, disabled };
}

// Обратный ход кнопки-подсказки: включить ВСЕ ключи всех профилей одним
// writeProfiles. Секреты не трогаем; ключи без секрета включаются как есть
// (честный errNoKeyProfile-путь). Кейчейн снова источник, legacy засыпает.
export async function enableAllKeys(): Promise<{ profiles: KeychainProfile[]; enabled: number }> {
  const profiles = readProfiles();
  let enabled = 0;
  const next = profiles.map((profile) => ({
    ...profile,
    keys: profile.keys.map((key) => {
      if (key.enabled) return key;
      enabled += 1;
      return { ...key, enabled: true };
    })
  }));
  if (enabled > 0) await writeProfiles(next);
  return { profiles: next, enabled };
}

// Батч 27.1, п.1: «Override Base URL» профиля. Пустая строка = сброс
// (используем базовый URL провайдера); битый URL — undefined → вызывающий
// показывает ошибку и ничего не пишет.
export async function setProfileBaseUrl(id: string, baseUrl: string | undefined): Promise<KeychainProfile | undefined> {
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return undefined;
  const trimmed = baseUrl?.trim() ?? '';
  const base = trimmed ? profileBaseUrl(trimmed) : '';
  if (trimmed && !base) return undefined;
  const next = profiles.map((profile) => {
    if (profile.id !== id) return profile;
    return { id: profile.id, label: profile.label, provider: profile.provider, ...(profile.model?.trim() ? { model: profile.model.trim() } : {}), ...(base ? { baseUrl: base } : {}), keys: profile.keys } satisfies KeychainProfile;
  });
  await writeProfiles(next);
  return next.find((profile) => profile.id === id);
}

// МИКРО-БАТЧ 28.2: сохранение инлайн-формы профиля (режим редактирования).
// keys и id не трогаем; непустой key пишем в рабочий enabled-ключ. Пустое
// название = старое метка (авто-метку считает вызывающий при создании).
// Смена провайдера без явной модели в форме → дефолт нового провайдера.
// Битый baseUrl или неизвестный id → undefined, ничего не пишем.
export async function updateProfileFromForm(secrets: SecretsLike, id: string, input: { label?: string; provider?: string; model?: string; key?: string; baseUrl?: string }): Promise<KeychainProfile | undefined> {
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return undefined;
  const provider = validProvider(input.provider) ?? target.provider;
  const providerChanged = provider !== target.provider;
  const trimmedBaseUrl = input.baseUrl?.trim() ?? '';
  const base = trimmedBaseUrl ? profileBaseUrl(trimmedBaseUrl) : '';
  if (trimmedBaseUrl && !base) return undefined;
  const label = input.label?.trim() || target.label;
  const model = input.model?.trim() || (providerChanged ? defaultModel(provider) : target.model ?? '');
  const next = profiles.map((profile) => profile.id !== id ? profile : {
    id: profile.id,
    label,
    provider,
    ...(model ? { model } : {}),
    ...(base ? { baseUrl: base } : {}),
    keys: profile.keys
  });
  const trimmedKey = input.key?.trim();
  if (trimmedKey) {
    const updated = next.find((profile) => profile.id === id);
    const key = updated ? pickActiveKey(updated) ?? updated.keys[0] : undefined;
    if (key) {
      await storeKeySecret(secrets, key, trimmedKey);
      // 28.9: новый ключ в том же адресе — broken-метка про него больше не
      // правда; выключенный ключ включается в том же writeProfiles(next)
      // (отдельный setKeyEnabled был бы затёрт массивом next ниже).
      clearKeyBroken(id, key.id);
      for (const profile of next) {
        if (profile.id !== id) continue;
        profile.keys = profile.keys.map((candidate) => (candidate.id === key.id ? { ...candidate, enabled: true } : candidate));
      }
    }
  }
  await writeProfiles(next);
  return next.find((profile) => profile.id === id);
}

export async function renameProfile(id: string, label: string): Promise<KeychainProfile[]> {
  const profiles = readProfiles();
  const next = profiles.map((profile) => (profile.id === id ? { ...profile, label: label.trim() || profile.label } : profile));
  await writeProfiles(next);
  return next;
}

// Удаление. Активный профиль без явного newActive НЕ удаляем — вызывающий
// обязан сначала спросить новый актив (без молчаливого фолбэка). Удаление
// последнего профиля — единственный случай «чистим актив», и только с
// явным newActiveId==='' от подтвердившего действие пользователя.
// Секреты ВСЕХ ключей профиля удаляются вместе с ним.
export async function removeProfile(secrets: SecretsLike, id: string, newActiveId?: string): Promise<{ ok: boolean; profiles: KeychainProfile[]; activeId: string }> {
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === id);
  if (!target) return { ok: false, profiles, activeId: readActiveId() };
  const rest = profiles.filter((profile) => profile.id !== id);
  if (id === readActiveId()) {
    if (rest.length === 0) {
      if (newActiveId !== '') return { ok: false, profiles, activeId: readActiveId() };
      await writeActiveId('');
    } else {
      if (!newActiveId || newActiveId === id || !rest.some((profile) => profile.id === newActiveId)) {
        return { ok: false, profiles, activeId: readActiveId() };
      }
      await writeActiveId(newActiveId);
    }
  }
  await deleteProfileSecret(secrets, id);
  await writeProfiles(rest);
  runtime.delete(id); // legacy-метки профиля целиком (на случай старых записей)
  for (const key of target.keys) runtime.delete(keyRuntimeId(id, key.id));
  if (rest.length === 0) await writeActiveId('');
  return { ok: true, profiles: rest, activeId: rest.length ? readActiveId() : '' };
}

// Батч 27.1, п.2: онбординг пишет в keychain — создаёт/обновляет профиль
// «onboarded» (секрет — в первом ключе) и делает его активным. Повторный
// онбординг обновляет ТОТ ЖЕ профиль и НЕ плодит дубли ключей.
export async function upsertOnboardedProfile(secrets: SecretsLike, input: { provider: ProviderName; model?: string; key: string; baseUrl?: string }): Promise<KeychainProfile> {
  const profiles = readProfiles();
  const base = profileBaseUrl(input.baseUrl);
  const existing = profiles.find((profile) => profile.id === ONBOARDED_PROFILE_ID);
  const key = existing ? (pickActiveKey(existing) ?? existing.keys[0]) : defaultKeyFor(ONBOARDED_PROFILE_ID);
  const profile: KeychainProfile = {
    id: ONBOARDED_PROFILE_ID,
    label: ONBOARDED_PROFILE_ID,
    provider: input.provider,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(base ? { baseUrl: base } : {}),
    keys: existing ? (existing.keys.some((candidate) => candidate.id === key.id) ? existing.keys : [key]) : [key]
  };
  await storeKeySecret(secrets, key, input.key.trim());
  await writeProfiles(existing ? profiles.map((candidate) => (candidate.id === ONBOARDED_PROFILE_ID ? profile : candidate)) : [...profiles, profile]);
  await writeActiveId(ONBOARDED_PROFILE_ID);
  return profile;
}

// Миграция текущего одиночного ключа → профиль «default» БЕЗ потери:
// старый секрет остаётся на месте (откат безопасен), профиль получает свою
// копию в keys[0]. Флаг в SecretStorage — миграция однократная; пустой список
// профилей после миграции = пользователь удалил их сам, навязывать default не надо.
export async function migrateLegacyKeyToDefault(context: vscode.ExtensionContext): Promise<boolean> {
  const legacyKey = (await context.secrets.get(SECRET_KEY_OF_LEGACY))?.trim();
  if (!legacyKey) return false;
  if ((await context.secrets.get(KEYCHAIN_MIGRATED_FLAG)) === 'true') return false;
  if (readProfiles().length > 0) {
    await context.secrets.store(KEYCHAIN_MIGRATED_FLAG, 'true');
    return false;
  }
  const provider = validProvider((await context.secrets.get('codescout.provider'))?.trim()) ?? validProvider(vscode.workspace.getConfiguration('codescout').get<string>('provider')) ?? 'gemini';
  const model = (await context.secrets.get('codescout.model'))?.trim() || undefined;
  const key = defaultKeyFor(DEFAULT_PROFILE_ID);
  const profile: KeychainProfile = { id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_ID, provider, ...(model ? { model } : {}), keys: [key] };
  await storeKeySecret(context.secrets, key, legacyKey);
  await writeProfiles([profile]);
  await writeActiveId(DEFAULT_PROFILE_ID);
  await context.secrets.store(KEYCHAIN_MIGRATED_FLAG, 'true');
  return true;
}

const SECRET_KEY_OF_LEGACY = 'codescout.apiKey';

// Батч 28: миграция профилей батча 27 (без keys) в новую модель. Для каждого
// профиля без массива ключей в RAW settings: keys=[default], секрет
// переезжает keychain.<id> → keychain.<id>.default (store+delete; между
// шагами safe — флаг ставится в конце, повтор идемпотентен). Профили, у
// которых keys уже есть, не трогаем. Флаг однократности.
export async function migrateProfilesToMultiKey(context: vscode.ExtensionContext): Promise<boolean> {
  if ((await context.secrets.get(KEYCHAIN_KEYS_MIGRATED_FLAG)) === 'true') return false;
  const config = vscode.workspace.getConfiguration('codescout');
  const raw = config.get<unknown[]>(KEYCHAIN_SETTING);
  if (!Array.isArray(raw) || raw.length === 0) {
    await context.secrets.store(KEYCHAIN_KEYS_MIGRATED_FLAG, 'true');
    return false;
  }
  let changed = false;
  const next: KeychainProfile[] = [];
  for (const item of normalizeProfiles(raw)) {
    const rawEntry = raw.find((candidate) => candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === item.id) as Record<string, unknown> | undefined;
    const hadKeys = Array.isArray(rawEntry?.keys) && (rawEntry?.keys as unknown[]).length > 0;
    if (hadKeys) { next.push(item); continue; }
    const key = defaultKeyFor(item.id);
    const oldSecret = (await context.secrets.get(secretKeyForProfile(item.id)))?.trim();
    if (oldSecret) {
      await storeKeySecret(context.secrets, key, oldSecret);
      await context.secrets.delete(secretKeyForProfile(item.id));
    }
    next.push({ ...item, keys: [key] });
    changed = true;
  }
  await writeProfiles(next);
  await context.secrets.store(KEYCHAIN_KEYS_MIGRATED_FLAG, 'true');
  return changed;
}

// ── runtime: сон/сломанность КЛЮЧЕЙ + циклы ротации ─────────────────────────

export interface ProfileRuntime {
  sleepUntil: number;
  ladderStep: number;
  broken: boolean;
  // МИКРО-БАТЧ 28.9: «стена тарифа» (402/credits/billing). Ключ НЕ спит —
  // сон не поможет; выведен из ротации как broken, диагноз отдельный.
  // Опционально: записи старых процессов/тестов без поля = не заблокирован.
  billingBlocked?: boolean;
}

// Композитный id состояния: «profileId/keyId».
export function keyRuntimeId(profileId: string, keyId: string): string {
  return `${profileId}/${keyId}`;
}

// Единый runtime процесса: переживает отдельные сканы (sleepUntil
// актуальна до протухания), сбрасывается тестами через resetRuntime.
export const runtime = new Map<string, ProfileRuntime>();

export function resetRuntime(): void {
  runtime.clear();
  scanRuntime = { cycle: 0, allowWaitOnce: false, currentId: '', currentKeyId: '' };
}

// Состояние ротации ТЕКУЩЕГО скана: номер цикла, разовое разрешение
// «подождать» (кнопка баннера) и пара (профиль, ключ), которой скан идёт
// сейчас (обновляется при switch — читает чекпоинт для метки файла).
interface ScanRuntime {
  cycle: number;
  allowWaitOnce: boolean;
  currentId: string;
  currentKeyId: string;
}

let scanRuntime: ScanRuntime = { cycle: 0, allowWaitOnce: false, currentId: '', currentKeyId: '' };

export function beginScan(profileId: string, keyId = DEFAULT_KEY_ID): void {
  // allowWaitOnce НЕ сбрасываем: «Подождать и продолжить» нажимается между
  // сканами (grant → рестарт), consume — в decideFailover при использовании.
  scanRuntime = { cycle: 0, allowWaitOnce: scanRuntime.allowWaitOnce, currentId: profileId, currentKeyId: keyId };
}

export function scanCurrent(): { profileId: string; keyId: string } {
  return { profileId: scanRuntime.currentId, keyId: scanRuntime.currentKeyId };
}

// Батч 27-совместимый геттер: id текущего профиля.
export function scanCurrentId(): string {
  return scanRuntime.currentId;
}

export function scanCurrentKeyId(): string {
  return scanRuntime.currentKeyId;
}

export function scanCycle(): number {
  return scanRuntime.cycle;
}

// «Подождать и продолжить» из баннера: один раз разрешить паузу до
// пробуждения даже при выключенном автономном режиме.
export function grantWaitOnce(): void {
  scanRuntime.allowWaitOnce = true;
}

function stateOf(runtimeId: string): ProfileRuntime {
  let state = runtime.get(runtimeId);
  if (!state) {
    state = { sleepUntil: 0, ladderStep: 0, broken: false, billingBlocked: false };
    runtime.set(runtimeId, state);
  }
  return state;
}

export function isKeyAsleep(profileId: string, keyId: string, now: number): boolean {
  return (runtime.get(keyRuntimeId(profileId, keyId))?.sleepUntil ?? 0) > now;
}

export function isKeyBroken(profileId: string, keyId: string): boolean {
  return runtime.get(keyRuntimeId(profileId, keyId))?.broken === true;
}

// 429 без retry-after — лестница 120/300/600 на КЛЮЧ (шаг растёт).
export function markKeyRateLimited(profileId: string, keyId: string, now: number, waitSeconds: number | undefined): number {
  const state = stateOf(keyRuntimeId(profileId, keyId));
  const seconds = waitSeconds !== undefined && waitSeconds > 0
    ? Math.ceil(waitSeconds)
    : FAILOVER_SLEEP_LADDER_SECONDS[Math.min(state.ladderStep, FAILOVER_SLEEP_LADDER_SECONDS.length - 1)];
  if (waitSeconds === undefined || waitSeconds <= 0) state.ladderStep += 1;
  state.sleepUntil = now + seconds * 1000;
  return seconds;
}

// 401/403 — broken (НЕ asleep): ключ выводится из цепочки, автопереход
// по auth-ошибке запрещён, квотный «сон» не ставится.
export function markKeyBroken(profileId: string, keyId: string): void {
  stateOf(keyRuntimeId(profileId, keyId)).broken = true;
}

// МИКРО-БАТЧ 28.9: стена тарифа (402/credits/billing). НЕ сон: sleepUntil не
// трогаем, лестницу не крутим — ключ выводится из ротации как broken.
export function markKeyBillingBlocked(profileId: string, keyId: string): void {
  stateOf(keyRuntimeId(profileId, keyId)).billingBlocked = true;
}

export function isKeyBillingBlocked(profileId: string, keyId: string): boolean {
  return runtime.get(keyRuntimeId(profileId, keyId))?.billingBlocked === true;
}

export function clearKeyBroken(profileId: string, keyId: string): void {
  const state = runtime.get(keyRuntimeId(profileId, keyId));
  if (state) {
    state.broken = false;
    // 28.9: новый ключ/активация профиля снимает и billing-метку — баланс
    // мог пополниться, модель могла измениться, старый диагноз протух.
    state.billingBlocked = false;
  }
}

// Успешный файл на ключе — сбрасываем лестницу (квота живая).
export function markKeyHealthy(profileId: string, keyId: string): void {
  const state = runtime.get(keyRuntimeId(profileId, keyId));
  if (state) state.ladderStep = 0;
}

// Полная очистка runtime-метки ключа (при удалении ключа).
function deleteRuntimeForKey(profileId: string, keyId: string): void {
  runtime.delete(keyRuntimeId(profileId, keyId));
}

// Бейджи UI (центр настроек): состояние каждого ключа — broken/billing/асlep+сек.
export interface KeyRuntimeView {
  broken: boolean;
  sleepSeconds: number;
  // МИКРО-БАТЧ 28.9: стена тарифа — отдельный бейдж («тариф»), сон не показывать.
  billing?: boolean;
}

export function runtimeSnapshot(profiles: KeychainProfile[] = readProfiles(), now = Date.now()): Record<string, KeyRuntimeView> {
  const snapshot: Record<string, KeyRuntimeView> = {};
  for (const profile of profiles) {
    for (const key of profile.keys) {
      const state = runtime.get(keyRuntimeId(profile.id, key.id));
      if (!state) continue;
      const sleepSeconds = Math.max(0, Math.ceil((state.sleepUntil - now) / 1000));
      if (state.broken || state.billingBlocked || sleepSeconds > 0) snapshot[keyRuntimeId(profile.id, key.id)] = { broken: state.broken, sleepSeconds, billing: state.billingBlocked };
    }
  }
  return snapshot;
}

// Жив ли хоть один enabled-ключ (не broken/billing/не спит) — «есть ли куда
// ротировать» без циклов сна. МИКРО-БАТЧ 28.9: решает немедленный стоп у
// стены тарифа.
export function hasAwakeKey(profiles: KeychainProfile[] = readProfiles(), now = Date.now()): boolean {
  return profiles.some((profile) => profile.keys.some((key) => key.enabled && !isKeyBroken(profile.id, key.id) && !isKeyBillingBlocked(profile.id, key.id) && !isKeyAsleep(profile.id, key.id, now)));
}

// Строки диагноза для баннера-списка (по одному ключу на строку группой по
// профилям). Возвращает сырые состояния; текст строки собирает хост через t().
export interface KeyDiagnosisEntry {
  profileId: string;
  profileLabel: string;
  keyId: string;
  keyLabel: string;
  state: 'billing' | 'broken' | 'asleep' | 'disabled' | 'awake';
  sleepSeconds: number;
}

export function diagnoseKeys(profiles: KeychainProfile[] = readProfiles(), now = Date.now()): KeyDiagnosisEntry[] {
  const out: KeyDiagnosisEntry[] = [];
  for (const profile of profiles) {
    for (const key of profile.keys) {
      const state = runtime.get(keyRuntimeId(profile.id, key.id));
      const sleepSeconds = Math.max(0, Math.ceil(((state?.sleepUntil ?? 0) - now) / 1000));
      let diagnosis: KeyDiagnosisEntry['state'] = 'awake';
      if (!key.enabled) diagnosis = 'disabled';
      else if (state?.billingBlocked) diagnosis = 'billing';
      else if (state?.broken) diagnosis = 'broken';
      else if (sleepSeconds > 0) diagnosis = 'asleep';
      out.push({ profileId: profile.id, profileLabel: profile.label, keyId: key.id, keyLabel: key.label, state: diagnosis, sleepSeconds });
    }
  }
  return out;
}

// ── решатель цепочки «ключи внутри профиля → следующий профиль» ─────────────

export interface FailoverOptions {
  autonomous: boolean;
  maxCycles: number;
}

export interface FailoverCurrent {
  profileId: string;
  keyId: string;
}

export type FailoverDecision =
  | { kind: 'none' }
  | { kind: 'switch'; profile: KeychainProfile; key: KeychainKey; fromLabel: string; sleepSeconds: number; cycle: number; profileChanged: boolean }
  | { kind: 'wait'; waitMs: number; wakeLabel: string; cycle: number }
  // МИКРО-БАТЧ 28.9: 'billingWall' — живых ключей нет, среди них есть
  // billing-блокированные: немедленный стоп со списком диагнозов, БЕЗ циклов сна.
  | { kind: 'stop'; reason: 'allSleep' | 'maxCycles' | 'noneLeft' | 'billingWall'; waitMs: number; wakeLabel: string };

export type FailoverTrigger = 'rate_limit' | 'quota' | 'billing';

export interface FailoverContext {
  profiles: KeychainProfile[];
  current: FailoverCurrent;
  allowWaitOnce: boolean;
  cycle: number;
}

function keyFullName(profile: KeychainProfile, key: KeychainKey): string {
  return `${profile.label}/${key.label}`;
}

// Живые кандидаты профиля: enabled, не broken, не billing-blocked, не asleep.
function awakeKeys(profile: KeychainProfile, currentKeyId: string | undefined, now: number): KeychainKey[] {
  return profile.keys.filter((key) => key.enabled && key.id !== currentKeyId && !isKeyBroken(profile.id, key.id) && !isKeyBillingBlocked(profile.id, key.id) && !isKeyAsleep(profile.id, key.id, now));
}

// Циклический решатель (батч 28): 429 на ключе → следующий enabled-ключ
// того же профиля по кругу; все ключи профиля спят → следующий профиль по
// порядку списка (стрелки UI), cycle++; никто не awake → пауза
// min(sleepUntil) − now (новый цикл); автономный выкл → stop с баннером;
// потолок maxCycles (>0) останавливает ротацию так же баннером.
// МИКРО-БАТЧ 28.9: trigger='billing' — ключ помечается billing-blocked
// (НЕ усыпляется), ротация идёт как обычно; живых нет и среди мёртвых есть
// blocked/сломанные → немедленный stop 'billingWall' без сна.
export function decideFailover(ctx: FailoverContext, options: FailoverOptions, waitSeconds: number | undefined, now: number, trigger: FailoverTrigger = 'rate_limit'): { decision: FailoverDecision; cycle: number; allowWaitOnce: boolean } {
  const billing = trigger === 'billing';
  const sleepSeconds = ctx.current.profileId ? (billing ? (markKeyBillingBlocked(ctx.current.profileId, ctx.current.keyId), 0) : markKeyRateLimited(ctx.current.profileId, ctx.current.keyId, now, waitSeconds)) : 0;
  const chain = ctx.profiles;
  const currentIndex = chain.findIndex((profile) => profile.id === ctx.current.profileId);
  const currentProfile = currentIndex >= 0 ? chain[currentIndex] : undefined;
  const currentKey = currentProfile?.keys.find((key) => key.id === ctx.current.keyId);
  const fromLabel = currentProfile ? keyFullName(currentProfile, currentKey ?? { id: ctx.current.keyId, label: ctx.current.keyId, secretId: '', enabled: true }) : ctx.current.profileId || '';
  let cycle = ctx.cycle;
  // 1) следующий enabled-ключ ТОГО ЖЕ профиля, циклически (без cycle++).
  if (currentProfile) {
    const enabled = currentProfile.keys.filter((key) => key.enabled);
    const keyIndex = enabled.findIndex((key) => key.id === ctx.current.keyId);
    for (let step = 1; step < enabled.length; step += 1) {
      const candidate = enabled[((keyIndex >= 0 ? keyIndex : 0) + step + enabled.length) % enabled.length];
      if (!candidate || candidate.id === ctx.current.keyId) continue;
      if (isKeyBroken(currentProfile.id, candidate.id) || isKeyBillingBlocked(currentProfile.id, candidate.id) || isKeyAsleep(currentProfile.id, candidate.id, now)) continue;
      return {
        decision: { kind: 'switch', profile: currentProfile, key: candidate, fromLabel, sleepSeconds, cycle, profileChanged: false },
        cycle,
        allowWaitOnce: ctx.allowWaitOnce
      };
    }
  }
  // 2) следующий профиль по порядку списка (циклически), cycle++ на переход.
  for (let step = 1; step <= chain.length; step += 1) {
    const candidate = chain[((currentIndex >= 0 ? currentIndex : 0) + step + chain.length) % chain.length];
    if (!candidate || candidate.id === ctx.current.profileId) continue;
    const key = awakeKeys(candidate, undefined, now)[0];
    if (!key) continue;
    if (options.maxCycles > 0 && cycle + 1 > options.maxCycles) {
      return { decision: { kind: 'stop', reason: 'maxCycles', waitMs: sleepWaitMs(chain, now), wakeLabel: wakeLabelFor(chain, now) }, cycle, allowWaitOnce: ctx.allowWaitOnce };
    }
    cycle += 1;
    return {
      decision: { kind: 'switch', profile: candidate, key, fromLabel, sleepSeconds, cycle, profileChanged: true },
      cycle,
      allowWaitOnce: ctx.allowWaitOnce
    };
  }
  // 28.9: стена тарифа — живой ключ никто не найдёт, а среди «мёртвых» есть
  // billing-блокированные (или сломанные): ждать бессмысленно, стоп сразу.
  const blockedCount = chain.reduce((total, profile) => total + profile.keys.filter((key) => key.enabled && (isKeyBillingBlocked(profile.id, key.id) || isKeyBroken(profile.id, key.id))).length, 0);
  if (billing || blockedCount > 0) {
    const sleepers = chain.flatMap((profile) => profile.keys.filter((key) => key.enabled && !isKeyBroken(profile.id, key.id) && !isKeyBillingBlocked(profile.id, key.id) && isKeyAsleep(profile.id, key.id, now)).map((key) => ({ profile, key })));
    if (sleepers.length === 0) {
      return { decision: { kind: 'stop', reason: 'noneLeft', waitMs: 0, wakeLabel: '' }, cycle, allowWaitOnce: ctx.allowWaitOnce };
    }
    return { decision: { kind: 'stop', reason: 'billingWall', waitMs: sleepWaitMs(chain, now), wakeLabel: wakeLabelFor(chain, now) }, cycle, allowWaitOnce: ctx.allowWaitOnce };
  }
  // 3) ни один ключ нигде не awake: пауза до ближайшего пробуждения.
  const sleepers = chain.flatMap((profile) => profile.keys.filter((key) => key.enabled && !isKeyBroken(profile.id, key.id) && isKeyAsleep(profile.id, key.id, now)).map((key) => ({ profile, key })));
  if (sleepers.length === 0) {
    return { decision: { kind: 'stop', reason: 'noneLeft', waitMs: 0, wakeLabel: '' }, cycle, allowWaitOnce: ctx.allowWaitOnce };
  }
  const wake = sleepers.reduce((earliest, entry) => Math.min(earliest, runtime.get(keyRuntimeId(entry.profile.id, entry.key.id))!.sleepUntil), Number.POSITIVE_INFINITY);
  const waitMs = Math.max(0, wake - now);
  const earliest = sleepers.sort((a, b) => runtime.get(keyRuntimeId(a.profile.id, a.key.id))!.sleepUntil - runtime.get(keyRuntimeId(b.profile.id, b.key.id))!.sleepUntil)[0];
  const wakeName = keyFullName(earliest.profile, earliest.key);
  if (options.autonomous) {
    if (options.maxCycles > 0 && cycle + 1 > options.maxCycles) {
      return { decision: { kind: 'stop', reason: 'maxCycles', waitMs, wakeLabel: wakeName }, cycle, allowWaitOnce: ctx.allowWaitOnce };
    }
    cycle += 1;
    return { decision: { kind: 'wait', waitMs, wakeLabel: wakeName, cycle }, cycle, allowWaitOnce: ctx.allowWaitOnce };
  }
  if (ctx.allowWaitOnce) {
    cycle += 1;
    return { decision: { kind: 'wait', waitMs, wakeLabel: wakeName, cycle }, cycle, allowWaitOnce: false };
  }
  return { decision: { kind: 'stop', reason: 'allSleep', waitMs, wakeLabel: wakeName }, cycle, allowWaitOnce: ctx.allowWaitOnce };
}

// Пауза/метка пробуждения для stop-веток (maxCycles на profile-switch).
function sleepWaitMs(chain: KeychainProfile[], now: number): number {
  let wake = Number.POSITIVE_INFINITY;
  for (const profile of chain) {
    for (const key of profile.keys) {
      if (!key.enabled || isKeyBroken(profile.id, key.id) || !isKeyAsleep(profile.id, key.id, now)) continue;
      wake = Math.min(wake, runtime.get(keyRuntimeId(profile.id, key.id))!.sleepUntil);
    }
  }
  return Number.isFinite(wake) ? Math.max(0, wake - now) : 0;
}

function wakeLabelFor(chain: KeychainProfile[], now: number): string {
  let best: { name: string; until: number } | undefined;
  for (const profile of chain) {
    for (const key of profile.keys) {
      if (!key.enabled || isKeyBroken(profile.id, key.id) || !isKeyAsleep(profile.id, key.id, now)) continue;
      const until = runtime.get(keyRuntimeId(profile.id, key.id))!.sleepUntil;
      if (!best || until < best.until) best = { name: keyFullName(profile, key), until };
    }
  }
  return best?.name ?? '';
}

// Обёртка решателя для хука llm-client: читает список из settings, обновляет
// цикл/текущую пару профиль+ключ скана. now — инъекция для детерминированных
// тестов.
export function runFailover(waitSeconds: number | undefined, options: FailoverOptions, now = Date.now(), trigger: FailoverTrigger = 'rate_limit'): FailoverDecision {
  const profiles = readProfiles();
  const result = decideFailover(
    { profiles, current: { profileId: scanRuntime.currentId, keyId: scanRuntime.currentKeyId }, allowWaitOnce: scanRuntime.allowWaitOnce, cycle: scanRuntime.cycle },
    options,
    waitSeconds,
    now,
    trigger
  );
  scanRuntime.cycle = result.cycle;
  scanRuntime.allowWaitOnce = result.allowWaitOnce;
  if (result.decision.kind === 'switch') {
    scanRuntime.currentId = result.decision.profile.id;
    scanRuntime.currentKeyId = result.decision.key.id;
  }
  return result.decision;
}

// Профиль для «одиночной» резолв-цепочки: активный, а если его нет —
// первый из списка (пустой список = legacy-путь, keychain не мешает).
export function activeProfile(profiles: KeychainProfile[] = readProfiles(), activeId = readActiveId()): KeychainProfile | undefined {
  if (profiles.length === 0) return undefined;
  return profiles.find((profile) => profile.id === activeId) ?? profiles[0];
}

export function profileLabel(id: string | undefined, profiles: KeychainProfile[] = readProfiles()): string {
  if (!id) return '';
  return profiles.find((profile) => profile.id === id)?.label ?? id;
}

export function keyLabelFor(profileId: string | undefined, keyId: string | undefined, profiles: KeychainProfile[] = readProfiles()): string {
  if (!profileId || !keyId) return '';
  return profiles.find((profile) => profile.id === profileId)?.keys.find((key) => key.id === keyId)?.label ?? keyId;
}

export function failoverEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('codescout');
  return config.get<boolean>('failover.enabled', false) === true;
}

export function failoverMaxCycles(): number {
  const config = vscode.workspace.getConfiguration('codescout');
  const n = Math.round(Number(config.get<number>('failover.maxCycles', 0)));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, n);
}
