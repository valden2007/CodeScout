// Батч 27 + 28: Keychain — профили = провайдер + НЕСКОЛЬКО ключей, циклический
// failover по ключам/профилям.
// Unit: CRUD профилей и ключей, миграции (одиночный ключ → «default» с keys[0];
// профили батча 27 без ключей → keys[0] + перенос секрета), решатель цепочки
// (ротация ключей внутри профиля, следующий профиль по стрелкам + cycle++,
// retry-after, лестница 120/300/600 НА КЛЮЧ, broken по 401 без автоперехода,
// disabled-ключи не дёргаются, пауза min(sleepUntil), maxCycles, автономный
// выкл). e2e: ручное переключение, retry-слой failover выкл/вкл, Output
// «🔑 failover: A/k1 → A/k2», баннер «Все ключи спят», пикер догона профилем,
// стрелки порядка, UI ключей в центре, i18n-контракт.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';
import {
  addKey,
  addProfile,
  beginScan,
  decideFailover,
  DEFAULT_KEY_ID,
  defaultKeyFor,
  FAILOVER_SLEEP_LADDER_SECONDS,
  isKeyAsleep,
  isKeyBroken,
  keyRuntimeId,
  keySecretId,
  markKeyBroken,
  markKeyRateLimited,
  migrateLegacyKeyToDefault,
  migrateProfilesToMultiKey,
  moveProfile,
  normalizeProfiles,
  ONBOARDED_PROFILE_ID,
  pickActiveKey,
  readActiveId,
  readKeySecret,
  readProfiles,
  removeKey,
  removeProfile,
  renameKey,
  renameProfile,
  resetRuntime,
  runFailover,
  runtime,
  scanCurrent,
  scanCurrentId,
  scanCycle,
  secretKeyForProfile,
  setKeyEnabled,
  setProfileBaseUrl,
  upsertOnboardedProfile,
  writeActiveId,
  writeProfiles,
  type KeychainKey,
  type KeychainProfile
} from '../extension/src/keychain';
import { pickResumeProfile } from '../extension/src/auditResume';
import { OpenAICompatibleProvider, AllProfilesAsleepError, type FailoverHooks } from '../src/llm-client';
import { clearModelsCache, fetchLiveModelsCached, resolveBaseUrl } from '../src/providers';
import { buildReportHtml } from '../extension/src/reportHtml';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { t } from '../src/i18n';

const REAL_FETCH = globalThis.fetch;
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';
const KEY_A2 = 'ZZKEYAA2_5555555555';
const KEY_OFF = 'ZZKEYOFF_0000000000';

function key(pid: string, kid: string, enabled = true): KeychainKey {
  return { id: kid, label: kid, secretId: keySecretId(pid, kid), enabled };
}

function profilesFixture(): KeychainProfile[] {
  return [
    { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'default')] },
    { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'default')] }
  ];
}

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers });
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

// Секрет-мок из vscode-stub (Map-backed) под интерфейс keychain.
function fakeSecrets(): import('../extension/src/keychain').SecretsLike {
  return (makeFakeContext() as { secrets: import('../extension/src/keychain').SecretsLike }).secrets;
}

async function waitFor(check: () => boolean, timeoutMs = 10000, stepMs = 20): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout; errors: ${state.errorMessages.slice(-3).join(' | ')}`);
    await flush();
  }
}

function seedTwoProfiles(): void {
  state.set('codescout.keychain', profilesFixture());
  state.set('codescout.keychain.active', 'a');
  state.secrets.set(keySecretId('a', 'default'), KEY_A);
  state.secrets.set(keySecretId('b', 'default'), KEY_B);
}

describe('батч 27+28 unit: CRUD профилей/ключей и миграции', () => {
  beforeEach(() => { state.reset(); resetRuntime(); });

  it('normalizeProfiles выбрасывает мусор, дубли id и неизвестных провайдеров; keys синтезируются', () => {
    const clean = normalizeProfiles([
      { id: 'a', label: 'Alpha', provider: 'groq', model: 'llama' },
      { id: 'a', label: 'dup', provider: 'groq' },
      { id: '', label: 'no-id', provider: 'groq' },
      { id: 'c', label: 'C', provider: 'not-a-provider' },
      { id: 'd', provider: 'openai' },
      null,
      'x'
    ]);
    expect(clean.map((p) => p.id)).toEqual(['a', 'd']);
    expect(clean[0].model).toBe('llama');
    expect(clean[0].keys).toEqual([defaultKeyFor('a')]); // legacy-запись → keys[0] «default»
    expect(clean[1].label).toBe('d'); // label по умолчанию = id
    expect(normalizeProfiles(undefined)).toEqual([]);
  });

  it('normalizeProfiles читает keys[], пересчитывает secretId, enabled=false сохраняем', () => {
    const clean = normalizeProfiles([
      {
        id: 'a', provider: 'groq',
        keys: [
          { id: 'main', label: 'основной', enabled: true },
          { id: 'test', enabled: false },
          { id: 'main', label: 'dup' },
          { id: '', label: 'no-id' },
          { id: 'x', secretId: 'keychain.evil.secret' }
        ]
      }
    ]);
    expect(clean[0].keys.map((k) => k.id)).toEqual(['main', 'test', 'x']);
    expect(clean[0].keys[0].label).toBe('основной');
    expect(clean[0].keys[1].enabled).toBe(false);
    expect(clean[0].keys[1].label).toBe('ключ-2'); // label по умолчанию
    // secretId ВСЕГДА пересчитан из (profileId, keyId) — чужой адрес игнорируется
    expect(clean[0].keys.map((k) => k.secretId)).toEqual(['keychain.a.main', 'keychain.a.test', 'keychain.a.x']);
  });

  it('addProfile создаёт keys[0]=default с секретом keychain.<id>.default; rename/delete работают', async () => {
    const secrets = fakeSecrets();
    const added = await addProfile(secrets, { label: 'Main Groq', provider: 'groq', key: KEY_A, model: 'llama-x' });
    expect(readProfiles().map((p) => p.id)).toEqual([added.id]);
    expect(state.secrets.get(keySecretId(added.id, DEFAULT_KEY_ID))).toBe(KEY_A);
    expect(readActiveId()).toBe(added.id);
    const second = await addProfile(secrets, { label: 'Main Groq', provider: 'openai', key: KEY_B });
    expect(second.id).not.toBe(added.id); // дубль label → новый уникальный id
    expect(readActiveId()).toBe(added.id); // второй НЕ перетягивает актив
    await renameProfile(added.id, 'Renamed');
    expect(readProfiles().find((p) => p.id === added.id)?.label).toBe('Renamed');
    await removeProfile(secrets, second.id);
    expect(readProfiles().map((p) => p.id)).toEqual([added.id]);
    expect(state.secrets.get(keySecretId(second.id, DEFAULT_KEY_ID))).toBeUndefined();
  });

  it('удаление активного профиля без выбора нового — refused (без молчаливого фолбэка)', async () => {
    const secrets = fakeSecrets();
    await writeProfiles(profilesFixture());
    await writeActiveId('a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    const refused = await removeProfile(secrets, 'a');
    expect(refused.ok).toBe(false);
    expect(readProfiles()).toHaveLength(2);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    const done = await removeProfile(secrets, 'a', 'b');
    expect(done.ok).toBe(true);
    expect(readActiveId()).toBe('b');
    expect(state.secrets.get(keySecretId('a', 'default'))).toBeUndefined();
  });

  it('миграция одиночного ключа → профиль default с keys[0]: старый ключ продолжает работать', async () => {
    const context = makeFakeContext() as never;
    state.secrets.set('codescout.apiKey', KEY_A);
    state.secrets.set('codescout.provider', 'groq');
    state.secrets.set('codescout.model', 'llama-old');
    const migrated = await migrateLegacyKeyToDefault(context);
    expect(migrated).toBe(true);
    expect(readProfiles()).toEqual([{ id: 'default', label: 'default', provider: 'groq', model: 'llama-old', keys: [defaultKeyFor('default')] }]);
    expect(readActiveId()).toBe('default');
    expect(state.secrets.get(keySecretId('default', 'default'))).toBe(KEY_A);
    // старый секрет НЕ удалён — откат и legacy-путь целы
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_A);
    // повторный activate — однократно
    expect(await migrateLegacyKeyToDefault(context)).toBe(false);
    expect(readProfiles()).toHaveLength(1);
  });

  it('миграция не трогает, если профили уже заведены (ручной CRUD важнее)', async () => {
    const context = makeFakeContext() as never;
    state.secrets.set('codescout.apiKey', KEY_A);
    await writeProfiles([{ id: 'work', label: 'Work', provider: 'openai', keys: [defaultKeyFor('work')] }]);
    expect(await migrateLegacyKeyToDefault(context)).toBe(false);
    expect(readProfiles().map((p) => p.id)).toEqual(['work']);
    expect(state.secrets.get(keySecretId('work', 'default'))).toBeUndefined();
  });

  it('батч 28: migrateProfilesToMultiKey переносит keychain.<id> → keys[0].default и ставит флаг', async () => {
    const context = makeFakeContext() as never;
    // установка после апгрейда: профили батча 27 (без keys), секреты на старых адресах
    state.set('codescout.keychain', [
      { id: 'a', label: 'Alpha', provider: 'groq' },
      { id: 'b', label: 'Beta', provider: 'openai', model: 'gpt-x' }
    ]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(secretKeyForProfile('a'), KEY_A);
    const migrated = await migrateProfilesToMultiKey(context);
    expect(migrated).toBe(true);
    const profiles = readProfiles();
    expect(profiles.map((p) => p.keys.map((k) => k.secretId))).toEqual([['keychain.a.default'], ['keychain.b.default']]);
    expect(profiles[0].keys[0].label).toBe('default');
    expect(profiles[0].keys[0].enabled).toBe(true);
    // секрет переехал, старый адрес очищен (без дублей)
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    expect(state.secrets.get(secretKeyForProfile('a'))).toBeUndefined();
    // b без секрета — ключ пустой, структура целая
    expect(state.secrets.get(keySecretId('b', 'default'))).toBeUndefined();
    // повторный activate — no-op (флаг однократности)
    expect(await migrateProfilesToMultiKey(context)).toBe(false);
    expect(readProfiles().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('батч 28: readKeySecret берёт keychain.<pid>.<kid>, legacy-fallback для немигрированного default', async () => {
    const secrets = fakeSecrets();
    state.set('codescout.keychain', [{ id: 'a', label: 'Alpha', provider: 'groq' }]); // legacy-форма
    const profile = readProfiles()[0];
    // миграция ещё не бегла: секрет на старом адресе → fallback срабатывает
    state.secrets.set(secretKeyForProfile('a'), KEY_A);
    expect(await readKeySecret(secrets, profile, profile.keys[0])).toBe(KEY_A);
    // после переезда на новый адрес — читается новый
    state.secrets.delete(secretKeyForProfile('a'));
    state.secrets.set(keySecretId('a', 'default'), KEY_A2);
    expect(await readKeySecret(secrets, profile, profile.keys[0])).toBe(KEY_A2);
    // НЕ-default ключ legacy-fallback НЕ имеет
    const extra = key('a', 'alt');
    expect(await readKeySecret(secrets, profile, extra)).toBeUndefined();
  });

  it('батч 28: CRUD ключей — addKey вставкой, renameKey, toggle, removeKey; последний ключ не удаляется', async () => {
    const secrets = fakeSecrets();
    const added = await addProfile(secrets, { label: 'Groq main', provider: 'groq', key: KEY_A });
    const withKey = await addKey(secrets, added.id, { label: 'test-key', key: KEY_A2 });
    expect(withKey?.keys.map((k) => k.label)).toEqual(['default', 'test-key']);
    expect(withKey?.keys[1].id).toBe('test-key'); // slug от label
    expect(withKey!.keys[1].secretId).toBe(keySecretId(added.id, withKey!.keys[1].id));
    expect(state.secrets.get(withKey!.keys[1].secretId)).toBe(KEY_A2); // секрет вставлен по адресу ключа
    await renameKey(added.id, withKey!.keys[1].id, 'Renamed key');
    expect(readProfiles()[0].keys[1].label).toBe('Renamed key');
    await setKeyEnabled(added.id, withKey!.keys[1].id, false);
    expect(readProfiles()[0].keys[1].enabled).toBe(false);
    const removed = await removeKey(secrets, added.id, withKey!.keys[1].id);
    expect(removed.ok).toBe(true);
    expect(readProfiles()[0].keys).toHaveLength(1);
    const last = await removeKey(secrets, added.id, DEFAULT_KEY_ID);
    expect(last.ok).toBe(false);
    expect(last.reason).toBe('lastKey');
    expect(readProfiles()[0].keys).toHaveLength(1);
  });

  it('батч 28: pickActiveKey — первый enabled не-broken; disabled и broken обходятся', () => {
    const profile: KeychainProfile = { id: 'a', label: 'A', provider: 'groq', keys: [key('a', 'off', false), key('a', 'brk'), key('a', 'good')] };
    markKeyBroken('a', 'brk');
    expect(pickActiveKey(profile)?.id).toBe('good');
    const onlyBroken: KeychainProfile = { id: 'b', label: 'B', provider: 'groq', keys: [key('b', 'x')] };
    markKeyBroken('b', 'x');
    expect(pickActiveKey(onlyBroken)?.id).toBe('x'); // честный 401-путь: broken всё равно единственный
    const noEnabled: KeychainProfile = { id: 'c', label: 'C', provider: 'groq', keys: [key('c', 'x', false)] };
    expect(pickActiveKey(noEnabled)).toBeUndefined();
  });

  it('батч 28: moveProfile меняет порядок списка (стрелки); на границах — без движения', async () => {
    await writeProfiles(profilesFixture());
    const after = await moveProfile('b', -1);
    expect(after?.map((p) => p.id)).toEqual(['b', 'a']);
    const top = await moveProfile('b', -1);
    expect(top?.map((p) => p.id)).toEqual(['b', 'a']);
    const back = await moveProfile('b', 1);
    expect(back?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(await moveProfile('ghost', 1)).toBeUndefined();
  });
});

describe('батч 28 unit: решатель цепочки «ключи → профили»', () => {
  const NOW = 1_000_000;
  const AUTO = { autonomous: true, maxCycles: 0 };
  const twoProfiles = profilesFixture();
  const ctx = (overrides: Partial<Parameters<typeof decideFailover>[0]> = {}) => ({ profiles: twoProfiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0, ...overrides });

  beforeEach(() => { resetRuntime(); });

  it('429 на k1 → следующий enabled-ключ ТОГО ЖЕ профиля (без cycle++)', () => {
    const profiles: KeychainProfile[] = [{ id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k1'), key('a', 'k2')] }];
    const res = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k1' }, allowWaitOnce: false, cycle: 0 }, AUTO, 300, NOW);
    expect(res.decision.kind).toBe('switch');
    if (res.decision.kind === 'switch') {
      expect(res.decision.profile.id).toBe('a');
      expect(res.decision.key.id).toBe('k2');
      expect(res.decision.profileChanged).toBe(false);
      expect(res.decision.cycle).toBe(0);
      expect(res.decision.fromLabel).toBe('Alpha/k1');
      expect(res.decision.sleepSeconds).toBe(300);
    }
    expect(runtime.get(keyRuntimeId('a', 'k1'))!.sleepUntil).toBe(NOW + 300_000);
  });

  it('ключи внутри профиля циклически: спящий k1 пропускаем; когда проснулся — возврат к нему (без cycle++)', () => {
    const profiles: KeychainProfile[] = [{ id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k1'), key('a', 'k2')] }];
    runtime.set(keyRuntimeId('a', 'k1'), { sleepUntil: NOW + 100, ladderStep: 0, broken: false });
    // k2 текущий: k1 ещё спит (100мс) → переключения нет
    const asleep = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k2' }, allowWaitOnce: false, cycle: 0 }, AUTO, 60, NOW);
    expect(asleep.decision.kind).not.toBe('switch');
    // время прошло — квота k1 освежилась: циклический возврат на k1
    const late = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k2' }, allowWaitOnce: false, cycle: 0 }, AUTO, 60, NOW + 200);
    if (late.decision.kind !== 'switch') throw new Error('late switch expected');
    expect(late.decision.key.id).toBe('k1');
    expect(late.decision.profileChanged).toBe(false);
    expect(late.decision.cycle).toBe(0);
  });

  it('все enabled-ключи профиля спят → следующий профиль по порядку, cycle++', () => {
    const profiles: KeychainProfile[] = [
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k1'), key('a', 'k2')] },
      { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'k1')] }
    ];
    runtime.set(keyRuntimeId('a', 'k1'), { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set(keyRuntimeId('a', 'k2'), { sleepUntil: NOW + 4000, ladderStep: 0, broken: false });
    const res = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k1' }, allowWaitOnce: false, cycle: 0 }, AUTO, 600, NOW);
    expect(res.decision.kind).toBe('switch');
    if (res.decision.kind === 'switch') {
      expect(res.decision.profile.id).toBe('b');
      expect(res.decision.key.id).toBe('k1');
      expect(res.decision.profileChanged).toBe(true);
      expect(res.decision.cycle).toBe(1);
    }
    expect(res.cycle).toBe(1);
  });

  it('disabled-ключ никогда не предлагается (ни внутри профиля, ни в следующем)', () => {
    const profiles: KeychainProfile[] = [
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k1'), key('a', 'off', false)] },
      { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'off', false)] }
    ];
    const res = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k1' }, allowWaitOnce: false, cycle: 0 }, AUTO, 120, NOW);
    // k1 (текущий) заснул, остальные enabled-ключей нет → switch невозможен, только wait
    expect(res.decision.kind).not.toBe('switch');
    if (res.decision.kind === 'wait') expect(res.decision.wakeLabel).toBe('Alpha/k1');
  });

  it('429 с retry-after → A/default засыпает точно, следующий awake = B (профиль, cycle++)', () => {
    const res = decideFailover(ctx(), AUTO, 300, NOW);
    expect(res.decision.kind).toBe('switch');
    if (res.decision.kind === 'switch') {
      expect(res.decision.profile.id).toBe('b');
      expect(res.decision.key.id).toBe('default');
      expect(res.decision.fromLabel).toBe('Alpha/default');
      expect(res.decision.sleepSeconds).toBe(300);
    }
    expect(runtime.get(keyRuntimeId('a', 'default'))!.sleepUntil).toBe(NOW + 300_000);
    expect(isKeyAsleep('a', 'default', NOW + 299_999)).toBe(true);
    expect(isKeyAsleep('a', 'default', NOW + 300_000)).toBe(false);
  });

  it('429 без retry-after — лестница 120/300/600 НА КЛЮЧ', () => {
    expect(markKeyRateLimited('a', 'default', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[0]);
    expect(markKeyRateLimited('a', 'default', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[1]);
    expect(markKeyRateLimited('a', 'default', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[2]);
    expect(markKeyRateLimited('a', 'default', NOW, undefined)).toBe(600); // плато
    // лестница другого ключа независима
    expect(markKeyRateLimited('a', 'k2', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[0]);
  });

  it('401 → broken на ключе, НЕ asleep; broken вне ротации и циклы по нему не ходят', () => {
    markKeyBroken('b', 'default');
    expect(isKeyBroken('b', 'default')).toBe(true);
    expect(isKeyAsleep('b', 'default', NOW)).toBe(false);
    expect(runtime.get(keyRuntimeId('b', 'default'))!.sleepUntil).toBe(0);
    const res = decideFailover(ctx(), AUTO, 30, NOW);
    expect(res.decision.kind === 'switch' && res.decision.profile.id === 'b').toBe(false);
    if (res.decision.kind === 'wait') {
      expect(res.decision.wakeLabel).toBe('Alpha/default');
    }
  });

  it('все спят везде → пауза = min(sleepUntil) − now, wakeLabel профиль/ключ, cycle на паузе', () => {
    runtime.set(keyRuntimeId('a', 'default'), { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set(keyRuntimeId('b', 'default'), { sleepUntil: NOW + 2000, ladderStep: 0, broken: false });
    const res = decideFailover(ctx(), AUTO, 9000, NOW);
    expect(res.decision.kind).toBe('wait');
    if (res.decision.kind === 'wait') {
      expect(res.decision.waitMs).toBeLessThanOrEqual(2000);
      expect(res.decision.wakeLabel).toBe('Beta/default');
      expect(res.decision.cycle).toBe(1);
    }
    expect(res.cycle).toBe(1);
    const second = decideFailover({ ...ctx(), cycle: 1 }, AUTO, 9000, NOW);
    expect(second.decision.kind).toBe('wait');
    expect(second.cycle).toBe(2);
  });

  it('цикличность профилей: после конца списка возврат к A, чья квота освежилась', () => {
    runtime.set(keyRuntimeId('a', 'default'), { sleepUntil: NOW + 1000, ladderStep: 0, broken: false });
    const whileAsleep = decideFailover({ profiles: [...twoProfiles].reverse(), current: { profileId: 'b', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, AUTO, 300, NOW);
    expect(whileAsleep.decision.kind === 'switch' && (whileAsleep.decision.profile.id === 'a')).toBe(false);
    const later = decideFailover({ profiles: [...twoProfiles].reverse(), current: { profileId: 'b', keyId: 'default' }, allowWaitOnce: false, cycle: 1 }, AUTO, 300, NOW + 2000);
    expect(later.decision.kind).toBe('switch');
    if (later.decision.kind === 'switch') expect(later.decision.profile.id).toBe('a');
  });

  it('стрелки решают: следующий профиль = по порядку списка (после moveProfile — другой)', () => {
    const profiles: KeychainProfile[] = [
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k')] },
      { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'k')] },
      { id: 'c', label: 'Gamma', provider: 'openai', keys: [key('c', 'k')] }
    ];
    const first = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k' }, allowWaitOnce: false, cycle: 0 }, AUTO, 60, NOW);
    if (first.decision.kind !== 'switch') throw new Error('switch expected');
    expect(first.decision.profile.id).toBe('b');
    const reordered = profiles.slice();
    reordered.splice(0, 1); reordered.push(profiles[0]); // a в конец: порядок [b, c, a]
    const second = decideFailover({ profiles: reordered, current: { profileId: 'b', keyId: 'k' }, allowWaitOnce: false, cycle: 0 }, AUTO, 60, NOW);
    if (second.decision.kind !== 'switch') throw new Error('switch expected 2');
    expect(second.decision.profile.id).toBe('c'); // сосед по стрелкам, а не прежний b→a
  });

  it('автономный ВЫКЛ: все спят → stop (баннер «все ключи спят»); «подождать» даёт ровно одну паузу', () => {
    runtime.set(keyRuntimeId('a', 'default'), { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set(keyRuntimeId('b', 'default'), { sleepUntil: NOW + 4000, ladderStep: 0, broken: false });
    const off = { autonomous: false, maxCycles: 0 };
    const res = decideFailover(ctx(), off, 9000, NOW);
    expect(res.decision).toMatchObject({ kind: 'stop', reason: 'allSleep' });
    const granted = decideFailover({ ...ctx(), allowWaitOnce: true }, off, 9000, NOW);
    expect(granted.decision.kind).toBe('wait');
    expect(granted.allowWaitOnce).toBe(false);
    const again = decideFailover({ ...ctx(), allowWaitOnce: false }, off, 9000, NOW);
    expect(again.decision.kind).toBe('stop');
  });

  it('maxCycles=2: стоп на переходе за потолок (wait и profile-switch)', () => {
    runtime.set(keyRuntimeId('a', 'default'), { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set(keyRuntimeId('b', 'default'), { sleepUntil: NOW + 4000, ladderStep: 0, broken: false });
    const maxed = { autonomous: true, maxCycles: 2 };
    expect(decideFailover(ctx(), maxed, 9000, NOW).decision.kind).toBe('wait');
    const second = decideFailover({ ...ctx(), cycle: 1 }, maxed, 9000, NOW);
    expect(second.decision.kind).toBe('wait');
    expect(second.cycle).toBe(2);
    const third = decideFailover({ ...ctx(), cycle: 2 }, maxed, 9000, NOW);
    expect(third.decision).toMatchObject({ kind: 'stop', reason: 'maxCycles' });
    // profile-switch тоже упирается в потолок
    const switchMaxed = decideFailover({ profiles: twoProfiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 2 }, { autonomous: true, maxCycles: 2 }, 60, NOW + 400_000);
    expect(switchMaxed.decision).toMatchObject({ kind: 'stop', reason: 'maxCycles' });
  });

  it('runFailover — состояние скана: switch двигает профиль+ключ и цикл, wait двигает cycle', () => {
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    expect(scanCurrent()).toEqual({ profileId: 'a', keyId: 'default' });
    const first = runFailover(300, { autonomous: true, maxCycles: 0 }, NOW);
    expect(first.kind).toBe('switch');
    expect(scanCycle()).toBe(1); // профиль сменился → cycle++
    expect(scanCurrent()).toEqual({ profileId: 'b', keyId: 'default' });
    expect(scanCurrentId()).toBe('b');
    runtime.set(keyRuntimeId('b', 'default'), { sleepUntil: NOW + 300_000, ladderStep: 1, broken: false });
    const second = runFailover(300, { autonomous: true, maxCycles: 0 }, NOW);
    expect(second.kind).toBe('wait'); // a и b спят
    expect(scanCycle()).toBe(2);
  });
});

describe('батч 27 e2e: ручное переключение профилей', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('switchKeyProfile: QuickPick → модалка подтверждения → persist активного; legacy-секреты не тронуты', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push({ profileId: 'b' });
    state.warningAnswers.push(t('keychain.switchConfirmBtn', 'ru'));
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === 'b');
    expect(state.secrets.get('codescout.apiKey')).toBeUndefined();
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    expect(state.quickPickCalls.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('switchKeyProfile: отмена модалки — актив НЕ меняется', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push({ profileId: 'b' });
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await flush();
    expect(readActiveId()).toBe('a');
  }, 30000);

  it('кэш моделей изолирован между профилями: список профиля B не берётся из кэша A', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    let modelCalls = 0;
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string | URL | undefined, init?: { headers?: Record<string, string> }) => {
      modelCalls += 1;
      hosts.push(String((init?.headers ?? {}).Authorization ?? ''));
      const auth = String((init?.headers ?? {}).Authorization ?? '');
      const id = auth.includes(KEY_A) ? 'model-of-a' : 'model-of-b';
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    }) as typeof fetch;
    const listA = await fetchLiveModelsCached(resolveBaseUrl('groq'), KEY_A, fetch, 1000, 'groq', () => {}, true);
    const listA2 = await fetchLiveModelsCached(resolveBaseUrl('groq'), KEY_A, fetch, 1000, 'groq', () => {}, true);
    expect(listA).toEqual(['model-of-a']);
    expect(listA2).toEqual(['model-of-a']);
    expect(modelCalls).toBe(1);
    state.quickPickAnswers.push({ profileId: 'b' });
    state.warningAnswers.push(t('keychain.switchConfirmBtn', 'ru'));
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === 'b');
    const listB = await fetchLiveModelsCached(resolveBaseUrl('openai'), KEY_B, fetch, 1000, 'openai', () => {}, true);
    expect(listB).toEqual(['model-of-b']);
    expect(modelCalls).toBeGreaterThanOrEqual(2);
    expect(hosts.some((h) => h.includes(KEY_B))).toBe(true);
  }, 30000);
});

describe('батч 27+28 retry-слой: failover выключен / включён', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; vi.useRealTimers(); });

  it('failover.enabled=false: 429 → старое поведение лестницы, ноль переключений', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    seedTwoProfiles();
    const seen: string[] = [];
    const sleeps: number[] = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(String(init?.headers?.Authorization ?? ''));
      return rateLimited();
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(KEY_A, 'm1', fetcher, async (ms: number) => {
      sleeps.push(ms);
      await vi.advanceTimersByTimeAsync(ms);
    }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, undefined);
    await expect(provider.review('s', 'u')).rejects.toBeTruthy();
    expect(seen.every((auth) => auth.includes(KEY_A))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(4); // первая попытка + 3 ступени лестницы
    expect(sleeps).toEqual([30000, 60000, 120000]);
    // failover-состояние не двигалось: ни сна, ни switch по keychain
    expect(runtime.get(keyRuntimeId('a', 'default'))?.sleepUntil ?? 0).toBe(0);
    expect(runtime.get(keyRuntimeId('b', 'default'))?.sleepUntil ?? 0).toBe(0);
  }, 60000);

  it('failover.enabled=true (e2e через reviewFiles): 429 на A → переход на B; A.sleepUntil из retry-after', async () => {
    const startedAt = Date.now();
    seedTwoProfiles();
    state.set('codescout.failover.enabled', true);
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      if (auth.includes(KEY_A)) return rateLimited('1');
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(result.skippedFiles).toBe(0);
    expect(seen[0]).toContain(KEY_A);
    expect(seen[seen.length - 1]).toContain(KEY_B);
    expect(runtime.get(keyRuntimeId('a', 'default'))!.sleepUntil).toBeGreaterThanOrEqual(startedAt + 1000);
  }, 60000);

  it('батч 28: 429 на ключе1 → ключ2 ТОГО ЖЕ профиля; Output «🔑 failover: A/k1 → A/k2 … цикл»', async () => {
    seedTwoProfiles();
    const profiles = profilesFixture();
    profiles[0].keys = [key('a', 'k1'), key('a', 'k2')];
    state.set('codescout.keychain', profiles);
    state.secrets.set(keySecretId('a', 'k1'), KEY_A);
    state.secrets.set(keySecretId('a', 'k2'), KEY_A2);
    state.set('codescout.failover.enabled', true);
    activate(makeFakeContext() as never); // hostOutput для keychainLog
    await flush();
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      if (auth.includes(KEY_A)) return rateLimited('1');
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(seen[0]).toContain(KEY_A);
    expect(seen[seen.length - 1]).toContain(KEY_A2); // тот же профиль, другой ключ
    expect(state.outputLines.some((line) => line.includes('🔑 failover: Alpha/k1 → Alpha/k2'))).toBe(true);
    expect(scanCurrent()).toEqual({ profileId: 'a', keyId: 'k2' });
    expect(scanCycle()).toBe(0); // ключ внутри профиля — цикл НЕ вырастает
  }, 60000);

  it('батч 28: disabled-ключ не дёргается — мок-счётчик ноль запросов с его секретом', async () => {
    const profiles: KeychainProfile[] = [
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'k1'), key('a', 'off', false)] }
    ];
    state.set('codescout.keychain', profiles);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'k1'), KEY_A);
    state.secrets.set(keySecretId('a', 'off'), KEY_OFF);
    state.set('codescout.failover.enabled', true);
    vi.useFakeTimers({ now: 5_000_000 });
    const seen: string[] = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      return rateLimited('600');
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(KEY_A, 'm', fetcher, async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, undefined);
    beginScan('a', 'k1');
    // прогон с реальными хуками не нужен: решатель при disabled k2 никогда не вернёт его
    const decision = decideFailover({ profiles, current: { profileId: 'a', keyId: 'k1' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, 600, Date.now());
    expect(decision.decision.kind).toBe('wait');
    if (decision.decision.kind === 'wait') expect(decision.decision.wakeLabel).toBe('Alpha/k1');
    // и старт скана берёт enabled-ключ, не disabled
    expect(pickActiveKey(profiles[0])?.id).toBe('k1');
    await expect(provider.review('s', 'u')).rejects.toBeTruthy();
    expect(seen.every((auth) => !auth.includes(KEY_OFF))).toBe(true);
  }, 60000);

  it('failover включен: B тоже 429 → пауза min(sleepUntil) → цикл 2 возвращается к A (fake timers)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    const seen: Array<{ auth: string; at: number }> = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      const now = Date.now();
      seen.push({ auth, at: now });
      // A отдаёт 429 с ra=300 до истечения сна; после 300с квота освежилась
      if (auth.includes(KEY_A)) return now >= 1_000_000 + 300_000 ? okContent() : rateLimited('300');
      return rateLimited('100');
    }) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: true, maxCycles: 0 });
        if (decision.kind === 'switch') {
          const key = decision.profile.id === 'a' ? KEY_A : KEY_B;
          return { action: 'switch', apiKey: key, baseUrl: resolveBaseUrl(decision.profile.provider), model: 'm' } as const;
        }
        if (decision.kind === 'wait') return { action: 'wait', waitMs: decision.waitMs } as const;
        if (decision.kind === 'stop') return { action: 'stop', waitMs: decision.waitMs, wakeLabel: decision.wakeLabel } as const;
        return undefined;
      },
      async onAuthError() { /* нет auth-сценария здесь */ }
    };
    const provider = new OpenAICompatibleProvider(
      KEY_A, 'm1', fetcher,
      async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); },
      undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks
    );
    const content = await provider.review('s', 'u');
    expect(JSON.parse(content).issues).toEqual([]);
    expect(seen[0].auth).toContain(KEY_A);
    expect(seen.some((entry) => entry.auth.includes(KEY_B))).toBe(true);
    // после конца цепочки — возврат к A, чья квота освежилась: финальный запрос на A
    expect(seen[seen.length - 1].auth).toContain(KEY_A);
    expect(scanCycle()).toBeGreaterThanOrEqual(1);
    expect(runtime.get(keyRuntimeId('a', 'default'))!.sleepUntil).toBe(1_000_000 + 300_000); // из retry-after
  }, 60000);

  it('401 на ключе → broken, не asleep; автопереход по 401 запрещён', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    const calls: string[] = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      calls.push(auth);
      if (auth.includes(KEY_A)) return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
      return okContent();
    }) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: true, maxCycles: 0 });
        if (decision.kind === 'switch') return { action: 'switch', apiKey: KEY_B, baseUrl: 'https://api.openai.com/v1', model: 'm' } as const;
        return undefined;
      },
      async onAuthError() { const cur = scanCurrent(); markKeyBroken(cur.profileId, cur.keyId); }
    };
    const provider = new OpenAICompatibleProvider(KEY_A, 'm', fetcher, async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    await expect(provider.review('s', 'u')).rejects.toBeTruthy();
    expect(isKeyBroken('a', 'default')).toBe(true);
    expect(isKeyAsleep('a', 'default', Date.now())).toBe(false);
    // автопереход по 401 запрещён: ни одного запроса с ключом B
    expect(calls.every((auth) => auth.includes(KEY_A))).toBe(true);
    // broken-ключ больше не предлагается в цепочке
    const next = decideFailover({ profiles: readProfiles(), current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, 60, Date.now());
    expect(next.decision.kind === 'switch' && next.decision.profile.id === 'a').toBe(false);
  }, 60000);

  it('AllProfilesAsleepError при stop-решении (автономный выкл, все спят)', async () => {
    vi.useFakeTimers({ now: 3_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    // B уже спит глубже: единственный круг спящих → stop без ожидания
    runtime.set(keyRuntimeId('b', 'default'), { sleepUntil: 3_000_000 + 1_200_000, ladderStep: 0, broken: false });
    const fetcher = (async () => rateLimited('600')) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: false, maxCycles: 0 });
        if (decision.kind === 'wait') return { action: 'wait', waitMs: decision.waitMs } as const;
        if (decision.kind === 'stop') return { action: 'stop', waitMs: decision.waitMs, wakeLabel: decision.wakeLabel } as const;
        return undefined;
      },
      async onAuthError() {}
    };
    const provider = new OpenAICompatibleProvider(KEY_A, 'm', fetcher, async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    await expect(provider.review('s', 'u')).rejects.toBeInstanceOf(AllProfilesAsleepError);
  }, 60000);
});

describe('батч 27+28 e2e: баннер «Все ключи спят»', () => {
  const stats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };

  it('RU и EN: две кнопки «Подождать и продолжить» / «Стоп», EN без кириллицы', () => {
    const sleep = { wakeSeconds: 42, wakeLabel: 'Beta/k1' };
    const base = [stats, false, true, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const ru = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, sleep);
    expect(ru).toContain('Все ключи спят');
    expect(ru).toContain('Beta/k1 через 42с');
    expect(ru).toContain('data-command="failoverWaitResume"');
    expect(ru).toContain('Подождать и продолжить');
    expect(ru).toContain('data-command="failoverDismiss"');
    expect(ru).toContain('Стоп');
    const en = buildReportHtml([], ...base, 'en', {}, '', undefined, undefined, sleep);
    expect(en).toContain('All keys are asleep');
    expect(en).toContain('data-command="failoverWaitResume"');
    expect(en).toContain('Wait and continue');
    expect(en).toContain('data-command="failoverDismiss"');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('баннер скрыт во время скана (приоритет у живого скана)', () => {
    const base = [stats, true, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const html = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, { wakeSeconds: 10, wakeLabel: 'B' });
    expect(html).not.toContain('failoverWaitResume');
  });
});

describe('батч 27+28 e2e: пикер догона показывает профили и не меняет активный', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('pickResumeProfile: список provider · label · model; берёт рабочий ключ; выбор НЕ пишет keychain.active', async () => {
    seedTwoProfiles();
    state.quickPickAnswers.push({ profileId: 'b', label: 'openai · Beta', description: 'gpt-x' });
    const target = await pickResumeProfile({
      lang: 'ru',
      profiles: readProfiles(),
      resolveKeyForProfile: async (profile) => (profile.id === 'b' ? { key: KEY_B, keyId: 'default', keyLabel: 'default' } : { key: KEY_A, keyId: 'default', keyLabel: 'default' }),
      resolveBaseUrlFor: async (provider) => resolveBaseUrl(provider),
      log: () => {}
    });
    expect(target).toBeDefined();
    expect(target!.label).toBe('Beta');
    expect(target!.key).toBe(KEY_B);
    expect(target!.keyId).toBe('default');
    // разовый маршрут: активный профиль настроек не тронут
    expect(readActiveId()).toBe('a');
    expect(state.secrets.get('codescout.provider')).toBeUndefined();
    const items = state.quickPickCalls[0][0] as Array<{ label: string }>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.label)).toEqual(['groq · Alpha', 'openai · Beta']);
  });

  it('pickResumeProfile: ни одного enabled-ключа = undefined + ошибка «ключ не найден»', async () => {
    const profiles: KeychainProfile[] = [{ id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'default', false)] }];
    state.quickPickAnswers.push({ profileId: 'b', label: 'openai · Beta', description: '' });
    const target = await pickResumeProfile({
      lang: 'ru',
      profiles,
      resolveKeyForProfile: async () => undefined,
      resolveBaseUrlFor: async (provider) => resolveBaseUrl(provider),
      log: () => {}
    });
    expect(target).toBeUndefined();
    expect(state.errorMessages.join('\n')).toContain('Beta');
  });

  it('pickResumeProfile: baseUrl профиля уходит вторым аргументом в resolveBaseUrlFor (батч 27.1)', async () => {
    await writeProfiles([
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [defaultKeyFor('a')] },
      { id: 'b', label: 'Beta', provider: 'groq', baseUrl: 'https://relay.example/v1', keys: [defaultKeyFor('b')] }
    ]);
    await writeActiveId('a');
    state.quickPickAnswers.push({ profileId: 'b', label: 'groq · Beta', description: '' });
    const seen: Array<[string, string | undefined]> = [];
    const target = await pickResumeProfile({
      lang: 'ru',
      profiles: readProfiles(),
      resolveKeyForProfile: async () => ({ key: KEY_B, keyId: 'default', keyLabel: 'default' }),
      resolveBaseUrlFor: async (provider, profileBaseUrl) => { seen.push([provider, profileBaseUrl]); return resolveBaseUrl(provider, '', profileBaseUrl); },
      log: () => {}
    });
    expect(target?.baseUrl).toBe('https://relay.example/v1');
    expect(seen).toEqual([['groq', 'https://relay.example/v1']]);
  });
});

describe('батч 27+28 i18n-контракт', () => {
  it('все keychain.*-ключи есть в обоих словарях; EN без кириллицы', () => {
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
    const keychainKeys = Object.keys(ru).filter((key) => key.startsWith('keychain.'));
    expect(keychainKeys.length).toBeGreaterThanOrEqual(50);
    for (const key of keychainKeys) {
      expect(typeof en[key]).toBe('string');
      expect(en[key]).not.toMatch(/[\u0400-\u04FF]/);
      expect(ru[key].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ru).filter((k) => k.startsWith('keychain.')).sort()).toEqual(Object.keys(en).filter((k) => k.startsWith('keychain.')).sort());
  });

  it('настройки батча 27 в манифесте + nls (EN без кириллицы, RU с русским)', () => {
    const manifest = readFileSync('extension/package.json', 'utf8');
    const props = JSON.parse(manifest).contributes.configuration.properties;
    expect(props['codescout.keychain']).toMatchObject({ type: 'array' });
    expect(props['codescout.keychain.active']).toMatchObject({ type: 'string', default: '' });
    expect(props['codescout.failover.enabled']).toMatchObject({ type: 'boolean', default: false });
    expect(props['codescout.failover.maxCycles']).toMatchObject({ type: 'number', default: 0, minimum: 0, maximum: 100 });
    const nlsEn = JSON.parse(readFileSync('extension/package.nls.json', 'utf8')) as Record<string, string>;
    const nlsRu = JSON.parse(readFileSync('extension/package.nls.ru.json', 'utf8')) as Record<string, string>;
    for (const key of ['keychain.description', 'keychainActive.description', 'failoverEnabled.description', 'failoverMaxCycles.description']) {
      expect(nlsEn[key]).toBeDefined();
      expect(nlsEn[key]).not.toMatch(/[\u0400-\u04FF]/);
      expect(nlsRu[key]).toMatch(/[\u0400-\u04FF]/);
    }
    expect(manifest).toContain('codescout.switchKeyProfile');
  });
});

// ── Батч 27.1 ────────────────────────────────────────────────────────────────

describe('батч 27.1 unit: per-profile baseUrl', () => {
  beforeEach(() => { state.reset(); resetRuntime(); });

  it('normalizeProfiles: хвостовой / срезается; битый/пустой baseUrl — поле теряется, профиль цел', () => {
    const clean = normalizeProfiles([
      { id: 'a', provider: 'groq', baseUrl: 'https://relay.example/v1/' },
      { id: 'b', provider: 'groq', baseUrl: 'http://evil.example/v1' },
      { id: 'c', provider: 'groq', baseUrl: '   ' },
      { id: 'd', provider: 'groq', baseUrl: 42 }
    ]);
    expect(clean).toHaveLength(4);
    expect(clean[0].baseUrl).toBe('https://relay.example/v1');
    expect(clean[1].baseUrl).toBeUndefined(); // http вне localhost запрещён
    expect(clean[2].baseUrl).toBeUndefined();
    expect(clean[3].baseUrl).toBeUndefined();
  });

  it('setProfileBaseUrl: запись → сброс; битый URL и чужой id — отказ без изменения списка', async () => {
    await writeProfiles([{ id: 'a', label: 'A', provider: 'groq', keys: [defaultKeyFor('a')] }]);
    const set = await setProfileBaseUrl('a', 'https://relay.example/v1');
    expect(set?.baseUrl).toBe('https://relay.example/v1');
    expect(readProfiles()[0].baseUrl).toBe('https://relay.example/v1');
    expect(readProfiles()[0].keys).toHaveLength(1); // keys целы
    expect(await setProfileBaseUrl('a', 'ftp://nope')).toBeUndefined();
    expect(readProfiles()[0].baseUrl).toBe('https://relay.example/v1');
    expect(await setProfileBaseUrl('ghost', 'https://x.test')).toBeUndefined();
    const cleared = await setProfileBaseUrl('a', '   ');
    expect(cleared?.baseUrl).toBeUndefined();
    expect('baseUrl' in readProfiles()[0]).toBe(false);
  });

  it('resolveBaseUrl приоритет: profile.baseUrl > codescout.baseUrl (только custom/local) > PROVIDERS', () => {
    expect(resolveBaseUrl('groq', 'https://wrong.test', 'https://relay.example/v1')).toBe('https://relay.example/v1');
    expect(resolveBaseUrl('groq', 'http://localhost:11434/v1', 'https://relay.example/v1')).toBe('https://relay.example/v1');
    expect(resolveBaseUrl('groq', 'https://wrong.test')).toBe('https://api.groq.com/openai/v1');
    expect(resolveBaseUrl('groq', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(resolveBaseUrl('custom', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(() => resolveBaseUrl('groq', undefined, 'ftp://bad')).toThrow();
  });

  it('центр настроек: Override Base URL + список ключей с кнопками; EN без кириллицы', () => {
    const profiles: KeychainProfile[] = [
      { id: 'a', label: 'Alpha', provider: 'groq', baseUrl: 'https://relay.example/v1', keys: [{ id: 'k1', label: 'main', secretId: keySecretId('a', 'k1'), enabled: true }, { id: 'k2', label: 'alt', secretId: keySecretId('a', 'k2'), enabled: false }] },
      { id: 'b', label: 'Beta', provider: 'openai', keys: [defaultKeyFor('b')] }
    ];
    const base: SettingsState = {
      keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
      reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
      maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
      auditScope: '', auditPasses: 1, version: 'test', uiTheme: 'auto', accentColor: 'auto',
      uiDensity: 'standard', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity',
      reportTheme: 'auto', customColors: '{}', keychainProfiles: profiles, keychainActiveId: 'a',
      keychainRuntime: { 'a/k1': { broken: false, sleepSeconds: 300 }, 'b/default': { broken: true, sleepSeconds: 0 } }
    };
    const ru = buildSettingsHtml(base, '', 'ok', 'nonce', '', undefined, 'ru');
    expect(ru).toContain('data-kc="keychainBaseUrl"');
    expect(ru).toContain('value="https://relay.example/v1"');
    expect(ru).toContain('Override Base URL');
    // батч 28: ключи, индикаторы, бейджи и кнопки
    expect(ru).toContain('data-kc="keychainAddKey"');
    expect(ru).toContain('data-kc="keychainToggleKey"');
    expect(ru).toContain('data-kc="keychainRenameKey"');
    expect(ru).toContain('data-kc="keychainDeleteKey"');
    expect(ru).toContain('data-kc="keychainMove"');
    expect(ru).toContain('data-keyid="k2"');
    expect(ru).toContain('main');
    expect(ru).toContain('выключен');
    expect(ru).toContain('спит 300с');
    expect(ru).toContain('сломан (401/403)');
    expect(ru).toContain('Добавить ключ');
    expect(ru).toContain('Оставьте пустым, чтобы использовать базовый URL провайдера');
    const en = buildSettingsHtml(base, '', 'ok', 'nonce', '', undefined, 'en');
    expect(en).toContain("Leave empty to use the provider's base URL");
    expect(en).toContain('asleep 300s');
    expect(en).toContain('broken (401/403)');
    expect(en).toContain('disabled');
    expect(en).toContain('Add key');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });
});

describe('батч 27.1 e2e: failover с baseUrl-приоритетом', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('глобальный codescout.baseUrl=wrong.test: A→B уходит на СВОЙ PROVIDERS.baseUrl B, wrong.test не трогает', async () => {
    seedTwoProfiles();
    state.set('codescout.failover.enabled', true);
    state.set('codescout.baseUrl', 'https://wrong.test');
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      urls.push(String(url));
      if (auth.includes(KEY_A)) return rateLimited('1');
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(urls.some((u) => u.startsWith('https://api.groq.com/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://api.openai.com/'))).toBe(true);
    expect(urls.every((u) => !u.includes('wrong.test'))).toBe(true);
  }, 60000);

  it('профиль B со своим baseUrl: switch на relay профиля — глобальный оверрайд не побеждает', async () => {
    state.set('codescout.keychain', [
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [defaultKeyFor('a')] },
      { id: 'b', label: 'Beta', provider: 'openai', baseUrl: 'https://relay.example/v1', keys: [defaultKeyFor('b')] }
    ]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    state.set('codescout.failover.enabled', true);
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      urls.push(String(url));
      if (auth.includes(KEY_A)) return rateLimited('1');
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(urls.some((u) => u === 'https://relay.example/v1/chat/completions')).toBe(true);
    expect(urls.every((u) => !u.includes('api.openai.com'))).toBe(true);
  }, 60000);
});

describe('батч 27.1 e2e: онбординг пишет в keychain-профиль «onboarded»', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('пустой keychain: onboardCloud создаёт профиль + legacy заполняется; повторный онбординг legacy НЕ трогает', async () => {
    activate(makeFakeContext() as never);
    await flush();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'm-live' }] }), { status: 200 })) as typeof fetch;
    state.quickPickAnswers.push('Groq');
    state.inputBoxAnswers.push('ZZTESTKEY_1234567890');
    await (state.commands.get('codescout.onboardCloud') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === ONBOARDED_PROFILE_ID);
    expect(readProfiles().map((p) => p.id)).toEqual([ONBOARDED_PROFILE_ID]);
    expect(state.secrets.get(keySecretId(ONBOARDED_PROFILE_ID, DEFAULT_KEY_ID))).toBe('ZZTESTKEY_1234567890');
    expect(state.secrets.get('codescout.apiKey')).toBe('ZZTESTKEY_1234567890'); // пустой keychain → legacy тоже пишется
    state.secrets.set('codescout.apiKey', 'LEGACY_LOCKED');
    state.quickPickAnswers.push('OpenAI');
    state.inputBoxAnswers.push('ZZSECONDKEY_0987654321');
    await (state.commands.get('codescout.onboardCloud') as () => Promise<unknown>)();
    await waitFor(() => state.secrets.get(keySecretId(ONBOARDED_PROFILE_ID, DEFAULT_KEY_ID)) === 'ZZSECONDKEY_0987654321');
    expect(state.secrets.get('codescout.apiKey')).toBe('LEGACY_LOCKED');
    expect(readProfiles()).toHaveLength(1);
    expect(readProfiles()[0].provider).toBe('openai');
  }, 30000);

  it('onboardLocal при непустом keychain: профиль onboarded(custom + baseUrl пробы), settings/legacy не тронуты', async () => {
    state.set('codescout.keychain', [{ id: 'only', label: 'Only', provider: 'groq', keys: [defaultKeyFor('only')] }]);
    state.set('codescout.keychain.active', 'only');
    activate(makeFakeContext() as never);
    await flush();
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local-m' }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    state.quickPickAnswers.push('Ollama');
    state.inputBoxAnswers.push('http://localhost:11434');
    await (state.commands.get('codescout.onboardLocal') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === ONBOARDED_PROFILE_ID);
    const onboarded = readProfiles().find((p) => p.id === ONBOARDED_PROFILE_ID);
    expect(onboarded?.provider).toBe('custom');
    expect(onboarded?.baseUrl).toBe('http://localhost:11434/v1');
    expect(onboarded?.model).toBe('local-m');
    expect(state.config.get('codescout.provider')).toBeUndefined();
    expect(state.config.get('codescout.baseUrl')).toBeUndefined();
    expect(state.secrets.get('codescout.model')).toBeUndefined();
    expect(await readKeySecret(fakeSecrets(), onboarded!, onboarded!.keys[0])).toBeUndefined(); // key: '' → пусто
  }, 30000);
});
