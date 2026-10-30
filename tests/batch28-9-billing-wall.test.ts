// Микро-батч 28.9, задача 2: billing-стенка не спит.
// 402/insufficient_credits/credits/billing/«upgrade to … tier» → ключ
// billing-blocked: НЕ усыпляется циклами, выводится из ротации как broken,
// подсказка «модель/тариф не покрыты». 429 с retry-after/reset-текстами →
// quota: сон и циклы как в 28.6. Все ключи blocked/asleep/broken → немедленный
// стоп с баннером-списком диагнозов (строка на профиль), без циклов сна.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, billingDiagnosisLines, reviewFiles } from '../extension/src/extension';
import {
  beginScan,
  decideFailover,
  diagnoseKeys,
  keyRuntimeId,
  keySecretId,
  markKeyBroken,
  markKeyRateLimited,
  resetRuntime,
  runtime,
  runtimeSnapshot,
  type KeychainKey,
  type KeychainProfile
} from '../extension/src/keychain';
import { BillingWallError } from '../src/llm-client';
import { clearModelsCache } from '../src/providers';
import { buildReportHtml } from '../extension/src/reportHtml';

const REAL_FETCH = globalThis.fetch;
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';

function key(pid: string, kid: string): KeychainKey {
  return { id: kid, label: kid, secretId: keySecretId(pid, kid), enabled: true };
}

function twoProfiles(): KeychainProfile[] {
  return [
    { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'default')] },
    { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'default')] }
  ];
}

function oneProfile(): KeychainProfile[] {
  return [{ id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'default')] }];
}

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Стена тарифа: 402 + деньги-текст.
function billingWall402(): Response {
  return new Response(JSON.stringify({ error: { message: 'insufficient_credits: top up your billing to continue' } }), { status: 402, headers: { 'content-type': 'application/json' } });
}

// Окно (429-семейство) текстом в 500 — чтобы без внутренней лестницы клиента,
// как в 28.6: сон и циклы ПОМОГАЮТ (regress 28.5/28.6).
function quotaWindowText(): Response {
  return new Response(JSON.stringify({ error: { message: 'exceeded your current quota, this daily limit resets in 42s' } }), { status: 500, headers: { 'content-type': 'application/json' } });
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

interface CapturedView {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: (uri: { toString(): string }) => { toString(): string };
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (cb: (message: never) => void) => { dispose(): void };
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
}

function boot(): () => string {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const view: CapturedView = {
    webview: { html: '', options: {}, cspSource: 'vscode-webview://test', asWebviewUri: (uri) => uri, postMessage: async () => true, onDidReceiveMessage: () => ({ dispose: () => {} }) },
    onDidDispose: () => ({ dispose: () => {} })
  };
  provider.resolveWebviewView(view);
  return () => view.webview.html;
}

function makeWorkspace(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-289bill-'));
  mkdirSync(join(root, 'src'));
  for (const name of names) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

describe('28.9 unit: решатель — billing без сна', () => {
  beforeEach(() => { state.reset(); resetRuntime(); });

  it('402 на A → switch на B: A billing-blocked, sleepUntil НЕ тронут', () => {
    const profiles = twoProfiles();
    state.set('codescout.keychain', profiles);
    beginScan('a', 'default');
    const now = 1_000_000;
    const { decision } = decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, undefined, now, 'billing');
    expect(decision.kind).toBe('switch');
    if (decision.kind === 'switch') expect(decision.profile.id).toBe('b');
    const stateA = runtime.get(keyRuntimeId('a', 'default'));
    expect(stateA?.billingBlocked).toBe(true);
    expect(stateA?.sleepUntil ?? 0).toBe(0);
    expect(decision.kind === 'switch' ? decision.sleepSeconds : -1).toBe(0);
  });

  it('billing-blocked ключ не кандидат ротации (как broken), сон quota — кандидат wait', () => {
    const profiles = twoProfiles();
    state.set('codescout.keychain', profiles);
    markKeyBroken('b', 'default'); // B сломан
    beginScan('a', 'default');
    const now = 2_000_000;
    const { decision } = decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, undefined, now, 'billing');
    // A billing + B broken: живых нет, noneLeft/billingWall → стоп, НЕ wait.
    expect(decision.kind).toBe('stop');
  });

  it('стена + спящий ключ: немедленный stop billingWall вместо паузы min(sleepUntil)', () => {
    const profiles = twoProfiles();
    state.set('codescout.keychain', profiles);
    markKeyRateLimited('b', 'default', 2_000_000, 600); // B спит 600с
    beginScan('a', 'default');
    const { decision } = decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, undefined, 2_000_000, 'billing');
    expect(decision.kind).toBe('stop');
    if (decision.kind === 'stop') expect(decision.reason).toBe('billingWall');
    // регресс 28.6/28.7: тот же микс БЕЗ billing-блокировок = wait (окно лечится сном)
    resetRuntime();
    markKeyRateLimited('b', 'default', 2_000_000, 600);
    beginScan('a', 'default');
    const rate = decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, 300, 2_000_000, 'rate_limit');
    expect(rate.decision.kind).toBe('wait');
  });

  it('runtimeSnapshot/diagnoseKeys: billing виден отдельно от broken/asleep', () => {
    const profiles = twoProfiles();
    state.set('codescout.keychain', profiles);
    markKeyBroken('b', 'default');
    beginScan('a', 'default');
    decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, undefined, Date.now(), 'billing');
    const snap = runtimeSnapshot(profiles);
    expect(snap['a/default']?.billing).toBe(true);
    expect(snap['a/default']?.broken).toBe(false);
    expect(snap['b/default']?.broken).toBe(true);
    const diag = diagnoseKeys(profiles);
    expect(diag.find((d) => d.profileId === 'a')?.state).toBe('billing');
    expect(diag.find((d) => d.profileId === 'b')?.state).toBe('broken');
    const lines = billingDiagnosisLines('ru');
    expect(lines.length).toBe(2); // строка на профиль
    expect(lines.some((l) => l.includes('Alpha') && l.includes('стена тарифа'))).toBe(true);
    expect(lines.some((l) => l.includes('Beta') && l.includes('сломан'))).toBe(true);
    const enLines = billingDiagnosisLines('en');
    expect(enLines.join('\n')).not.toMatch(/[\u0400-\u04FF]/);
  });
});

describe('28.9 e2e: reviewFiles — 402 blocked без сна, 429 окно спит', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); state.set('codescout.fileCooldownSeconds', 0); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('402 credits + failover ON: A → billing-blocked (без сна), ротация на B, ноль скипов', async () => {
    state.set('codescout.keychain', twoProfiles());
    state.set('codescout.keychain.active', 'a');
    state.set('codescout.failover.enabled', true);
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    activate(makeFakeContext() as never);
    await flush();
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      return auth.includes(KEY_A) ? billingWall402() : okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(2), undefined, () => {});
    expect(result.skippedFiles).toBe(0);
    expect(seen.some((a) => a.includes(KEY_B))).toBe(true);
    const stateA = runtime.get(keyRuntimeId('a', 'default'));
    expect(stateA?.billingBlocked).toBe(true);
    expect(stateA?.sleepUntil ?? 0).toBe(0); // НЕ усыплён
    expect(state.outputLines.some((l) => l.includes('💳 billing: ключ Alpha/default у стены тарифа') && l.includes('сон не поможет'))).toBe(true);
  }, 60000);

  it('402 credits, failover OFF, один профиль → BillingWallError немедленно (нет циклов)', async () => {
    state.set('codescout.keychain', oneProfile());
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    globalThis.fetch = (async () => billingWall402()) as unknown as typeof fetch;
    const slept: number[] = [];
    await expect(reviewFiles(makeFakeContext() as never, fileSet(3), undefined, () => {}, undefined, undefined, undefined, undefined, true, undefined, undefined, undefined, 1, undefined, 3, undefined, async (ms) => { slept.push(ms); })).rejects.toBeInstanceOf(BillingWallError);
    // ни секунды сна: длинных пауз (лестница/quota-циклы) не было
    expect(slept.filter((ms) => ms > 2000)).toEqual([]);
    expect(runtime.get(keyRuntimeId('a', 'default'))?.billingBlocked).toBe(true);
    expect(runtime.get(keyRuntimeId('a', 'default'))?.sleepUntil ?? 0).toBe(0);
  }, 60000);

  it('429 daily-окно (regress 28.5/28.6): quota-ветка — сон и повторы, НЕ billing', async () => {
    state.set('codescout.keychain', oneProfile());
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return calls === 1 ? quotaWindowText() : okContent(); }) as unknown as typeof fetch;
    const slept: number[] = [];
    let paused = 0;
    const result = await reviewFiles(
      makeFakeContext() as never, fileSet(1), undefined, () => {}, undefined, undefined, undefined, undefined, true,
      undefined, undefined, undefined, 1, undefined, 0, undefined,
      async (ms) => { slept.push(ms); },
      'ru', 0, undefined, undefined, {}, undefined,
      { pauseSeconds: 30, maxCycles: 2, autonomous: () => true, onBeforePause: () => { paused += 1; } }
    );
    expect(result.skippedFiles).toBe(0);
    expect(paused).toBe(1); // quota-пауза циклом = сон помогает
    expect(slept).toContain(30_000);
    expect(runtime.get(keyRuntimeId('a', 'default'))?.billingBlocked ?? false).toBe(false);
  }, 60000);

  it('429 с retry-after header (окно): ключ УСЫПЛЯЕТСЯ решателем — не billing', async () => {
    const profiles = twoProfiles();
    state.set('codescout.keychain', profiles);
    beginScan('a', 'default');
    const { decision } = decideFailover({ profiles, current: { profileId: 'a', keyId: 'default' }, allowWaitOnce: false, cycle: 0 }, { autonomous: true, maxCycles: 0 }, 300, Date.now(), 'quota');
    expect(decision.kind).toBe('switch');
    const stateA = runtime.get(keyRuntimeId('a', 'default'));
    expect(stateA?.sleepUntil).toBeGreaterThan(0);
    expect(stateA?.billingBlocked ?? false).toBe(false);
  });
});

describe('28.9 e2e: аудит упёрся в стену — баннер-список, без сна', () => {
  let root = '';
  beforeEach(() => {
    state.reset(); resetRuntime(); clearModelsCache();
    root = makeWorkspace(['a.ts', 'b.ts', 'c.ts']);
    state.workspaceRoot = root;
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 3);
    state.set('codescout.autoResume', false);
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; if (root) rmSync(root, { recursive: true, force: true }); });

  it('402 на единственном ключе: стоп после первого файла; баннер-список на профиль; нет кнопки «подождать»', async () => {
    state.set('codescout.keychain', oneProfile());
    state.set('codescout.keychain.active', 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    let chatCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return billingWall402();
    }) as typeof fetch;
    const html = boot();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(chatCalls).toBe(1); // очередь не дёргалась
    const view = html();
    expect(view).toContain('audit-resume billing');
    expect(view).toContain('Стена тарифа: живых ключей нет');
    expect(view).toContain('Alpha');
    expect(view).toContain('Сон не поможет'); // ru UI-подсказка в баннере
    expect(view).not.toContain('failoverWaitResume'); // кнопок «подождать» нет
    expect(view).toContain('resumeAudit');           // догон живёт в resume-баннере
    expect(state.outputLines.some((l) => l.includes('🛑 billing:') && l.includes('сон не поможет'))).toBe(true);
    expect(state.outputLines.some((l) => l.includes('💳 billing: ключ Alpha/default у стены тарифа'))).toBe(true);
  }, 120000);
});

describe('28.9 reportHtml: billing-баннер — контракт строк', () => {
  it('ru и en рендер: список, хвост, без Cyrillic в en', () => {
    const html = buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, false, '', 'retry', 'm', true, 'groq', 'x', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru', {}, '', undefined, undefined, undefined, { lines: ['Alpha: default — стена тарифа'], tail: 'insufficient_credits: top up' });
    expect(html).toContain('audit-resume billing');
    expect(html).toContain('Alpha: default — стена тарифа');
    expect(html).toContain('insufficient_credits');
    const en = buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, false, '', 'retry', 'm', true, 'groq', 'x', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'en', {}, '', undefined, undefined, undefined, { lines: ['Alpha: default — billing wall'], tail: 'insufficient_credits' });
    expect(en).toContain('Billing wall: no live keys left');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });
});
