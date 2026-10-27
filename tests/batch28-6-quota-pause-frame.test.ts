// МИКРО-БАТЧ 28.6: quota-паузы циклами + форма редактирования ВНУТРИ рамки
// карточки.
// Контракты:
//  1) первый quota-скип без возможности failover-ротации НЕ продолжает
//     очередь текущего цикла ни на один файл; Output цикла = ровно 2 строки
//     (skip + pause) независимо от длины очереди; чекпоинт пишется ДО паузы;
//     по истечении T — «▶️ цикл N: продолжаю с файла X», счётчик предохранителя
//     сбрасывается; потолок quotaPauseMaxCycles → финальный баннер
//     «Квота исчерпана» с кнопками догона; автономный ВЫКЛ — ровно ОДИН
//     баннер санкции на прогон;
//  2) форма профиля рендерится ВНУТРИ рамки редактируемой карточки: одна
//     рамка на карточку в любом режиме (.kc-form без своей рамки),
//     ближайший предок-рамка открытой формы = редактируемая карточка,
//     отображаемые строки ключей/действий в режиме правки скрыты (CSS) и
//     физически снимаются с DOM карточки клиентом (возврат на «Отмена»);
//  3) настройки quotaPauseSeconds (360, кламп 30-3600) / quotaPauseMaxCycles
//     (0 = без лимита) с nls ru/en; новые UI-строки в обоих словарях.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles, type QuotaPauseOptions } from '../extension/src/extension';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { buildReportHtml } from '../extension/src/reportHtml';
import {
  quotaPauseMaxCyclesFromSetting,
  quotaPauseSecondsFromSetting,
  readAuditProgress,
  skipBreakerFeed,
  skipBreakerReset,
  upsertSkippedFile,
  progressView,
  QuotaExhaustedError,
  type AuditCheckpoint,
  type SkipBreakerState
} from '../extension/src/projectAudit';
import { t } from '../src/i18n';
import { clearModelsCache } from '../src/providers';

const REAL_FETCH = globalThis.fetch;
const KEY = 'CS_MOCK_KEY_FOR_TESTS';

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function quota402(): Response {
  return new Response(JSON.stringify({ error: { message: 'insufficient_quota: top up your billing' } }), { status: 402, headers: { 'content-type': 'application/json' } });
}

// Какой файл дёрнули (по «File: <path>» в user-промпте) — счётчик запросов.
function trackFetch(fail: (file: string, seen: number) => boolean): { callsByFile: Map<string, number> } {
  const callsByFile = new Map<string, number>();
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const raw = String(init?.body ?? '');
    const match = /File: ([\w./-]+\.ts)/.exec(raw);
    const file = match ? match[1] : 'unknown';
    const seen = (callsByFile.get(file) ?? 0) + 1;
    callsByFile.set(file, seen);
    return fail(file, seen) ? quota402() : okContent();
  }) as unknown as typeof fetch;
  return { callsByFile };
}

interface QuotaCbs {
  skips: Array<{ file: string; cycle: number; queueRemaining: number }>;
  pauses: Array<{ file: string; cycle: number; seconds: number }>;
  resumes: Array<{ file: string; cycle: number }>;
  asks: number;
  sleeperMs: number[];
}

function makeQuotaHooks(options: { pauseSeconds?: number; maxCycles?: number; autonomous: boolean; ask?: () => Promise<boolean> }): { quota: QuotaPauseOptions; cbs: QuotaCbs } {
  const cbs: QuotaCbs = { skips: [], pauses: [], resumes: [], asks: 0, sleeperMs: [] };
  const quota: QuotaPauseOptions = {
    pauseSeconds: options.pauseSeconds ?? 360,
    maxCycles: options.maxCycles ?? 0,
    autonomous: () => options.autonomous,
    ask: options.ask,
    onSkipLine: (info) => cbs.skips.push({ file: info.filename, cycle: info.cycle, queueRemaining: info.queueRemaining }),
    onBeforePause: (info) => cbs.pauses.push({ file: info.filename, cycle: info.cycle, seconds: info.seconds }),
    onResumed: (info) => cbs.resumes.push({ file: info.filename, cycle: info.cycle })
  };
  return { quota, cbs };
}

async function runWithQuota(files: ReturnType<typeof fileSet>, quota: QuotaPauseOptions, sleeperMs: number[]): Promise<{ result?: Awaited<ReturnType<typeof reviewFiles>>; error?: unknown }> {
  try {
    const result = await reviewFiles(
      makeFakeContext() as never, files, undefined, () => {}, undefined, undefined, undefined, undefined, true,
      () => {}, undefined, undefined, 1, undefined, 3, undefined,
      async (ms: number) => { sleeperMs.push(ms); }, 'ru', 0, undefined, undefined, {}, undefined, quota
    );
    return { result };
  } catch (error) {
    return { error };
  }
}

// ── 1. quota-паузы: юнит-уровень reviewFiles ─────────────────────────────────
describe('микробатч 28.6: quota-паузы в reviewFiles', () => {
  beforeEach(() => {
    state.reset();
    vi.useRealTimers();
    state.secrets.set('codescout.apiKey', KEY);
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; vi.useRealTimers(); });

  it('первый quota-скип: очередь не дёргает следующие файлы (мок-счётчик ноль), потолок циклов → QuotaExhaustedError', async () => {
    const { quota, cbs } = makeQuotaHooks({ autonomous: true, maxCycles: 1, pauseSeconds: 360 });
    const touched = trackFetch(() => true);
    const slept: number[] = [];
    const { error } = await runWithQuota(fileSet(4), { ...quota }, slept);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    if (error instanceof QuotaExhaustedError) expect(error.pausedCycles).toBe(1);
    // следующий файл очереди НЕ стартовал: дёргался только f1
    expect(touched.callsByFile.size).toBe(1);
    expect(touched.callsByFile.has('src/f1.ts')).toBe(true);
    expect((touched.callsByFile.get('src/f1.ts') ?? 0)).toBe(2); // попытка до паузы + после
    // ровно один цикл паузы: skip-строк 2 (цикл 1 + финальный), пауза 1, resumed 1
    expect(cbs.skips.map((entry) => entry.cycle)).toEqual([1, 2]);
    expect(cbs.pauses.length).toBe(1);
    expect(cbs.pauses[0].seconds).toBe(360);
    expect(cbs.resumes.length).toBe(1);
    // пауза прошла через инжектируемый sleeper: 360с = 360000мс
    expect(slept).toContain(360000);
    // «остальные N файлов цикла не стартуют»: N = очередь без текущего файла
    expect(cbs.skips[0].queueRemaining).toBe(3);
  }, 60000);

  it('fake-pause → _resume с того же файла; после пробуждения квоты очередь идёт дальше без скипов', async () => {
    const { quota, cbs } = makeQuotaHooks({ autonomous: true, maxCycles: 3, pauseSeconds: 30 });
    const slept: number[] = [];
    // f1 падает quota ровно один раз (первый запрос), дальше всё ок
    const touched = trackFetch((file, seen) => file === 'src/f1.ts' && seen === 1);
    const { result, error } = await runWithQuota(fileSet(4), { ...quota }, slept);
    expect(error).toBeUndefined();
    expect(result?.skippedFiles).toBe(0);
    expect(result?.filesAnalyzed).toBe(4);
    // пауза 30с была ровно одна, resumed — по тому же f1
    expect(slept.filter((ms) => ms === 30000).length).toBe(1);
    expect(cbs.pauses[0].file).toBe('src/f1.ts');
    expect(cbs.resumes[0].file).toBe('src/f1.ts');
    expect(cbs.resumes[0].cycle).toBe(1);
    expect(touched.callsByFile.get('src/f1.ts')).toBe(2);
    expect(touched.callsByFile.get('src/f4.ts')).toBe(1);
  }, 60000);

  it('автономный ВЫКЛ: ask вызывается РОВНО один раз на прогон; «Стоп» = очередь стоит, паузы нет', async () => {
    // санкция дана → цикл 2 идёт сам, без второго баннера; потолок 2 → стоп
    const cbsRef = { asks: 0 };
    const { quota } = makeQuotaHooks({ autonomous: false, maxCycles: 2, pauseSeconds: 30 });
    const slept: number[] = [];
    const touched = trackFetch(() => true);
    const { error } = await runWithQuota(fileSet(5), { ...quota, ask: async () => { cbsRef.asks += 1; return true; } }, slept);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(cbsRef.asks).toBe(1);
    expect(slept.filter((ms) => ms === 30000).length).toBe(2);
    expect(touched.callsByFile.size).toBe(1); // f2..f5 не стартовали
    // «Стоп» (ask=false) — ни одной паузы, текущий файл не скипнут, очередь стоит
    const refused = makeQuotaHooks({ autonomous: false, maxCycles: 0, pauseSeconds: 30 });
    const slept2: number[] = [];
    const { error: stopError } = await runWithQuota(fileSet(3), { ...refused.quota, ask: async () => false }, slept2);
    expect(stopError).toBeInstanceOf(QuotaExhaustedError);
    if (stopError instanceof QuotaExhaustedError) expect(stopError.pausedCycles).toBe(0);
    expect(refused.cbs.pauses.length).toBe(0);
    expect(slept2.filter((ms) => ms === 30000).length).toBe(0);
  }, 60000);

  it('предохранитель: quota НЕ трогает skipBreakerFeed и НЕ рисует breaker в progressView', () => {
    const state1: SkipBreakerState = { count: 1, category: 'auth_invalid_key' };
    expect(skipBreakerFeed(state1, 'quota', 3)).toBe(false);
    expect(state1).toEqual({ count: 1, category: 'auth_invalid_key' });
    skipBreakerReset(state1);
    expect(state1.count).toBe(0);
    const checkpoint: AuditCheckpoint = {
      startedAt: 1,
      model: 'm',
      state: 'interrupted',
      checked: [],
      remaining: ['a.ts', 'b.ts'],
      skippedFiles: upsertSkippedFile(undefined, { file: 'a.ts', category: 'quota', http: 402, ts: 1 })
    };
    for (let i = 1; i < 6; i += 1) checkpoint.skippedFiles = upsertSkippedFile(checkpoint.skippedFiles, { file: `s${i}.ts`, category: 'quota', http: 402, ts: 2 });
    const view = progressView(checkpoint, 4);
    expect(view?.breaker, 'quota-хвост не рисует breaker-подсказку').toBeUndefined();
  });

  it('клампы настроек: quotaPauseSeconds 30-3600 дефолт 360; quotaPauseMaxCycles 0=без лимита, потолок 100', () => {
    expect(quotaPauseSecondsFromSetting(undefined)).toBe(360);
    expect(quotaPauseSecondsFromSetting('')).toBe(360);
    expect(quotaPauseSecondsFromSetting('abc')).toBe(360);
    expect(quotaPauseSecondsFromSetting(10)).toBe(30);
    expect(quotaPauseSecondsFromSetting(99999)).toBe(3600);
    expect(quotaPauseSecondsFromSetting(120.4)).toBe(120);
    expect(quotaPauseMaxCyclesFromSetting(undefined)).toBe(0);
    expect(quotaPauseMaxCyclesFromSetting(0)).toBe(0);
    expect(quotaPauseMaxCyclesFromSetting(-5)).toBe(0);
    expect(quotaPauseMaxCyclesFromSetting(2)).toBe(2);
    expect(quotaPauseMaxCyclesFromSetting(1000)).toBe(100);
  });
});

// ── 2. e2e аудита через vscode-stub + fake timers ────────────────────────────
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
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => {} })
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  provider.resolveWebviewView(view);
  return () => view.webview.html;
}

function makeWorkspace(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-b286-'));
  mkdirSync(join(root, 'src'));
  for (const name of names) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

// Прогон с fake timers: качаем часы, пока скан не завершится.
async function pumpUntil(settled: () => boolean, steps = 160, stepMs = 1000): Promise<void> {
  for (let i = 0; i < steps && !settled(); i += 1) await vi.advanceTimersByTimeAsync(stepMs);
}

describe('микробатч 28.6 e2e: аудит с quota-паузами', () => {
  beforeEach(() => {
    state.reset();
    clearModelsCache();
    state.secrets.set('codescout.apiKey', KEY);
    state.set('codescout.failover.enabled', false);
    state.set('codescout.quotaPauseSeconds', 30);
    state.set('codescout.fileCooldownSeconds', 0);
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; vi.useRealTimers(); });

  it('автономный ВКЛ, потолок 1 цикл: Output цикла = skip+pause (2 строки) независимо от длины очереди; финальный баннер «Квота исчерпана»', async () => {
    const root = makeWorkspace(['a.ts', 'b.ts', 'c.ts']);
    state.workspaceRoot = root;
    state.set('codescout.autoResume', true);
    state.set('codescout.quotaPauseMaxCycles', 1);
    let chatCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return quota402();
    }) as typeof fetch;
    vi.useFakeTimers({ now: 2_000_000 });
    const html = boot();
    let settled = false;
    const scan = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)().finally(() => { settled = true; });
    await pumpUntil(() => settled);
    await scan;
    vi.useRealTimers();
    // очередь не прогонялась: качали ТОЛЬКО a.ts (до паузы + после)
    expect(chatCalls).toBe(2);
    const lines = state.outputLines;
    const skipLines = lines.filter((line) => line.startsWith('⚠ quota: ключ'));
    const pauseLines = lines.filter((line) => line.startsWith('💤 quota-пауза'));
    const resumeLines = lines.filter((line) => line.startsWith('▶️ цикл'));
    // за цикл — ровно 2 строки (skip+pause); финальный цикл — только skip
    expect(pauseLines.length).toBe(1);
    expect(resumeLines.length).toBe(1);
    expect(skipLines.length).toBe(2);
    expect(skipLines[0]).toContain('исчерпан');
    expect(skipLines[0]).toContain('остальные 2 файлов цикла не стартуют');
    expect(pauseLines[0]).toContain('💤 quota-пауза: 30с до попытки (цикл 1)');
    expect(pauseLines[0]).toContain('проверено 0 из 3, находок 0 — сохранено');
    expect(resumeLines[0]).toBe('▶️ цикл 1: продолжаю с файла src/a.ts');
    expect(lines.some((line) => line.startsWith('🛑 Квота исчерпана: 1 цикл(ов) паузы'))).toBe(true);
    // предохранитель НЕ стопит на quota: circuit breaker-строк нет
    expect(lines.some((line) => line.includes('Circuit breaker'))).toBe(false);
    // чекпоинт цел, остальные файлы не тронуты, скоуп-файл не удалён
    const cp = readAuditProgress(root)!;
    expect(cp.state).toBe('interrupted');
    expect(cp.checked.length).toBe(0);
    expect(cp.remaining.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    // баннер «Квота исчерпана» + кнопки догона
    const view = html();
    expect(view).toContain('Квота исчерпана');
    expect(view).toContain('data-command="resumeAudit"');
    expect(view).toContain('data-command="resumeAuditOther"');
    rmSync(root, { recursive: true, force: true });
  }, 120000);

  it('автономный ВЫКЛ: баннер санкции ровно один на прогон; «Подождать и повторить» → циклы идут сами до потолка', async () => {
    const root = makeWorkspace(['a.ts', 'b.ts']);
    state.workspaceRoot = root;
    state.set('codescout.autoResume', false);
    state.set('codescout.quotaPauseMaxCycles', 2);
    let chatCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return quota402();
    }) as typeof fetch;
    vi.useFakeTimers({ now: 3_000_000 });
    boot();
    state.warningAnswers.push(t('quota.askWait', 'ru'));
    let settled = false;
    const scan = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)().finally(() => { settled = true; });
    await pumpUntil(() => settled);
    await scan;
    vi.useRealTimers();
    // одна санкция на прогон: второй цикл баннер НЕ переспрашивается
    expect(state.warningCalls.length).toBe(1);
    expect(String(state.warningCalls[0][0])).toContain('Квота исчерпана. Подождать 30с и повторить?');
    expect(state.warningCalls[0]).toContain('Подождать и повторить');
    expect(state.warningCalls[0]).toContain('Стоп');
    // два цикла паузы отработали, на третьем — потолок
    expect(state.outputLines.filter((line) => line.startsWith('💤 quota-пауза')).length).toBe(2);
    expect(state.outputLines.filter((line) => line.startsWith('▶️ цикл')).length).toBe(2);
    expect(chatCalls).toBe(3); // a.ts: fail → resume → fail → resume → fail → потолок
    expect(state.outputLines.some((line) => line.startsWith('🛑 Квота исчерпана: 2 цикл(ов) паузы'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }, 120000);

  it('отмена во время quota-паузы: чекпоинт (написан до сна) сохранён, ничего не потеряно, баннер догона', async () => {
    const root = makeWorkspace(['a.ts', 'b.ts']);
    state.workspaceRoot = root;
    state.set('codescout.autoResume', true);
    state.set('codescout.quotaPauseMaxCycles', 0);
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return quota402();
    }) as typeof fetch;
    vi.useFakeTimers({ now: 4_000_000 });
    const html = boot();
    let settled = false;
    const scan = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)().finally(() => { settled = true; });
    // довести до момента «ушли в паузу» (строка 💤 уже напечатана — чекпоинт до сна)
    await pumpUntil(() => state.outputLines.some((line) => line.startsWith('💤 quota-пауза')));
    expect(state.outputLines.some((line) => line.startsWith('💤 quota-пауза'))).toBe(true);
    // закрытие окна/отмена во время сна
    await (state.commands.get('codescout.cancelScan') as () => unknown)();
    await pumpUntil(() => settled, 20);
    await scan;
    vi.useRealTimers();
    const cp = readAuditProgress(root)!;
    expect(cp.state).toBe('cancelled');
    expect(cp.remaining.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(html()).toContain('data-command="resumeAudit"');
    rmSync(root, { recursive: true, force: true });
  }, 120000);
});

// ── 3. форма ВНУТРИ рамки карточки ───────────────────────────────────────────
const base: SettingsState = {
  keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: 'test',
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', showConfidence: true,
  findingsSort: 'severity', reportTheme: 'auto', customColors: '{}',
  keychainProfiles: [], keychainActiveId: '', failoverEnabled: false, failoverMaxCycles: 0
};

function settingsProfile(id: string, label: string): import('../extension/src/keychain').KeychainProfile {
  return { id, label, provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: `keychain.${id}.default`, enabled: true }] };
}

function scriptOf(html: string): string {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

function divAncestorsAt(html: string, marker: string): string[] {
  const idx = html.indexOf(marker);
  expect(idx, `маркер не найден: ${marker}`).toBeGreaterThan(-1);
  const stack: string[] = [];
  const re = /<div\b[^>]*>|<\/div\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && match.index < idx) {
    if (match[0].startsWith('</')) stack.pop();
    else stack.push(match[0]);
  }
  return stack;
}

describe('микробатч 28.6: форма редактирования внутри рамки карточки', () => {
  it('контракт: у открытой формы ближайший предок с классом рамки = редактируемая карточка (kc-row kc-editing)', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [settingsProfile('p1', 'Alpha'), settingsProfile('p2', 'Beta')],
      keychainActiveId: 'p1',
      keychainFormDraft: { profileId: 'p2', provider: 'groq', label: 'Beta', model: '', baseUrl: '' }
    }, '', 'ok', 'n286', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    const frame = ancestors.filter((a) => a.includes('kc-row'));
    expect(frame.length, 'ближайшие предки-рамки').toBeGreaterThan(0);
    const nearest = frame[frame.length - 1];
    expect(nearest).toContain('kc-editing');
    expect(nearest).toContain('data-profile-id="p2"');
    expect(ancestors.some((a) => a.includes('data-profile-id="p1"'))).toBe(false);
    // форма монтируется в слот карточки (тот же border/фон = рамка карточки)
    expect(ancestors.some((a) => a.includes('kc-form-slot'))).toBe(true);
  });

  it('одна рамка: у .kc-form НЕТ своей border/background; акцент и скрытие строк — на карточке kc-editing', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [settingsProfile('p1', 'Alpha')] }, '', 'ok', 'n286c', '', undefined, 'ru');
    const styleBlock = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
    const formRule = /\.kc-form \{([^}]*)\}/.exec(styleBlock);
    expect(formRule, '.kc-form rule отсутствует').toBeTruthy();
    expect(formRule![1]).not.toMatch(/border\s*:/);
    expect(formRule![1]).not.toMatch(/background\s*:/);
    expect(styleBlock).toMatch(/\.kc-row\.kc-editing\s*\{\s*border-color:/);
    expect(styleBlock).toContain('.kc-row.kc-editing > .kc-keys');
    expect(styleBlock).toContain('.kc-row.kc-editing > .kc-actions');
    expect(styleBlock).toContain('display: none');
  });

  it('режим создания: add-card с той же рамкой (kc-row) и заголовком «Новый профиль», открытая форма одна', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [settingsProfile('p1', 'Alpha')],
      keychainFormDraft: { provider: 'openrouter', label: '', model: '', baseUrl: '' }
    }, '', 'ok', 'n286n', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    const frame = ancestors.filter((a) => a.includes('kc-row'));
    expect(frame[frame.length - 1]).toContain('data-add-card');
    expect((html.match(/class="kc-form"/g) ?? []).length).toBe(1);
    const titleMatch = html.match(/<span id="kcFormTitle">([^<]*)<\/span>/);
    expect(titleMatch![1]).toBe('Новый профиль');
  });

  it('контракт скрипта: клиент снимает отображаемые строки с DOM карточки и возвращает на сворачивании', () => {
    const source = scriptOf(buildSettingsHtml({ ...base, keychainProfiles: [settingsProfile('p1', 'Alpha')] }, '', 'ok', 'n286s', '', undefined, 'en'));
    expect(source).toContain('function hideCardRows(card)');
    expect(source).toContain('function restoreCardRows(card)');
    expect(source).toContain('function clearEditingCards()');
    expect(source).toContain("card.classList.add('kc-editing'); hideCardRows(card);");
    // mountFormFor предварительна снимает kc-editing со всех карточек
    expect(source).toContain('clearEditingCards();');
    // hideForm («Отмена»/Escape) возвращает карточку в отображаемый вид
    expect(source).toContain("kcFormHome.appendChild(kcForm)");
    // серверный draft-рендер (ошибка валидации) синхронизирует скрытие строк
    expect(source).toContain('hideCardRows(serverCard)');
    expect(() => new Function(source)).not.toThrow();
  });

  it('регресс 28.4/28.5: закрытая форма — одна в хабе hidden; заголовок режима на месте', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [settingsProfile('p1', 'Alpha'), settingsProfile('p2', 'Beta')], keychainActiveId: 'p2' }, '', 'ok', 'n286r', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm" class="kc-form hidden"');
    expect(ancestors.some((a) => a.includes('id="kcFormHome"'))).toBe(true);
    expect((html.match(/class="kc-form"/g) ?? []).length).toBe(0);
    expect(html).toContain('class="kc-row kc-add-card hidden"');
    expect(html).toContain('id="kcFormModelDropdown"');
    const draft = buildSettingsHtml({
      ...base,
      keychainProfiles: [settingsProfile('p2', 'Beta')],
      keychainFormDraft: { profileId: 'p2', provider: 'groq', label: '', model: '', baseUrl: '' }
    }, '', 'ok', 'n286t', '', undefined, 'ru');
    expect(draft).toContain('Редактирование: Beta');
    expect(draft).toContain('id="kcFormTitleIcon" class="codicon codicon-edit"');
  });
});

// ── 4. i18n + манифест ────────────────────────────────────────────────────────
describe('микробатч 28.6: i18n и манифест', () => {
  it('quota.ask / quota.askWait / quota.banner — в обоих словарях, EN без кириллицы', () => {
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
    for (const key of ['quota.ask', 'quota.askWait', 'quota.banner']) {
      expect(typeof ru[key], `ru.${key}`).toBe('string');
      expect(typeof en[key], `en.${key}`).toBe('string');
      expect(en[key]).not.toMatch(/[\u0400-\u04FF]/);
    }
    expect(ru['quota.ask']).toContain('{s}');
    expect(t('quota.ask', 'ru', { s: 360 })).toBe('Квота исчерпана. Подождать 360с и повторить?');
    expect(t('quota.ask', 'en', { s: 360 })).toBe('Quota exhausted. Wait 360s and retry?');
  });

  it('баннер аудита: resumeView.quota рисует «Квота исчерпана» (ru) и EN-версию без кириллицы', () => {
    const stats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
    const resume = { done: 2, total: 5, model: 'm', startedAt: 0, findings: 3, quota: { cycles: 4 } };
    const baseArgs = [stats, false, true, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', resume, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const ru = buildReportHtml([], ...baseArgs, 'ru', {}, '', undefined, undefined, undefined);
    expect(ru).toContain('Квота исчерпана: 4 цикл(ов) паузы');
    expect(ru).toContain('data-command="resumeAudit"');
    const en = buildReportHtml([], ...baseArgs, 'en', {}, '', undefined, undefined, undefined);
    expect(en).toContain('Quota exhausted: 4 pause cycle(s)');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('манифест + nls: quotaPauseSeconds(360, 30-3600) и quotaPauseMaxCycles(0, 0-100)', () => {
    const manifest = JSON.parse(readFileSync('extension/package.json', 'utf8')) as { contributes: { configuration: { properties: Record<string, Record<string, unknown>> } } };
    const props = manifest.contributes.configuration.properties;
    expect(props['codescout.quotaPauseSeconds']).toMatchObject({ type: 'number', default: 360, minimum: 30, maximum: 3600 });
    expect(props['codescout.quotaPauseMaxCycles']).toMatchObject({ type: 'number', default: 0, minimum: 0, maximum: 100 });
    const nlsEn = JSON.parse(readFileSync('extension/package.nls.json', 'utf8')) as Record<string, string>;
    const nlsRu = JSON.parse(readFileSync('extension/package.nls.ru.json', 'utf8')) as Record<string, string>;
    for (const key of ['quotaPauseSeconds.description', 'quotaPauseMaxCycles.description']) {
      expect(nlsEn[key], `nls en ${key}`).toBeDefined();
      expect(nlsEn[key]).not.toMatch(/[\u0400-\u04FF]/);
      expect(nlsRu[key]).toMatch(/[\u0400-\u04FF]/);
    }
    // описание %token% заведено в обеих локалях
    expect(String(props['codescout.quotaPauseSeconds'].description)).toBe('%quotaPauseSeconds.description%');
    expect(String(props['codescout.quotaPauseMaxCycles'].description)).toBe('%quotaPauseMaxCycles.description%');
  });
});
