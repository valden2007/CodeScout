// Микро-батч 28.10, задача 1: opt-out из кейчейна — «выключено = удалено для фолбэка».
// Условие legacy-фолбэка: ноль профилей ИЛИ ноль включённых ключей. Выключил
// все ключи → центр показывает рабочую legacy-карточку (провайдер + ключ +
// «сейчас»), аудит/модели/догон идут через неё, ошибки ведут в поле центра.
// Включил любой ключ → кейчейн снова источник, legacy засыпает. Переход в обе
// стороны БЕЗ потери секретов. Матрица: (все выключены / один включён /
// вернули обратно) × (save, models, resume) в обе стороны.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';
import { disableAllKeys, enableAllKeys, hasEnabledKey, keySecretId, readProfiles, resetRuntime, type KeychainProfile } from '../extension/src/keychain';
import { clearModelsCache, maskApiKey } from '../src/providers';

const REAL_FETCH = globalThis.fetch;
const KEY_LEGACY = 'ZZLEGACY_1111111111';
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';
const KEY_NEW = 'gsk_NEWKEY_1234567890';

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

function profile(id: string, label: string, provider: string, kid = 'default', enabled = true): KeychainProfile {
  return { id, label, provider, keys: [{ id: kid, label: kid, secretId: keySecretId(id, kid), enabled }] } as KeychainProfile;
}

// Два профиля с секретами + рабочий legacy-ключ: единственная конфигурация,
// в которой проверяются ОБА источника сразу.
function twoProfilesWithLegacy(): void {
  state.set('codescout.keychain', [profile('a', 'Alpha', 'groq'), profile('b', 'Beta', 'openai')]);
  state.set('codescout.keychain.active', 'a');
  state.secrets.set(keySecretId('a', 'default'), KEY_A);
  state.secrets.set(keySecretId('b', 'default'), KEY_B);
  state.secrets.set('codescout.apiKey', KEY_LEGACY);
  state.secrets.set('codescout.provider', 'groq');
  state.set('codescout.failover.enabled', false);
}

function setKeysEnabled(enabled: boolean): void {
  state.set('codescout.keychain', readProfiles().map((p) => ({ ...p, keys: p.keys.map((k) => ({ ...k, enabled })) })));
}

function captureFetch(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push(String(init?.headers?.Authorization ?? ''));
    return okContent();
  }) as unknown as typeof fetch;
  return seen;
}

async function openCenter(): Promise<{ send: (message: Record<string, unknown>) => void; html: () => string }> {
  activate(makeFakeContext() as never);
  await flush();
  await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
  await flush();
  const panel = state.panels[state.panels.length - 1];
  return { send: (message) => { void panel.webview.onMessageHandlers[0](message as never); }, html: () => panel.webview.html };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

describe('28.10 решатель: включённый ключ = источник, ноль включённых = legacy', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });

  it('hasEnabledKey: true при enabled-ключе, false при всех выключенных, пустой список = false', () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    expect(hasEnabledKey()).toBe(true);
    setKeysEnabled(false);
    expect(hasEnabledKey()).toBe(false);
    state.set('codescout.keychain', []);
    expect(hasEnabledKey()).toBe(false);
  });

  it('disableAllKeys/enableAllKeys: только enabled флаги, секреты не трогаются', async () => {
    twoProfilesWithLegacy();
    const off = await disableAllKeys();
    expect(off.disabled).toBe(2);
    expect(readProfiles().every((p) => p.keys.every((k) => !k.enabled))).toBe(true);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    expect(state.secrets.get(keySecretId('b', 'default'))).toBe(KEY_B);
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_LEGACY);
    const on = await enableAllKeys();
    expect(on.enabled).toBe(2);
    expect(readProfiles().every((p) => p.keys.every((k) => k.enabled))).toBe(true);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
  });
});

describe('28.10 матрица «все выключены / один включён / вернули обратно» × аудит', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('ключей кейчейна в сети нет, когда все выключены: аудит идёт legacy-ключом', async () => {
    twoProfilesWithLegacy();
    setKeysEnabled(false);
    const seen = captureFetch();
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(seen[0]).toContain(KEY_LEGACY);
    expect(seen.every((auth) => !auth.includes(KEY_A) && !auth.includes(KEY_B))).toBe(true);
  });

  it('включили один ключ профиля → кейчейн снова источник (legacy в сеть не уходит)', async () => {
    twoProfilesWithLegacy();
    setKeysEnabled(false);
    setKeysEnabled(true);
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq'), profile('b', 'Beta', 'openai', 'default', false)]);
    const seen = captureFetch();
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(seen[0]).toContain(KEY_A);
    expect(seen.every((auth) => !auth.includes(KEY_LEGACY))).toBe(true);
  });

  it('обратный переход: включили → выключили всё → аудит снова legacy-ключом', async () => {
    twoProfilesWithLegacy();
    const seen = captureFetch();
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(seen[0]).toContain(KEY_A);
    setKeysEnabled(false);
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    const legacyOnly = seen.filter((auth) => auth.includes(KEY_LEGACY));
    expect(legacyOnly.length).toBeGreaterThan(0);
    expect(seen.filter((auth) => auth.includes(KEY_A) || auth.includes(KEY_B)).length).toBe(1);
  });

  it('простой режим без legacy-ключа → «в поле центра», а не «в профиле»', async () => {
    twoProfilesWithLegacy();
    state.secrets.delete('codescout.apiKey');
    setKeysEnabled(false);
    globalThis.fetch = (async () => okContent()) as unknown as typeof fetch;
    await expect(reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {})).rejects.toThrow(/поле «API-ключ» центра/);
    await expect(reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {})).rejects.not.toThrow(/в профиле/);
  });

  it('failover в простом режиме не строит хуки: 402 не поднимает BillingWallError и не метит ключ', async () => {
    twoProfilesWithLegacy();
    state.set('codescout.failover.enabled', true);
    setKeysEnabled(false);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'insufficient_credits: top up your billing' } }), { status: 402, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {}, undefined, undefined, undefined, undefined, true, undefined, undefined, undefined, 1, undefined, 0, undefined, async () => {}, 'ru', 0);
    // legacy-путь: обычный скип файла без keychain-стопов (хуков нет, меток нет)
    expect(result.skippedFiles).toBe(1);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
  });
});

describe('28.10 save × матрица', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  const saveAll = (apiKey: string) => ({ command: 'saveAll', apiKey, providerKey: 'auto', baseUrl: '', reportLanguage: 'ru', showAuditBanner: true, linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'compact', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity', reportTheme: 'auto', customColors: '{}', failoverEnabled: false, failoverMaxCycles: 0 });

  it('все выключены: saveAll пишет в legacy-слот (поле центра), «сейчас» без профиля, секреты профилей целы', async () => {
    twoProfilesWithLegacy();
    setKeysEnabled(false);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send(saveAll(KEY_NEW));
    await settle();
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_NEW);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    expect(state.secrets.get(keySecretId('b', 'default'))).toBe(KEY_B);
    const html = center.html();
    expect(html).toContain(maskApiKey(KEY_NEW));
    expect(html).not.toContain('профиль «Alpha»');
    expect(html).toContain('keychainToggleAllKeys');
    expect(html).toContain('Включить все ключи');
  });

  it('один включён: saveAll пишет в рабочий ключ профиля, legacy не тронут', async () => {
    twoProfilesWithLegacy();
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq'), profile('b', 'Beta', 'openai', 'default', false)]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send(saveAll(KEY_NEW));
    await settle();
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_NEW);
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_LEGACY);
    expect(center.html()).toContain('профиль «Alpha»');
  });

  it('кнопка-подсказка в обе стороны: keychainDisableAllKeys → keychainEnableAllKeys, секреты не теряются', async () => {
    twoProfilesWithLegacy();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.html(); // первая перерисовка
    center.send({ command: 'keychainDisableAllKeys' });
    await settle();
    expect(readProfiles().every((p) => p.keys.every((k) => !k.enabled))).toBe(true);
    expect(center.html()).toContain('keychainEnableAllKeys');
    expect(center.html()).toContain('Простой режим');
    center.send({ command: 'keychainEnableAllKeys' });
    await settle();
    expect(readProfiles().every((p) => p.keys.every((k) => k.enabled))).toBe(true);
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
    expect(state.secrets.get(keySecretId('b', 'default'))).toBe(KEY_B);
  });
});

describe('28.10 models/resume × матрица', () => {
  let root = '';
  beforeEach(() => {
    state.reset(); resetRuntime(); clearModelsCache();
    root = mkdtempSync(join(tmpdir(), 'cs-2810-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n', 'utf8');
    state.workspaceRoot = root;
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; if (root) rmSync(root, { recursive: true, force: true }); });

  function captureModels(): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)}|${String(init?.headers?.Authorization ?? '')}`);
      return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('выключили всё → «Живые модели…» идут legacy-ключом; включили → ключом профиля', async () => {
    twoProfilesWithLegacy();
    setKeysEnabled(false);
    const seen = captureModels();
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push('llama-3.3-70b-versatile');
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();
    const simpleCall = seen.find((line) => line.includes('/models'));
    expect(simpleCall).toBeDefined();
    expect(simpleCall).toContain(KEY_LEGACY);
    expect(simpleCall).not.toContain(KEY_A);
    setKeysEnabled(true);
    state.quickPickAnswers.push('llama-3.3-70b-versatile');
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();
    const profileCall = seen.filter((line) => line.includes('/models')).at(-1);
    expect(profileCall).toContain(KEY_A);
  });

  it('догон «Продолжить другими…» при всех выключенных: legacy-пикер провайдер→модель, аудит legacy-ключом', async () => {
    twoProfilesWithLegacy();
    setKeysEnabled(false);
    mkdirSync(join(root, '.codescout'));
    writeFileSync(join(root, '.codescout', 'audit-progress.json'), JSON.stringify({ startedAt: Date.now(), model: 'm', provider: 'groq', state: 'cancelled', checked: [], remaining: ['src/a.ts'] }), 'utf8');
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)}|${String(init?.headers?.Authorization ?? '')}`);
      return String(url).includes('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : okContent();
    }) as unknown as typeof fetch;
    activate(makeFakeContext() as never);
    await flush();
    // Первый QuickPick — провайдер (не список профилей), дальше — модель.
    state.quickPickAnswers.push('groq', 'llama-3.3-70b-versatile');
    await (state.commands.get('codescout.resumeAuditOther') as () => Promise<unknown>)();
    await flush();
    for (let i = 0; i < 200 && seen.length === 0; i += 1) await flush();
    expect(seen.some((line) => line.includes(KEY_LEGACY))).toBe(true);
    expect(seen.every((line) => !line.includes(KEY_A) && !line.includes(KEY_B))).toBe(true);
  });

  it('вернули ключ → догон снова идёт профилем (список профилей в пикере)', async () => {
    twoProfilesWithLegacy();
    mkdirSync(join(root, '.codescout'));
    writeFileSync(join(root, '.codescout', 'audit-progress.json'), JSON.stringify({ startedAt: Date.now(), model: 'm', provider: 'groq', state: 'cancelled', checked: [], remaining: ['src/a.ts'] }), 'utf8');
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(String(init?.headers?.Authorization ?? ''));
      return okContent();
    }) as unknown as typeof fetch;
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push({ label: 'groq · Alpha', description: 'm', profileId: 'a' });
    await (state.commands.get('codescout.resumeAuditOther') as () => Promise<unknown>)();
    await flush();
    for (let i = 0; i < 200 && seen.length === 0; i += 1) await flush();
    expect(seen.some((auth) => auth.includes(KEY_A))).toBe(true);
    expect(seen.every((auth) => !auth.includes(KEY_LEGACY))).toBe(true);
  });
});
