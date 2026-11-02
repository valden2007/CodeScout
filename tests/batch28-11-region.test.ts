// МИКРО-БАТЧ 28.11, задача 4: категория 'region' (не попала в 28.10).
// Тексты «Global regions / Privacy settings / region not available /
// workspace's Privacy» → category region (проверка ДО unknown), подсказка —
// «настройка приватности/региона провайдера, не квота». Breaker считает region
// как unknown-подобную (стоп после skipBreakerLimit), но баннер/Output дают
// точную подсказку. Регрессы billing/quota/context-wall/404 обязательны.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categorizeError, formatError, ERROR_CATEGORIES } from '../src/error-classifier';
import { ProviderHttpError } from '../src/llm-client';
import { skipBreakerFeed, readAuditProgress, type SkipBreakerState } from '../extension/src/projectAudit';
import { t } from '../src/i18n';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';

const realFetch = globalThis.fetch;

const REGION_MESSAGE = "This model is currently unavailable in your region. To enable access, go to your workspace's Privacy settings and choose Global regions";

describe('микробатч 28.11 задача 4: region-категория', () => {
  it('ERROR_CATEGORIES + словари: err.title/msg/hint.region в ru и en', () => {
    expect(ERROR_CATEGORIES).toContain('region');
    for (const key of ['err.title.region', 'err.msg.region', 'err.hint.region']) {
      for (const lang of ['ru', 'en'] as const) {
        const value = t(key, lang);
        expect(value, key).not.toBe(key); // без промаха словаря
        expect(value.length).toBeGreaterThan(10);
      }
    }
    const en = readFileSync('src/i18n/en.json', 'utf8');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('мок «Global regions» → region + точная подсказка, не unknown', () => {
    expect(categorizeError(new Error(REGION_MESSAGE))).toBe('region');
    const formatted = formatError(new Error(REGION_MESSAGE), 'ru');
    expect(formatted.category).toBe('region');
    expect(formatted.title).toBe(t('err.title.region', 'ru'));
    expect(formatted.actionHint).toBe(t('err.hint.region', 'ru'));
    expect(formatted.actionHint).not.toBe(t('err.hint.unknown', 'ru'));
    expect(formatted.actionHint).toContain('Global');
    const en = formatError(new Error(REGION_MESSAGE), 'en');
    expect(en.actionHint).toContain('region');
    expect(en.title).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('текстовые варианты стены ловятся; ProviderHttpError 403/404 с region-текстом — тоже region', () => {
    expect(categorizeError(new Error('HTTP 403 PERMISSION_DENIED: Publisher model is not available in region; check privacy settings'))).toBe('region');
    expect(categorizeError(new Error('model not available in your region'))).toBe('region');
    expect(categorizeError(new ProviderHttpError(404, '404: unavailable in your region', ''))).toBe('region');
    expect(categorizeError(new ProviderHttpError(403, 'PERMISSION_DENIED', "Global regions aren't enabled for this project"))).toBe('region');
  });

  it('breaker: серия region считается как unknown-подобная — стоп на лимите', () => {
    const state: SkipBreakerState = { count: 0 };
    expect(skipBreakerFeed(state, 'region', 4)).toBe(false);
    expect(skipBreakerFeed(state, 'region', 4)).toBe(false);
    expect(skipBreakerFeed(state, 'region', 4)).toBe(false);
    expect(skipBreakerFeed(state, 'region', 4)).toBe(true);
    expect(state.category).toBe('region');
  });

  it('регрессы 28.9/28.10: billing/quota/context-wall/обычная 404 — не съедены', () => {
    expect(categorizeError(new Error('insufficient_credits: upgrade to Pro tier to continue'))).toBe('billing');
    expect(categorizeError(new ProviderHttpError(402, '402: payment required', 'top up billing'))).toBe('billing');
    expect(categorizeError(new Error('HTTP 429 too many requests, quota resets in 42s'))).toBe('quota');
    expect(categorizeError(new Error("HTTP 400 Bad Request: this model's context length is 8192 tokens, request too large"))).toBe('context-wall');
    expect(categorizeError(new Error('HTTP 413 request too large'))).toBe('context-wall');
    expect(categorizeError(new ProviderHttpError(404, '404: model gemini-99-ultra not found', ''))).toBe('model_not_found');
    expect(categorizeError(new Error('HTTP 401 invalid api key'))).toBe('auth_invalid_key');
    expect(categorizeError(new Error('всё сломалось'))).toBe('unknown');
  });

  it('скип-строка Output печатает категорию region (formatSkipReason через classifier)', async () => {
    const { formatSkipReason, skipReasonLine } = await import('../extension/src/projectAudit');
    const reason = formatSkipReason(new Error(REGION_MESSAGE));
    expect(reason.category).toBe('region');
    expect(skipReasonLine('src/a.ts', reason)).toContain('причина: region');
  });

  it('e2e: мок «Global regions» (403) — стоп по breaker и баннер с ТОЧНОЙ подсказкой, не unknown', async () => {
    state.reset();
    const root = mkdtempSync(join(tmpdir(), 'cs-b2811region-'));
    mkdirSync(join(root, 'src'));
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
    let chatCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'PERMISSION_DENIED: ' + REGION_MESSAGE } }), { status: 403 });
    }) as typeof fetch;

    activate(makeFakeContext() as never);
    const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: { webview: { html: string; options: unknown; cspSource: string; asWebviewUri: (uri: { toString(): string }) => { toString(): string }; postMessage: (message: unknown) => Promise<boolean>; onDidReceiveMessage: (cb: (message: never) => void) => { dispose(): void } }; onDidDispose: (cb: () => void) => { dispose(): void } }) => void };
    let viewHtml = '';
    provider.resolveWebviewView({
      webview: {
        get html() { return viewHtml; },
        set html(value: string) { viewHtml = value; },
        options: {},
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} })
      },
      onDidDispose: () => ({ dispose: () => {} })
    });
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // breaker (лимит 4 подряд) считает region как unknown-подобную — стоп на 4-м
    expect(chatCalls).toBe(4);
    const skipLines = state.outputLines.filter((line) => line.includes('⚠️ Пропущен файл:'));
    expect(skipLines.length).toBe(4);
    for (const line of skipLines) {
      expect(line).toContain('причина: region');
      expect(line).toContain('HTTP 403');
    }

    // баннер даёт точную подсказку region, а не generic unknown
    expect(viewHtml).toContain('Сработал предохранитель');
    expect(viewHtml).toContain('region');
    expect(viewHtml).toContain(t('err.hint.region', 'ru'));
    expect(viewHtml).not.toContain(t('err.hint.unknown', 'ru'));
    expect(viewHtml).toContain('data-command="resumeAudit"');

    const cp = readAuditProgress(root)!;
    expect(cp.skippedFiles?.[0]?.category).toBe('region');
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }, 120000);
});
