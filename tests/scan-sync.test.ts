import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  return state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
}

function makeWorkspace(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-sync-'));
  mkdirSync(join(root, 'src'));
  for (let i = 0; i < fileCount; i++) writeFileSync(join(root, 'src', `f${i}.ts`), Array.from({ length: 8 }, (_, n) => `export const v${n} = ${n};`).join('\n') + '\n', 'utf8');
  return root;
}

const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

async function waitFor(check: () => boolean, timeoutMs = 20000, stepMs = 50): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor: timeout; output tail: ${state.outputLines.slice(-12).join(' | ')}`);
    await new Promise((resolveDone) => setTimeout(resolveDone, stepMs));
  }
}

describe('v1.4b-16 синхрон состояния скана', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = makeWorkspace(2);
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'AIzaTESTKEY98765');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
    state.set('codescout.autoResume', true);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('авто-догон: панель в скан-режиме (Стоп есть, «остановлено» и resume-баннера нет); стоп убивает догон; resume не оставляет баннера', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('B.AI: 429 Too Many Requests');
    }) as typeof fetch;

    const provider = boot();
    const view = createView();
    provider.resolveWebviewView(view);

    const auditPromise = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    // ждём, пока попытка #1 проскочится и хост уйдёт в паузу авто-догона (Output-строка)
    await waitFor(() => state.outputLines.some((line) => line.includes('_resume через')));

    // пауза авто-догона идёт — панель ОБЯЗАНА быть в скан-режиме
    expect(auditPromise).toBeDefined();
    expect(view.webview.html).toContain('data-command="cancelScan"');
    expect(view.webview.html).toContain('Остановить');
    expect(view.webview.html).toContain('id="progressLine"');
    expect(view.webview.html).not.toContain('Сканирование остановлено');
    expect(view.webview.html).not.toContain('data-command="resumeAudit"');

    // «Стоп» из этого состояния убивает и авто-догон
    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await flush();
    await auditPromise;
    expect(view.webview.html).toContain('Сканирование остановлено');
    expect(existsSync(join(root, '.codescout', 'audit-progress.json'))).toBe(true);

    // resume после стопа: скан-режим без «остановлено», по завершении — чистый отчёт
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return okResponse();
    }) as typeof fetch;
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();
    expect(view.webview.html).not.toContain('Сканирование остановлено');
    expect(view.webview.html).not.toContain('data-command="cancelScan"');
  }, 60000);

  it('живой скан: повторный resolve рисует скан-UI, restoreAuditResults игнорируется', async () => {
    let release!: () => void;
    const hang = new Promise<never>((_resolve, reject) => {
      release = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      init?.signal?.addEventListener('abort', () => release());
      return hang;
    }) as typeof fetch;

    const provider = boot();
    const first = createView();
    provider.resolveWebviewView(first);
    const scanPromise = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // «activate при живом скане» — новая вкладка панели сразу в скан-режиме
    const second = createView();
    provider.resolveWebviewView(second);
    expect(second.webview.html).toContain('data-command="cancelScan"');

    // рестору нечего делать, пока хост сканирует
    (provider as unknown as { restoreAuditResults: (i: unknown, s: unknown, r: unknown) => void }).restoreAuditResults(
      [{ file: 'src/f0.ts', line: 1, category: 'bug', severity: 'high', description: 'SHOULD-NOT-APPEAR', confidence: 0.9 }],
      { files: 1, seconds: 1, critical: 1, medium: 0, low: 0 },
      undefined
    );
    expect(second.webview.html).not.toContain('SHOULD-NOT-APPEAR');
    expect(second.webview.html).toContain('data-command="cancelScan"');

    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await scanPromise;
    expect(second.webview.html).toContain('Сканирование остановлено');
  }, 60000);
});
