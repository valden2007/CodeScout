import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import * as reporting from '../extension/src/reportIssue';

const SECRET = 'CS_MOCK_KEY_FOR_TESTS';

describe('v1.4b-13 reportIssue e2e (mock key must never leak)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it.each([
    ['\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074', ['secret']],
    ['\\u0073\\u006b-mocktoken42', []],
    ['g\\u0073k_MOCKPROVIDERTOKEN42', []],
    ['\\u0043S_MOCK_KEY_FOR_TESTS', [SECRET]],
    ['\\u0061\\u0062\\u0063', ['abc']],
    ['\\u00e9-private', ['\u00e9-private']]
  ])('normalizes Unicode escapes before redaction: %s', (value, keys) => {
    expect(reporting.redactSecrets(value as string, keys as string[])).toBe('***');
  });

  it('passes only pre-redacted diagnostics and hasKey to the formatter', async () => {
    const formatter = vi.spyOn(reporting, 'buildIssueBody');
    state.secrets.set('codescout.apiKey', SECRET);
    state.set('codescout.apiKey', 'CONFIG_PRIVATE_KEY');
    state.set('codescout.provider', SECRET);
    state.set('codescout.model', '\\u0043ONFIG_PRIVATE_KEY');
    state.set('codescout.uiTheme', SECRET);
    state.set('codescout.rateLimitPauses', 0);
    const context = makeFakeContext() as { extension: { packageJSON: { version: string } } };
    context.extension.packageJSON.version = SECRET;
    globalThis.fetch = (async () => { throw new Error(`failure ${SECRET} \\u0043ONFIG_PRIVATE_KEY`); }) as typeof fetch;
    activate(context as never);
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await (state.commands.get('codescout.reportIssue') as () => Promise<unknown>)();
    const input = formatter.mock.calls[0][1];
    expect(input).not.toHaveProperty('keyValues');
    expect(input.hasKey).toBe(true);
    expect(input.extVersion).toBe('***');
    expect(input.provider).toBe('***');
    expect(input.model).toBe('***');
    expect(input.uiTheme).toBe('***');
    expect(JSON.stringify(input)).not.toContain(SECRET);
    expect(JSON.stringify(input)).not.toContain('CONFIG_PRIVATE_KEY');
    expect(input.outputTail.length).toBeGreaterThan(0);
    expect(input.lastScanError).toBeTruthy();
  });

  it('error scan then reportIssue opens issues/new with diagnostics and WITHOUT the key', async () => {
    state.secrets.set('codescout.apiKey', SECRET);
    state.set('codescout.rateLimitPauses', 0);
    // скан падает ошибкой, в тексте которой есть токены-префиксы провайдеров:
    // именно они должны быть вычищены из тела issue
    globalThis.fetch = (async () => { throw new Error('provider 429 rate limit gsk_MOCKPROVIDERTOKEN42 for sk-mocktoken42'); }) as typeof fetch;
    activate(makeFakeContext() as never);
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await flush();
    expect(state.outputLines.join('\n')).toContain('Self-test error');

    await (state.commands.get('codescout.reportIssue') as () => Promise<unknown>)();
    await flush();
    expect(state.openedUris).toHaveLength(1);
    const url = String((state.openedUris[0] as { toString(): string }).toString());
    expect(url).toContain('github.com/valden2007/CodeScout/issues/new?body=');
    const body = decodeURIComponent(url.split('body=')[1]);
    expect(body).toContain('## Диагностика');
    expect(body).toContain('ключ: установлен');
    expect(body).toContain('CodeScout 1.4.0 · VS Code 1.96.0');
    expect(body).toContain('provider: auto');
    expect(body).toContain('language: ru');
    expect(body).toContain('последняя ошибка скана');
    expect(body).toContain('```text');
    // секреты: ни значение ключа, ни префиксы провайдеров
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('gsk_MOCKPROVIDERTOKEN42');
    expect(body).not.toContain('sk-mocktoken42');
    for (const prefix of ['sk-', 'gsk_', 'ghp_', 'AIza']) expect(body).not.toContain(prefix);
  });
});
