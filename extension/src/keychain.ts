// Батч 27: Keychain — профили ключей и циклический failover.
// Здесь живёт ВСЯ логика профилей: CRUD несекретного списка в settings
// (codescout.keychain), секретов на профиль (keychain.<id> в SecretStorage),
// миграция одиночного ключа в профиль «default», sleep-метки и решатель
// цепочки: следующий awake-профиль, пауза до ближайшего пробуждения,
// «broken» по 401/403. extension.ts — только тонкая проводка UI/команд.
// Решатель чистый (now и профили приходят аргументами) — тестируется без
// таймеров и без сети; мутация runtime — в методах KeychainRuntime.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { normalizeProvider, type ProviderName } from '../../src/providers';

export interface KeychainProfile {
  id: string;
  label: string;
  provider: ProviderName;
  model?: string;
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
// Профиль «default» — обязательный id для миграции старого одиночного ключа.
export const DEFAULT_PROFILE_ID = 'default';
// Профиль без retry-after засыпает по этой лестнице (секунды), шаг
// растёт с каждым новым 429 на этом профиле (как RATE_LIMIT_PAUSE_LADDER
// в батче 22, но на профиль, а не на файл).
export const FAILOVER_SLEEP_LADDER_SECONDS = [120, 300, 600];
const MAX_PROFILES = 20;

function validProvider(value: unknown): ProviderName | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  try {
    return normalizeProvider(raw);
  } catch {
    return undefined;
  }
}

// Нормализация списка из settings: мусор/дубли id выкидываем, id/label
// обязательны, provider — только известный, model опционален.
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
    out.push({ id, label, provider, ...(model ? { model } : {}) });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
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

export function secretKeyForProfile(id: string): string {
  return `${KEYCHAIN_SECRET_PREFIX}${id}`;
}

export async function readProfileSecret(secrets: SecretsLike, id: string): Promise<string | undefined> {
  return await secrets.get(secretKeyForProfile(id));
}

export async function storeProfileSecret(secrets: SecretsLike, id: string, key: string): Promise<void> {
  await secrets.store(secretKeyForProfile(id), key);
}

export async function deleteProfileSecret(secrets: SecretsLike, id: string): Promise<void> {
  await secrets.delete(secretKeyForProfile(id));
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

// Добавить профиль: секрет кладём ОТДЕЛЬНОЙ записью keychain.<id>;
// первый добавленный профиль становится активным, если активного нет.
export async function addProfile(secrets: SecretsLike, input: { label: string; provider: ProviderName; model?: string; key: string }): Promise<KeychainProfile> {
  const profiles = readProfiles();
  const label = input.label.trim() || input.provider;
  const id = makeProfileId(label, profiles);
  const profile: KeychainProfile = { id, label, provider: input.provider, ...(input.model?.trim() ? { model: input.model.trim() } : {}) };
  await storeProfileSecret(secrets, id, input.key.trim());
  await writeProfiles([...profiles, profile]);
  if (!readActiveId() || !profiles.some((p) => p.id === readActiveId())) await writeActiveId(id);
  return profile;
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
  runtime.delete(id);
  if (rest.length === 0) await writeActiveId('');
  return { ok: true, profiles: rest, activeId: rest.length ? readActiveId() : '' };
}

// Миграция текущего одиночного ключа → профиль «default» БЕЗ потери:
// старый секрет остаётся на месте (откат безопасен), профиль получает свою
// копию. Флаг в SecretStorage — миграция однократная; пустой список профилей
// после миграции = пользователь удалил их сам, навязывать default не надо.
export async function migrateLegacyKeyToDefault(context: vscode.ExtensionContext): Promise<boolean> {
  const legacyKey = (await context.secrets.get('codescout.apiKey'))?.trim();
  if (!legacyKey) return false;
  if ((await context.secrets.get(KEYCHAIN_MIGRATED_FLAG)) === 'true') return false;
  if (readProfiles().length > 0) {
    await context.secrets.store(KEYCHAIN_MIGRATED_FLAG, 'true');
    return false;
  }
  const provider = validProvider((await context.secrets.get('codescout.provider'))?.trim()) ?? validProvider(vscode.workspace.getConfiguration('codescout').get<string>('provider')) ?? 'gemini';
  const model = (await context.secrets.get('codescout.model'))?.trim() || undefined;
  const profile: KeychainProfile = { id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_ID, provider, ...(model ? { model } : {}) };
  await storeProfileSecret(context.secrets, DEFAULT_PROFILE_ID, legacyKey);
  await writeProfiles([profile]);
  await writeActiveId(DEFAULT_PROFILE_ID);
  await context.secrets.store(KEYCHAIN_MIGRATED_FLAG, 'true');
  return true;
}

// ── runtime: сон/сломанность профилей + циклы ротации ──────────────────────

export interface ProfileRuntime {
  sleepUntil: number;
  ladderStep: number;
  broken: boolean;
}

// Единый runtime процесса: переживает отдельные сканы (sleepUntil
// актуальна до протухания), сбрасывается тестами через resetRuntime.
export const runtime = new Map<string, ProfileRuntime>();

export function resetRuntime(): void {
  runtime.clear();
  scanRuntime = { cycle: 0, allowWaitOnce: false, currentId: '' };
}

// Состояние ротации ТЕКУЩЕГО скана: номер цикла, разовое разрешение
// «подождать» (кнопка баннера) и id профиля, которым скан идёт сейчас
// (обновляется при switch — его читает чекпоинт для метки файла).
interface ScanRuntime {
  cycle: number;
  allowWaitOnce: boolean;
  currentId: string;
}

let scanRuntime: ScanRuntime = { cycle: 0, allowWaitOnce: false, currentId: '' };

export function beginScan(currentId: string): void {
  // allowWaitOnce НЕ сбрасываем: «Подождать и продолжить» нажимается между
  // сканами (grant → рестарт),consume — в decideFailover при использовании.
  scanRuntime = { cycle: 0, allowWaitOnce: scanRuntime.allowWaitOnce, currentId };
}

export function scanCurrentId(): string {
  return scanRuntime.currentId;
}

export function scanCycle(): number {
  return scanRuntime.cycle;
}

// «Подождать и продолжить» из баннера: один раз разрешить паузу до
// пробуждения даже при выключенном автономном режиме.
export function grantWaitOnce(): void {
  scanRuntime.allowWaitOnce = true;
}

function stateOf(id: string): ProfileRuntime {
  let state = runtime.get(id);
  if (!state) {
    state = { sleepUntil: 0, ladderStep: 0, broken: false };
    runtime.set(id, state);
  }
  return state;
}

export function isAsleep(id: string, now: number): boolean {
  return (runtime.get(id)?.sleepUntil ?? 0) > now;
}

export function isBroken(id: string): boolean {
  return runtime.get(id)?.broken === true;
}

// 429 без retry-after — лестница 120/300/600 на профиль (шаг растёт).
export function markRateLimited(id: string, now: number, waitSeconds: number | undefined): number {
  const state = stateOf(id);
  const seconds = waitSeconds !== undefined && waitSeconds > 0
    ? Math.ceil(waitSeconds)
    : FAILOVER_SLEEP_LADDER_SECONDS[Math.min(state.ladderStep, FAILOVER_SLEEP_LADDER_SECONDS.length - 1)];
  if (waitSeconds === undefined || waitSeconds <= 0) state.ladderStep += 1;
  state.sleepUntil = now + seconds * 1000;
  return seconds;
}

// 401/403 — broken (НЕ asleep): профиль выводится из цепочки, автопереход
// по auth-ошибке запрещён, квотный «сон» не ставится.
export function markBroken(id: string): void {
  stateOf(id).broken = true;
}

export function clearBroken(id: string): void {
  const state = runtime.get(id);
  if (state) state.broken = false;
}

// Успешный файл на профиле — сбрасываем лестницу (квота живая).
export function markHealthy(id: string): void {
  const state = runtime.get(id);
  if (state) state.ladderStep = 0;
}

export interface FailoverOptions {
  autonomous: boolean;
  maxCycles: number;
}

export type FailoverDecision =
  | { kind: 'none' }
  | { kind: 'switch'; profile: KeychainProfile; fromLabel: string; sleepSeconds: number; cycle: number }
  | { kind: 'wait'; waitMs: number; wakeLabel: string; cycle: number }
  | { kind: 'stop'; reason: 'allSleep' | 'maxCycles' | 'noneLeft'; waitMs: number; wakeLabel: string };

export interface FailoverContext {
  profiles: KeychainProfile[];
  currentId: string;
  allowWaitOnce: boolean;
  cycle: number;
}

// Циклический решатель: после конца списка возвращаемся к началу — к
// профилям, чья квота освежилась (sleepUntil < now). Никто не awake →
// пауза = min(sleepUntil) − now (новый цикл), автономный выкл → stop с
// баннером; потолок maxCycles (>0) останавливает ротацию так же баннером.
export function decideFailover(ctx: FailoverContext, options: FailoverOptions, waitSeconds: number | undefined, now: number): { decision: FailoverDecision; cycle: number; allowWaitOnce: boolean } {
  const sleepSeconds = ctx.currentId ? markRateLimited(ctx.currentId, now, waitSeconds) : 0;
  const chain = ctx.profiles;
  const currentIndex = chain.findIndex((profile) => profile.id === ctx.currentId);
  let cycle = ctx.cycle;
  for (let step = 1; step <= chain.length; step += 1) {
    const candidate = chain[(currentIndex + step + chain.length) % chain.length];
    if (!candidate || candidate.id === ctx.currentId) continue;
    if (isBroken(candidate.id)) continue;
    if (isAsleep(candidate.id, now)) continue;
    return {
      decision: { kind: 'switch', profile: candidate, fromLabel: chain[currentIndex]?.label ?? ctx.currentId, sleepSeconds, cycle: cycle + 1 },
      cycle,
      allowWaitOnce: ctx.allowWaitOnce
    };
  }
  // Ни один сосед не awake: считаем паузу до ближайшего пробуждения.
  const sleepers = chain.filter((profile) => !isBroken(profile.id) && isAsleep(profile.id, now));
  if (sleepers.length === 0) {
    return { decision: { kind: 'stop', reason: 'noneLeft', waitMs: 0, wakeLabel: '' }, cycle, allowWaitOnce: ctx.allowWaitOnce };
  }
  const wake = sleepers.reduce((earliest, profile) => Math.min(earliest, runtime.get(profile.id)!.sleepUntil), Number.POSITIVE_INFINITY);
  const waitMs = Math.max(0, wake - now);
  const wakeLabel = sleepers.sort((a, b) => runtime.get(a.id)!.sleepUntil - runtime.get(b.id)!.sleepUntil)[0].label;
  if (options.autonomous) {
    if (options.maxCycles > 0 && cycle + 1 > options.maxCycles) {
      return { decision: { kind: 'stop', reason: 'maxCycles', waitMs, wakeLabel }, cycle, allowWaitOnce: ctx.allowWaitOnce };
    }
    cycle += 1;
    return { decision: { kind: 'wait', waitMs, wakeLabel, cycle }, cycle, allowWaitOnce: ctx.allowWaitOnce };
  }
  if (ctx.allowWaitOnce) {
    cycle += 1;
    return { decision: { kind: 'wait', waitMs, wakeLabel, cycle }, cycle, allowWaitOnce: false };
  }
  return { decision: { kind: 'stop', reason: 'allSleep', waitMs, wakeLabel }, cycle, allowWaitOnce: ctx.allowWaitOnce };
}

// Обёртка решателя для хука llm-client: читает список из settings, обновляет
// цикл/текущий профиль скана. now — инъекция для детерминированных тестов.
export function runFailover(waitSeconds: number | undefined, options: FailoverOptions, now = Date.now()): FailoverDecision {
  const profiles = readProfiles();
  const result = decideFailover(
    { profiles, currentId: scanRuntime.currentId, allowWaitOnce: scanRuntime.allowWaitOnce, cycle: scanRuntime.cycle },
    options,
    waitSeconds,
    now
  );
  scanRuntime.cycle = result.cycle;
  scanRuntime.allowWaitOnce = result.allowWaitOnce;
  if (result.decision.kind === 'switch') scanRuntime.currentId = result.decision.profile.id;
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
