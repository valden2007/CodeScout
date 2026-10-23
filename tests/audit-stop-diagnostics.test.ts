import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { ProviderHttpError, RateLimitError } from '../src/llm-client';
import { buildReportHtml } from '../extension/src/reportHtml';
import {
  formatSkipReason,
  skipReasonLine,
  skipBreakerFeed,
  skipBreakerReset,
  skipBreakerLimitFromSetting,
  trailingSkippedRun,
  progressView,
  readAuditProgress,
  readAuditResults,
  readFindingsHistory,
  writeAuditProgress,
  type AuditCheckpoint,
  type SkipBreakerState,
  type SkippedFileEntry
} from '../extension/src/projectAudit';

const realFetch = globalThis.fetch;

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
  const root = mkdtempSync(join(tmpdir(), 'cs-b26-'));
  mkdirSync(join(root, 'src'));
  for (const name of names) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

const issueResponse = (file: string, desc: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues: [{ file, line: 1, category: 'bug', severity: 'medium', description: desc, suggestion: 'fix', confidence: 80 }], summary: 'ok' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

// ── задача 1: причина в строке скипа ───────────────────────────────────────
describe('батч 26: причина скипа', () => {
  it('скип печатает категорию и HTTP', () => {
    const auth = skipReasonLine('src/a.ts', formatSkipReason(new ProviderHttpError(401, '401: invalid api key')));
    expect(auth).toContain('⚠️ Пропущен файл: src/a.ts — причина: auth_invalid_key (HTTP 401,');
    expect(auth).toContain('401: invalid api key');
    const model = skipReasonLine('src/b.ts', formatSkipReason(new ProviderHttpError(404, '404: model gemini/x does not exist')));
    expect(model).toContain('причина: model_not_found (HTTP 404');
    const rl = skipReasonLine('src/c.ts', formatSkipReason(new RateLimitError('Rate limited by m: too many requests', 60)));
    expect(rl).toContain('причина: rate_limit_exceeded (HTTP 429');
    const net = skipReasonLine('src/d.ts', formatSkipReason(new Error('fetch failed')));
    expect(net).toContain('причина: connection_refused');
    expect(net).not.toContain('HTTP');
    const parse = skipReasonLine('src/e.ts', formatSkipReason(new Error('Unexpected token < in JSON')));
    expect(parse).toContain('причина: invalid_json');
  });

  it('хвост = последние 80 символов sanitized; секреты и control-символы вычищены', () => {
    const long = 'x'.repeat(300) + ' invalid api key sk-abcdefghijklmnopqrstuv';
    const r = formatSkipReason(new Error(long));
    expect(r.tail.length).toBeLessThanOrEqual(80);
    expect(r.tail).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(r.tail).toContain('invalid api key');
    expect(r.category).toBe('auth_invalid_key');
    const ctrl = formatSkipReason(new Error('abc\u0000def'));
    expect(ctrl.tail).not.toContain('\u0000');
  });

  it('чекпоинт хранит skippedFiles [{file, category, http, ts}] и перечитывается', () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-b26-cp-'));
    try {
      const entries: SkippedFileEntry[] = [
        { file: 'src/a.ts', category: 'auth_invalid_key', http: 401, ts: 111 },
        { file: 'src/b.ts', category: 'auth_invalid_key', http: 401, ts: 222 }
      ];
      writeAuditProgress(root, { startedAt: 1, model: 'm', provider: 'p', state: 'interrupted', checked: [], remaining: ['src/c.ts'], skippedFiles: entries });
      const back = readAuditProgress(root)!;
      expect(back.skippedFiles).toEqual(entries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── задача 2: circuit breaker ───────────────────────────────────────────────
describe('батч 26: circuit breaker (чистые функции)', () => {
  it('стопит на 4-м подряд одной категорией', () => {
    const s: SkipBreakerState = { count: 0 };
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(true);
  });

  it('вперемешку (auth, parse, auth) НЕ стопит', () => {
    const s: SkipBreakerState = { count: 0 };
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'invalid_json', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(s, 'auth_invalid_key', 4)).toBe(false);
    expect(s.count).toBe(2);
  });

  it('успешный файл сбрасывает счётчик; limit 0 = выключен', () => {
    const s: SkipBreakerState = { count: 0 };
    skipBreakerFeed(s, 'connection_refused', 4);
    skipBreakerFeed(s, 'connection_refused', 4);
    skipBreakerReset(s);
    expect(s.count).toBe(0);
    expect(skipBreakerFeed(s, 'connection_refused', 4)).toBe(false);
    const off: SkipBreakerState = { count: 0 };
    for (let i = 0; i < 10; i++) expect(skipBreakerFeed(off, 'timeout', 0)).toBe(false);
  });

  it('skipBreakerLimitFromSetting: дефолт 4, 0 = выключен, мусор/кламп', () => {
    expect(skipBreakerLimitFromSetting(undefined)).toBe(4);
    expect(skipBreakerLimitFromSetting(0)).toBe(0);
    expect(skipBreakerLimitFromSetting(-3)).toBe(4);
    expect(skipBreakerLimitFromSetting('junk')).toBe(4);
    expect(skipBreakerLimitFromSetting(999)).toBe(20);
  });

  it('progressView: breaker по хвосту skippedFiles (переживает reload)', () => {
    const same = (n: number): SkippedFileEntry[] => Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, category: 'auth_invalid_key', http: 401, ts: i }));
    const cp: AuditCheckpoint = { startedAt: 1, model: 'm', provider: 'p', checked: [{ file: 'ok.ts', issues: [] }], remaining: ['rest.ts'], skippedFiles: same(4) };
    expect(trailingSkippedRun(cp.skippedFiles)).toEqual({ category: 'auth_invalid_key', count: 4 });
    expect(progressView(cp, 4)?.breaker).toEqual({ category: 'auth_invalid_key', count: 4 });
    expect(progressView(cp, 5)?.breaker).toBeUndefined();
    const mixed: AuditCheckpoint = { startedAt: 1, model: 'm', checked: [], remaining: ['x.ts'], skippedFiles: [...same(3), { file: 'p.ts', category: 'invalid_json', ts: 9 }, { file: 'a.ts', category: 'auth_invalid_key', http: 401, ts: 10 }] };
    expect(progressView(mixed, 4)?.breaker).toBeUndefined();
    expect(progressView(mixed, 4)?.done).toBe(0);
  });

  it('EN-рендер баннера с breaker-подсказкой без кириллицы', () => {
    const stats = { files: 0, seconds: 1, critical: 0, medium: 0, low: 0 };
    const html = buildReportHtml([], stats, false, false, '⛔ Scan stopped by user', 'error', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', { done: 1, total: 5, model: 'm', provider: 'p', startedAt: 1, findings: 0, breaker: { category: 'auth_invalid_key', count: 4 } }, undefined, false, 0, 0, undefined, 'n', undefined, 'en');
    expect(html).toContain('Circuit breaker tripped: 4 identical skips in a row');
    expect(html).toContain('Check the key in the provider console');
    expect(html).toContain('Scan stopped by user');
    expect(html).not.toMatch(/[\u0400-\u04FF]/);
  });
});

// ── задача 5: chore activationEvents ────────────────────────────────────────
describe('батч 26: activationEvents', () => {
  it('манифест не содержит onCommand-событий (VS Code генерирует сам)', () => {
    const manifest = JSON.parse(readFileSync('extension/package.json', 'utf8')) as { activationEvents?: string[] };
    expect(manifest.activationEvents ?? []).toEqual([]);
    expect(JSON.stringify(manifest.activationEvents ?? [])).not.toContain('onCommand:');
  });
});

// ── e2e: breaker + last-good через реальную панель ─────────────────────────
describe('батч 26 e2e: стоп аудита по breaker и last-good', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('401 подряд: аудит стопится на 4-м скипе, баннер с подсказкой «ключ», skippedFiles в чекпоинте', async () => {
    root = makeWorkspace(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    state.workspaceRoot = root;
    let chatCalls = 0;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
    }) as typeof fetch;

    const html = boot();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // пятый файл не запрашивался: break'ер останавливает аудит на 4-м подряд
    expect(chatCalls).toBe(4);
    const skipLines = state.outputLines.filter((line) => line.includes('⚠️ Пропущен файл:'));
    expect(skipLines.length).toBe(4);
    for (const line of skipLines) {
      expect(line).toContain('причина: auth_invalid_key');
      expect(line).toContain('HTTP 401');
    }
    expect(state.outputLines.some((line) => line.includes('🛑 Circuit breaker: 4'))).toBe(true);

    const view = html();
    expect(view).toContain('Аудит остановлен: проверено 0 из 5 файлов');
    expect(view).toContain('Сработал предохранитель: 4 одинаковых скипа подряд');
    expect(view).toContain('auth_invalid_key');
    expect(view).toContain('Проверьте ключ в консоли провайдера');
    expect(view).toContain('data-command="resumeAudit"');
    expect(view).toContain('data-command="resumeAuditOther"');
    expect(view).toContain('data-command="restartAudit"');
    // аудит остановлен, скан-режим снят
    expect(view).not.toContain('data-command="cancelScan"');

    const cp = readAuditProgress(root)!;
    expect(cp.state).toBe('interrupted');
    expect(cp.skippedFiles?.length).toBe(4);
    expect(cp.skippedFiles?.[0]).toMatchObject({ file: 'src/a.ts', category: 'auth_invalid_key', http: 401 });
    expect(cp.skippedFiles?.[0]?.ts).toBeGreaterThan(0);
  }, 60000);

  it('прогон с 0 проверенных не затирает находки; динамика считается против last-good', async () => {
    root = makeWorkspace(['a.ts', 'b.ts', 'c.ts']);
    state.workspaceRoot = root;
    // прогон 1: a/b с находками, c падает
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/c.ts')) throw new Error('upstream exploded');
      if (body.includes('src/a.ts')) return issueResponse('src/a.ts', 'ALPHA_DESC');
      return issueResponse('src/b.ts', 'BETA_DESC');
    }) as typeof fetch;
    const live = boot();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(readAuditResults(root)!.checkedFiles).toBe(2);

    // прогон 2 (заново): всё падает → 0 проверенных файлов
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('upstream exploded');
    }) as typeof fetch;
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // last-good цел: ни результаты, ни история не перезаписаны пустым прогоном
    const kept = readAuditResults(root);
    expect(kept).toBeDefined();
    expect(kept!.findings.map((f) => f.description).sort()).toEqual(['ALPHA_DESC', 'BETA_DESC']);
    expect(kept!.checkedFiles).toBe(2);
    expect(readFindingsHistory(root)!.findings.length).toBe(2);
    expect(state.outputLines.some((line) => line.includes('last-good результаты (2 находок) НЕ перезаписаны'))).toBe(true);

    // динамика против last-good: «осталось 2», ни одной «починено»
    const view = live();
    expect(view).toContain('🔁 осталось: 2');
    expect(view).toContain('✅ починено: 0');
    expect(view).toContain('ALPHA_DESC');
    expect(view).toContain('BETA_DESC');
    expect(view).toContain('Аудит остановлен: проверено 0 из 3 файлов');
    expect(view).toContain('находок 2');
    // карточка «итог аудита» не показывается: проверено 0 файлов (кнопка openReport только в ней)
    expect(view).not.toContain('data-command="openReport"');

    // reload: находки и баннер «2 находки» восстанавливаются из last-good
    const revived = boot();
    const reviveDeadline = Date.now() + 10000;
    while (!revived().includes('ALPHA_DESC') && Date.now() < reviveDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(revived()).toContain('ALPHA_DESC');
    expect(revived()).toContain('Аудит остановлен: проверено 0 из 3 файлов');
    expect(revived()).toContain('находок 2');
  }, 120000);
});
