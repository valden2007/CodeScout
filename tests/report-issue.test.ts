import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';

const SECRET = 'AIzaSYNTHETICMODELKEY0123456789';

describe('v1.4b-13 reportIssue e2e (mock key must never leak)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('error scan then reportIssue opens issues/new with diagnostics and WITHOUT the key', async () => {
    state.secrets.set('codescout.apiKey', SECRET);
    activate(makeFakeContext() as never);
    // Реальный путь ошибки скана: нет workspace → reviewWorkspace бросает
    // panel.errNoGit → lastScanError + хвост Output заполняются сами.
    await (state.commands.get('codescout.scanUncommitted') as () => Promise<unknown>)();
    await flush();
    expect(state.outputLines.join('\n')).toContain('Error:');

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
    for (const prefix of ['sk-', 'gsk_', 'ghp_', 'AIza']) expect(body).not.toContain(prefix);
  });
});
