import { describe, expect, it, beforeEach } from 'vitest';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';

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

const CYRILLIC = /[\u0400-\u04FF]/;

function createView(): { view: CapturedView; receive: (message: unknown) => void } {
  let handler: (message: unknown) => void = () => {};
  const view: CapturedView = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (cb) => { handler = cb as (message: unknown) => void; return { dispose: () => {} }; }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  return { view, receive: (message) => handler(message) };
}

function activateAndResolve() {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const { view, receive } = createView();
  provider.resolveWebviewView(view);
  return { view, receive };
}

describe('v1.4b-11 globe click e2e (mock webview → host → config → re-render)', () => {
  beforeEach(() => { state.reset(); });

  it('click on the globe switches language to en and re-renders BOTH panel and center', async () => {
    const { view, receive } = activateAndResolve();
    expect(view.webview.html).toContain('Полный аудит проекта');

    receive({ command: 'openSettingsPage' });
    await flush();
    const center = state.panels[0];
    expect(center.webview.html).toContain('Язык интерфейса, отчётов и ответов модели');

    receive({ command: 'toggleLanguage' });
    await flush();
    expect(state.config.get('codescout.language')?.globalValue).toBe('en');
    expect(view.webview.html).toContain('Full project audit');
    expect(view.webview.html).not.toMatch(CYRILLIC);
    expect(center.webview.html).toContain('Interface, reports and model answers language');
    expect(center.webview.html).not.toMatch(CYRILLIC);

    receive({ command: 'toggleLanguage' });
    await flush();
    expect(state.config.get('codescout.language')?.globalValue).toBe('ru');
    expect(view.webview.html).toContain('Полный аудит проекта');
    expect(center.webview.html).toContain('Язык интерфейса, отчётов и ответов модели');
  });

  it('first run: welcome card renders and dismissOnboarding hides it via globalState', async () => {
    const { view, receive } = activateAndResolve();
    expect(view.webview.html).toContain('Первый запуск CodeScout');
    expect(view.webview.html).toContain('data-command="openSettingsPage" data-anchor="sec-key"');
    expect(view.webview.html).toContain('data-command="dismissOnboarding"');

    receive({ command: 'dismissOnboarding' });
    await flush();
    expect(state.globalState.get('codescout.onboardingDismissed')).toBe(true);
    expect(view.webview.html).not.toContain('Первый запуск CodeScout');
    expect(view.webview.html).toContain('data-command="scanLastCommit"');
  });
});
