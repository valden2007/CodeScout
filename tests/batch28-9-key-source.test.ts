// Микро-батч 28.9, задача 1: единый источник ключа.
// Кейчейн — единственный источник ключа для аудита/ревью/моделей; legacy-слот
// codescout.apiKey — только миграция и фолбэк при НУЛЕ профилей.
// Матрица состояний (только legacy / профили / профили + legacy-рассинхрон /
// failover off) × (save, models, resume): ключ находится, источники не
// смешиваются, «сейчас» = активный профиль.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';
import { keySecretId, pickActiveKey, resetRuntime } from '../extension/src/keychain';
import { clearModelsCache, maskApiKey } from '../src/providers';

const REAL_FETCH = globalThis.fetch;
const KEY_LEGACY = 'ZZLEGACY_1111111111';
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';
const KEY_STALE = 'ZZSTALEKEY_999999999';
const KEY_NEW = 'gsk_NEWKEY_1234567890';

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

function profile(id: string, label: string, provider: string, kid = 'default', enabled = true): Record<string, unknown> {
  return { id, label, provider, keys: [{ id: kid, label: kid, secretId: `${keySecretId(id, kid)}`, enabled }] };
}

function captureFetch(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push(String(init?.headers?.Authorization ?? ''));
    return okContent();
  }) as unknown as typeof fetch;
  return seen;
}

describe('28.9 аудит/ревью: ключ = активный профиль (failover off)', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('профиль с ключом, failover off → запрос идёт ключом профиля', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    const seen = captureFetch();
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(seen[0]).toContain(KEY_A);
  });

  it('только legacy (ноль профилей) → аудит ключом legacy-секрета (фолбэк при нуле)', async () => {
    state.secrets.set('codescout.apiKey', KEY_LEGACY);
    state.secrets.set('codescout.provider', 'groq');
    const seen = captureFetch();
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(seen[0]).toContain(KEY_LEGACY);
  });

  it('профили + legacy-рассинхрон → только профиль; legacy-ключ не уходит в сеть', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set('codescout.apiKey', KEY_STALE);
    const seen = captureFetch();
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(seen[0]).toContain(KEY_A);
    expect(seen.every((auth) => !auth.includes(KEY_STALE))).toBe(true);
  });

  it('активный id пуст, профили есть → первый профиль (не legacy)', async () => {
    state.set('codescout.keychain', [profile('b', 'Beta', 'openai')]);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    state.secrets.set('codescout.apiKey', KEY_LEGACY);
    const seen = captureFetch();
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(seen[0]).toContain(KEY_B);
    expect(seen.every((auth) => !auth.includes(KEY_LEGACY))).toBe(true);
  });

  it('failover ON не ломает путь: тот же профиль, тот же ключ', async () => {
    state.set('codescout.failover.enabled', true);
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    const seen = captureFetch();
    await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(seen[0]).toContain(KEY_A);
  });
});

describe('28.9 ошибка/тост: фактическое место ключа', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('профиль без секрета → «сохрани ключ в профиле …», без кодов/палитры', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    globalThis.fetch = (async () => okContent()) as unknown as typeof fetch;
    await expect(reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {})).rejects.toThrow(/профиле «Alpha»/);
    await expect(reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {})).rejects.not.toThrow(/codescout\.apiKey|set API key/);
  });

  it('ноль профилей без ключа → прежнее сообщение с командой палитры', async () => {
    globalThis.fetch = (async () => okContent()) as unknown as typeof fetch;
    const savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (/API_KEY$/i.test(key)) delete process.env[key];
    try {
      await expect(reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {})).rejects.toThrow(/set API key/);
    } finally {
      for (const key of Object.keys(process.env)) if (/API_KEY$/i.test(key)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });

  it('chooseModel с профилем без секрета → тост про профиль; без профилей → про команду', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    activate(makeFakeContext() as never);
    await flush();
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    expect(state.errorMessages.join(' ')).toContain('профиле «Alpha»');
    expect(state.errorMessages.join(' ')).not.toContain('set API key');
    state.reset();
    activate(makeFakeContext() as never);
    await flush();
    const savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (/API_KEY$/i.test(key)) delete process.env[key];
    try {
      await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
      expect(state.errorMessages.join(' ')).toContain('set API key');
    } finally {
      Object.assign(process.env, savedEnv);
    }
  });

  it('«Проверить снова» при профиле без секрета → честный ответ, ноль запросов', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    activate(makeFakeContext() as never);
    await flush();
    await (state.commands.get('codescout.testConnection') as () => Promise<unknown>)();
    await flush();
    expect(calls).toBe(0);
  });
});

describe('28.9 save: единая запись в активный профиль', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  async function openCenter(): Promise<{ send: (message: Record<string, unknown>) => void; html: () => string }> {
    activate(makeFakeContext() as never);
    await flush();
    await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    await flush();
    const panel = state.panels[state.panels.length - 1];
    return { send: (message) => { void panel.webview.onMessageHandlers[0](message as never); }, html: () => panel.webview.html };
  }

  it('saveAll при профилях → ключ в рабочий ключ профиля; legacy-слот не тронут; «сейчас» = профиль', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set('codescout.apiKey', KEY_STALE);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'saveAll', apiKey: KEY_NEW, providerKey: 'auto', baseUrl: '', reportLanguage: 'ru', showAuditBanner: true, linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'compact', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity', reportTheme: 'auto', customColors: '{}', failoverEnabled: false, failoverMaxCycles: 0 });
    await flush(); await flush(); await flush();
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_NEW);
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_STALE); // рассинхрон НЕ «лечится» тихой записью
    const html = center.html();
    expect(html).toContain(maskApiKey(KEY_NEW));
    expect(html).toContain('профиль «Alpha»');
    expect(html).not.toContain(maskApiKey(KEY_STALE));
  });

  it('saveAll без профилей (ноль) → legacy-слот как фолбэк-источник', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'saveAll', apiKey: KEY_NEW, providerKey: 'auto', baseUrl: '', reportLanguage: 'ru', showAuditBanner: true, linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'compact', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity', reportTheme: 'auto', customColors: '{}', failoverEnabled: false, failoverMaxCycles: 0 });
    await flush(); await flush(); await flush();
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_NEW);
  });

  it('сохранённый выключенный ключ включается и чистит broken (источник = рабочий профиль)', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq', 'default', false)]);
    state.set('codescout.keychain.active', 'a');
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'saveAll', apiKey: KEY_A, providerKey: 'auto', baseUrl: '', reportLanguage: 'ru', showAuditBanner: true, linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'compact', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity', reportTheme: 'auto', customColors: '{}', failoverEnabled: false, failoverMaxCycles: 0 });
    await flush(); await flush(); await flush();
    const profiles = state.config.get('codescout.keychain')?.globalValue as Array<{ keys: Array<{ id: string; enabled: boolean }> }>;
    expect(pickActiveKey(profiles[0] as never)?.id).toBe('default');
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
  });
});

describe('28.9 models/resume: кейчейн без legacy', () => {
  let root = '';
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); root = mkdtempSync(join(tmpdir(), 'cs-289-')); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n', 'utf8'); state.workspaceRoot = root; state.set('codescout.fileCooldownSeconds', 0); state.set('codescout.rateLimitPauses', 0); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; if (root) rmSync(root, { recursive: true, force: true }); });

  it('«Живые модели…» (fetch /models) идут ключом профиля, не legacy', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set('codescout.apiKey', KEY_STALE);
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)}|${String(init?.headers?.Authorization ?? '')}`);
      return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push('llama-3.3-70b-versatile');
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();
    const modelsCall = seen.find((line) => line.includes('/models'));
    expect(modelsCall).toBeDefined();
    expect(modelsCall).toContain(KEY_A);
    expect(modelsCall).not.toContain(KEY_STALE);
  });

  it('resume «Продолжить другими…» с legacy-рассинхроном: догон ключом профиля', async () => {
    state.set('codescout.keychain', [profile('a', 'Alpha', 'groq', 'default')]);
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set('codescout.apiKey', KEY_STALE);
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
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((auth) => !auth.includes(KEY_STALE))).toBe(true);
    expect(seen.some((auth) => auth.includes(KEY_A))).toBe(true);
  });
});
