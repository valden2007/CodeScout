// Минимальный мок модуля 'vscode' для e2e-тестов хоста (panel/extension) под vitest.
// Aliases настраиваются в vitest.config.ts. Никакой безопасности тут не нужно —
// это тестовая песочница, код расширения вызывается напрямую.

export interface StubConfigEntry {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

type ConfigListener = (event: { affectsConfiguration: (needle: string) => boolean }) => void;

class StubState {
  config = new Map<string, StubConfigEntry>();
  configListeners: ConfigListener[] = [];
  commands = new Map<string, (...args: unknown[]) => unknown>();
  providers = new Map<string, unknown>();
  panels: StubWebviewPanel[] = [];
  secrets = new Map<string, string>();
  outputLines: string[] = [];

  reset(): void {
    this.config.clear();
    this.configListeners = [];
    this.commands.clear();
    this.providers.clear();
    this.panels = [];
    this.secrets.clear();
    this.outputLines = [];
  }

  set(sectionKey: string, value: unknown): void {
    const entry = this.config.get(sectionKey) ?? {};
    entry.globalValue = value;
    this.config.set(sectionKey, entry);
  }

  fire(section: string, key: string): void {
    const changed = `${section}.${key}`;
    for (const listener of this.configListeners) {
      listener({ affectsConfiguration: (needle: string) => changed === needle || changed.startsWith(`${needle}.`) || needle === section });
    }
  }
}

export const state = new StubState();

export function flush(): Promise<void> {
  return new Promise((resolveDone) => setTimeout(resolveDone, 0));
}

class UriClass {
  constructor(public readonly scheme: string, public readonly path: string) {}
  static file(fsPath: string): UriClass { return new UriClass('file', fsPath); }
  static parse(value: string): UriClass { return new UriClass('https', value); }
  static joinPath(base: UriClass, ...segments: string[]): UriClass { return new UriClass(base.scheme, [base.path, ...segments].join('/')); }
  get fsPath(): string { return this.path; }
  toString(): string { return `${this.scheme}://${this.path}`; }
}
export const Uri = UriClass;

class Position { constructor(public line: number, public character: number) {} }
class Range { constructor(public start: Position, public end: Position) {} }
class Selection extends Range {}

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => {}) {}
  dispose(): void { this.callOnDispose(); }
}

const noopDisposable = (): Disposable => new Disposable();

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    state.commands.set(id, handler);
    return noopDisposable();
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = state.commands.get(id);
    if (!handler) throw new Error(`command not found: ${id}`);
    return await handler(...args);
  }
};

export const window = {
  activeTextEditor: undefined as unknown,
  createOutputChannel(): unknown {
    return { appendLine: (line: string) => state.outputLines.push(line), clear: () => {}, show: () => {}, dispose: () => {} };
  },
  registerWebviewViewProvider(viewId: string, provider: unknown): Disposable {
    state.providers.set(viewId, provider);
    return noopDisposable();
  },
  createWebviewPanel(viewType: string, title: string): StubWebviewPanel {
    const panel = new StubWebviewPanel(viewType, title);
    state.panels.push(panel);
    return panel;
  },
  async showErrorMessage(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showInformationMessage(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showWarningMessage(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showInputBox(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showQuickPick(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showOpenDialog(..._args: unknown[]): Promise<undefined> { return undefined; },
  async showTextDocument(): Promise<unknown> { return {}; }
};

export class StubWebview {
  html = '';
  messages: Record<string, unknown>[] = [];
  cspSource = 'vscode-webview://test';
  onMessageHandlers: ((message: never) => void)[] = [];
  asWebviewUri(uri: UriClass): UriClass { return uri; }
  async postMessage(message: Record<string, unknown>): Promise<boolean> { this.messages.push(message); return true; }
  onDidReceiveMessage(cb: (message: never) => void): { dispose(): void } { this.onMessageHandlers.push(cb); return { dispose: () => {} }; }
}

export class StubWebviewPanel {
  webview = new StubWebview();
  title = '';
  disposed = false;
  constructor(public viewType: string, title: string) { this.title = title; }
  onDidDispose(): Disposable { return noopDisposable(); }
  reveal(): void {}
  dispose(): void { this.disposed = true; }
}

export const workspace = {
  workspaceFolders: undefined as unknown,
  getWorkspaceFolder(): undefined { return undefined; },
  getConfiguration(section: string): unknown {
    return {
      get(key: string, fallback?: unknown): unknown {
        const entry = state.config.get(`${section}.${key}`);
        const value = entry?.globalValue ?? entry?.workspaceValue;
        return value === undefined ? fallback : value;
      },
      inspect(key: string): StubConfigEntry | undefined { return state.config.get(`${section}.${key}`); },
      async update(key: string, value: unknown): Promise<void> {
        const sectionKey = `${section}.${key}`;
        if (value === undefined) state.config.delete(sectionKey);
        else state.set(sectionKey, value);
        state.fire(section, key);
      }
    };
  },
  onDidChangeConfiguration(listener: ConfigListener): Disposable {
    state.configListeners.push(listener);
    return noopDisposable();
  },
  async openTextDocument(): Promise<unknown> { return { lineCount: 5 }; },
  fs: { async stat(): Promise<{ type: number }> { return { type: 1 }; } }
};

export const env = { async openExternal(): Promise<boolean> { return true; } };

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
export { Position, Range, Selection };

export function makeFakeContext(extensionFolder = '/tmp/ext'): unknown {
  return {
    extensionUri: new Uri('file', extensionFolder),
    extensionPath: extensionFolder,
    subscriptions: { push: (..._items: unknown[]): number => 0 },
    secrets: {
      async get(key: string): Promise<string | undefined> { return state.secrets.get(key); },
      async store(key: string, value: string): Promise<void> { state.secrets.set(key, value); },
      async delete(key: string): Promise<void> { state.secrets.delete(key); }
    },
    extension: { packageJSON: { version: '1.4.0' } }
  };
}
