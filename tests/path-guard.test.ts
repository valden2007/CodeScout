import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, Uri } from './vscode-stub';
import { CodeScoutPanel } from '../extension/src/panel';

function createView(): { view: unknown; receive: (message: unknown) => void; html: () => string } {
  let handler: (message: unknown) => void = () => {};
  let html = '';
  const view = {
    webview: {
      get html() { return html; },
      set html(value: string) { html = value; },
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: { toString(): string }) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (cb: (message: unknown) => void) => { handler = cb; return { dispose: () => {} }; }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  return { view, receive: (message) => handler(message), html: () => html };
}

function symlinksAvailable(): boolean {
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.COMPUTERNAME); //尽力: на Windows без privileges бросит — тест пропускаем
}

describe('батч9: panel openFile path traversal', () => {
  let root = '';
  let outside = '';
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-root-'));
    outside = mkdtempSync(join(tmpdir(), 'cs-outside-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'x\n', 'utf8');
    writeFileSync(join(outside, 'secret.ts'), 'top secret\n', 'utf8');
    state.workspaceRoot = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function mountPanel() {
    const panel = new CodeScoutPanel(Uri.file(root) as never);
    const { view, receive, html } = createView();
    panel.resolveWebviewView(view as never);
    return { receive, html };
  }

  it('абсолютный путь отклоняется (posix + windows drive), документ не открывается', async () => {
    const { receive } = mountPanel();
    receive({ command: 'openFile', file: '/etc/passwd', line: 1 });
    receive({ command: 'openFile', file: 'C:\\Windows\\win.ini', line: 1 });
    receive({ command: 'openFile', file: '\\\\server\\share\\x.ts', line: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.openedDocuments).toEqual([]);
    expect(state.errorMessages.length).toBe(3);
  });

  it('..-побег отклоняется, внутренний нормализованный путь разрешается', async () => {
    const { receive } = mountPanel();
    receive({ command: 'openFile', file: '../secret.ts', line: 1 });
    receive({ command: 'openFile', file: 'src/../../outside/secret.ts', line: 2 });
    receive({ command: 'openFile', file: 'src/../src/a.ts', line: 1 }); // остаётся внутри — ок
    await new Promise((r) => setTimeout(r, 0));
    expect(state.errorMessages.length).toBe(2);
    expect(state.openedDocuments).toHaveLength(1);
    expect(state.openedDocuments[0].replaceAll('\\', '/')).toContain('cs-root-');
    expect(state.openedDocuments[0].replaceAll('\\', '/')).toContain('/src/a.ts');
  });

  it('симлинк из workspace наружу блокируется после realpath (если симлинки доступны)', async () => {
    let created = false;
    try {
      symlinkSync(join(outside, 'secret.ts'), join(root, 'link.ts'));
      created = true;
    } catch {
      created = false;
    }
    if (!created || !symlinksAvailable()) return;
    const { receive } = mountPanel();
    receive({ command: 'openFile', file: 'link.ts', line: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.openedDocuments).toEqual([]);
    expect(state.errorMessages.length).toBe(1);
  });

  it('исходник: guard вызывается ДО resolve/realpath и сравнение префикса с учётом регистра ОС', () => {
    const source = readFileSync('extension/src/panel.ts', 'utf8');
    const guardAt = source.indexOf('if (!isWorkspaceRelativePath(message.file))');
    const resolveAt = source.indexOf('const candidate = resolve(root.uri.fsPath, message.file)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(resolveAt);
    expect(source).toContain('const outsideWorkspace = inside === \'\' || inside.startsWith(\'..\') || isAbsolute(inside) || !pathInsideRoot(realRoot, realCandidate)');
    expect(source).toContain('process.platform === \'win32\' || process.platform === \'darwin\'');
  });
});
