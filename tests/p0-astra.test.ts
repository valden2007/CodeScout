// Батч 12 — P0-блокеры из Astra-ревью перед релизом.
// e2e через реальный activate() + vscode-stub, как в scan-sync/globe.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';

const realFetch = globalThis.fetch;

function makeView() {
  return {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: { toString(): string }) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => {} })
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
}

function boot() {
  activate(makeFakeContext() as never);
  return state.providers.get('codescout.panel') as { resolveWebviewView: (view: unknown) => void };
}

const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

async function waitFor(check: () => boolean, timeoutMs = 20000, stepMs = 50): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor: timeout; output tail: ${state.outputLines.slice(-12).join(' | ')}`);
    await new Promise((resolveDone) => setTimeout(resolveDone, stepMs));
  }
}

describe('P0 Astra-1: workspace trust для baseUrl', () => {
  let root = '';
  let reviewCalled = false;
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-trust-'));
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
    reviewCalled = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      reviewCalled = true;
      return okResponse();
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const files = [{ filename: 'src/a.ts', status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new\n' }];

  it('workspace baseUrl в untrusted workspace: ключ не уходит — ошибка', async () => {
    state.setWorkspace('codescout.baseUrl', 'https://mock.test/v1');
    state.setTrusted(false);
    await expect(reviewFiles(makeFakeContext() as never, files, root, () => {})).rejects.toThrow(/не доверенная/);
    expect(reviewCalled).toBe(false);
  });

  it('workspace baseUrl, отказ в подтверждении: ключ не уходит', async () => {
    state.setWorkspace('codescout.baseUrl', 'https://mock.test/v1');
    state.setTrusted(true);
    state.warningAnswers.push(null);
    await expect(reviewFiles(makeFakeContext() as never, files, root, () => {})).rejects.toThrow(/не подтверждён/);
    expect(reviewCalled).toBe(false);
  });

  it('workspace baseUrl, подтверждение: ключ уходит, доверие запоминается', async () => {
    state.setWorkspace('codescout.baseUrl', 'https://mock.test/v1');
    state.setTrusted(true);
    state.warningAnswers.push('Доверять');
    const result = await reviewFiles(makeFakeContext() as never, files, root, () => {});
    expect(reviewCalled).toBe(true);
    expect(result.issues).toEqual([]);
    // доверие сохранено в globalState — повторный прогон не спрашивает
    state.warningAnswers.push(null);
    await reviewFiles(makeFakeContext() as never, files, root, () => {});
    expect(reviewCalled).toBe(true);
  });

  it('user-settings baseUrl (не workspace): работает как раньше, без подтверждения', async () => {
    state.set('codescout.baseUrl', 'https://mock.test/v1');
    state.setTrusted(false);
    const result = await reviewFiles(makeFakeContext() as never, files, root, () => {});
    expect(reviewCalled).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('P0 Astra-2: Стоп не должен ломать следующие обычные ревью', () => {
  let root = '';
  let reviewCalled = false;
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-stopstart-'));
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
    try {
      execSync('git init -q', { cwd: root });
      writeFileSync(join(root, 'f.ts'), 'export const a = 1;\n', 'utf8');
      execSync('git add -A', { cwd: root });
      execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: root });
    } catch { /* git может быть недоступен — тест ниже это учтёт */ }
    reviewCalled = false;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('cancel → runReview(lastCommit) реально бежит (не silent no-op)', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      reviewCalled = true;
      return okResponse();
    }) as typeof fetch;

    const provider = boot();
    provider.resolveWebviewView(makeView());

    // Стоп ставит autoResumeCancelled и abort
    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await flush();

    // обычное ревью последнего коммита должно пойти, а не быть no-op
    await (state.commands.get('codescout.scanLastCommit') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('Итог проверки коммита')));
    expect(reviewCalled).toBe(true);
  }, 60000);
});

describe('P0 Astra-3: выбор модели меняет только модель', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-model-'));
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.secrets.set('codescout.model', 'gemini-2.5-flash');
    state.secrets.set('codescout.model.userChosen', 'true');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function fetchMock(): { reviewCalled: boolean } {
    const captured = { reviewCalled: false };
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'gemini-2.5-flash' }, { id: 'm2' }] }), { status: 200 });
      captured.reviewCalled = true;
      return okResponse();
    }) as typeof fetch;
    return captured;
  }

  it('отмена QuickPick: модель прежняя, запрос ревью не отправляется', async () => {
    const captured = fetchMock();
    const provider = boot();
    provider.resolveWebviewView(makeView());

    // showQuickPick возвращает undefined (отмена)
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();

    expect(state.secrets.get('codescout.model')).toBe('gemini-2.5-flash');
    expect(state.secrets.get('codescout.model.userChosen')).toBe('true');
    expect(captured.reviewCalled).toBe(false);
  });

  it('выбор модели: меняется ТОЛЬКО модель, запрос ревью НЕ уходит', async () => {
    const captured = fetchMock();
    const provider = boot();
    provider.resolveWebviewView(makeView());

    // пользователь выбирает 'm2' — модель должна смениться
    state.quickPickAnswers.push('m2');
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();

    expect(state.secrets.get('codescout.model')).toBe('m2');
    expect(state.secrets.get('codescout.model.userChosen')).toBe('true');
    // выбор модели НЕ запускает скан
    expect(captured.reviewCalled).toBe(false);
  });
});
