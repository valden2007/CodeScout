import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';

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

function createView(): CapturedView {
  return {
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
}

function boot() {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const view = createView();
  provider.resolveWebviewView(view);
  return view;
}

function makeWorkspace(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-cancel-'));
  mkdirSync(join(root, 'src'));
  for (const name of names) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

async function waitFor(check: () => boolean, timeoutMs = 30000, stepMs = 25): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor: timeout; output tail: ${state.outputLines.slice(-12).join(' | ')}`);
    await new Promise((resolveDone) => setTimeout(resolveDone, stepMs));
  }
}

const issueResponse = (file: string, desc: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues: [{ file, line: 1, category: 'bug', severity: 'medium', description: desc, suggestion: 'fix', confidence: 80 }], summary: 'ok' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('батч 26: немедленный баннер догона после cancel/стоп', () => {
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

  it('«Остановить» в скане: баннер + три кнопки + красная карточка ВЫШЕ, без reload; reload восстанавливает баннер', async () => {
    root = makeWorkspace(['a.ts', 'b.ts', 'c.ts']);
    state.workspaceRoot = root;
    globalThis.fetch = (async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/a.ts')) return issueResponse('src/a.ts', 'ALPHA_DESC');
      // b/c «висят» до abort — как медленный ответ провайдера
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }) as typeof fetch;

    const view = boot();
    const scanPromise = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('готово') && line.includes('src/a.ts')));

    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await scanPromise;
    await flush();

    const html = view.webview.html;
    // карточка «Сканирование остановлено пользователем» остаётся ВЫШЕ баннера, не вместо него
    const cardIndex = html.indexOf('Сканирование остановлено пользователем');
    const bannerIndex = html.indexOf('Аудит остановлен: проверено 1 из 3 файлов');
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBeGreaterThan(cardIndex);
    expect(html).toContain('data-command="resumeAudit"');
    expect(html).toContain('data-command="resumeAuditOther"');
    expect(html).toContain('data-command="restartAudit"');
    expect(html).toContain('Продолжить текущими');
    expect(html).toContain('Продолжить другими…');
    expect(html).toContain('Начать заново');

    // чекпоинт на диске помечен cancelled и НЕ удалён
    const checkpoint = JSON.parse(readFileSync(join(root, '.codescout', 'audit-progress.json'), 'utf8')) as { state?: string; checked: unknown[] };
    expect(checkpoint.state).toBe('cancelled');
    expect(checkpoint.checked.length).toBe(1);

    // reload (вторая активация на том же workspace) — баннер восстанавливается
    const revived = boot();
    await waitFor(() => revived.webview.html.includes('Аудит остановлен: проверено 1 из 3 файлов'));
    expect(revived.webview.html).toContain('data-command="resumeAuditOther"');
    expect(revived.webview.html).toContain('ALPHA_DESC');
  }, 60000);

  it('«Стоп» в паузе авто-догона: баннер с тремя кнопками без reload (0 проверено — тоже баннер)', async () => {
    root = makeWorkspace(['a.ts', 'b.ts']);
    state.workspaceRoot = root;
    state.set('codescout.autoResume', true);
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('B.AI: 429 Too Many Requests');
    }) as typeof fetch;

    const view = boot();
    const scanPromise = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('_resume через')));

    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await flush();
    await scanPromise;
    await flush();

    const html = view.webview.html;
    expect(html).toContain('Сканирование остановлено пользователем');
    expect(html).toContain('Аудит остановлен: проверено 0 из 2 файлов');
    expect(html).toContain('data-command="resumeAudit"');
    expect(html).toContain('data-command="resumeAuditOther"');
    expect(html).toContain('data-command="restartAudit"');
  }, 60000);
});
