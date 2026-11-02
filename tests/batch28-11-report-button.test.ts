// МИКРО-БАТЧ 28.11, задача 3: кнопка «Открыть отчёт» в режиме «Аудит завершён».
// ROOT CAUSE «молчания»: клик долетал до обработчика codescout.openAuditReport,
// но тот делал только output.show() + focus на ТОТ ЖЕ сайдбар, где живёт кнопка,
// — новой видимой поверхности не появлялось, а await focus-команды при отказе
// улетал молча (void/unhandled rejection). Фикс: клик открывает webview полного
// отчёта (reportHtml.ts: находки, группировка, proof, динамика) в редакторе.
// Тест через stub-webview: клик шлёт правильное сообщение, панель создаётся,
// show()/reveal() вызван; сообщения из вкладки маршрутизируются (регресс
// интерактива 28.1).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

function bootPanel(): { html: () => string; receive: (message: unknown) => void } {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
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
  provider.resolveWebviewView(view);
  return { html: () => view.webview.html, receive: (message) => handler(message) };
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-b2811btn-'));
  mkdirSync(join(root, 'src'));
  for (const name of ['a.ts', 'b.ts']) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

function modelResponse(description: string): string {
  return JSON.stringify({ issues: [{ line: 1, category: 'bug', severity: 'medium', description, proof: 'export const v0 = 0;', confidence: 80 }], summary: 'ok' });
}

function response(description: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: modelResponse(description) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('микробатч 28.11 задача 3: вкладка полного отчёта по кнопке', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = makeWorkspace();
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('«Аудит завершён» → клик по кнопке шлёт openReport → вкладка отчёта открыта и показана', async () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('ALPHA_FINDING_TEXT');
    }) as typeof fetch;

    const { html, receive } = bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // режим «Аудит завершён»: карточка итога с кнопкой openReport есть в панели
    expect(html()).toContain('Аудит завершён');
    expect(html()).toContain('data-command="openReport"');
    expect(html()).toContain('data-command="openFullReport"');
    expect(html()).toContain('title="Открыть отчёт"');
    // сам webview-скрипт шлёт data-command как команду хосту (контракт 28.1)
    expect(html()).toContain("vscode.postMessage({ command: element.dataset.command");

    const revealsBefore = state.panelReveals;
    const showsBefore = state.outputShows;
    receive({ command: 'openReport' });
    await flush();

    // 1) открылась webview-вкладка полного отчёта
    const tab = state.panels.find((p) => p.viewType === 'codescout.report');
    expect(tab, 'codescout.report panel должен быть создан').toBeDefined();
    // 2) показана: show()/reveal() вызваны + Output.show() как текстовый дамп
    expect(state.panelReveals).toBeGreaterThan(revealsBefore);
    expect(state.outputShows).toBeGreaterThan(showsBefore);
    // 3) содержимое — полный отчёт: находки, группировка по файлам, proof, карточка итога
    const tabHtml = tab!.webview.html;
    expect(tabHtml).toContain('ALPHA_FINDING_TEXT');
    expect(tabHtml).toContain('src/a.ts');
    expect(tabHtml).toContain('<details class="proof"><summary>');
    expect(tabHtml).toContain('summary-card');
    // 4) вкладка интерактивна (регресс 28.1): скрипт + подписка хоста на сообщения
    expect(tabHtml).toContain('acquireVsCodeApi()');
    expect(tab!.webview.onMessageHandlers.length).toBeGreaterThan(0);

    // 5) повторный клик НЕ множит вкладки, только показывает существующую
    const panelsBefore = state.panels.length;
    receive({ command: 'openReport' });
    await flush();
    expect(state.panels.filter((p) => p.viewType === 'codescout.report')).toHaveLength(1);
    expect(state.panels.length).toBe(panelsBefore);
    expect(state.panelReveals).toBeGreaterThan(revealsBefore + 1);
  }, 120000);

  it('клик ВНУТРИ вкладки маршрутизируется как в панели (interactivity регресс); динамика второго аудита попадает во вкладку', async () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('DIFF_RUN_ONE');
    }) as typeof fetch;

    bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    const tab = state.panels.find((p) => p.viewType === 'codescout.report');
    expect(tab).toBeUndefined(); // сама не открывается — только по кнопке

    state.commands.get('codescout.openAuditReport')!();
    await flush();
    const opened = state.panels.find((p) => p.viewType === 'codescout.report')!;
    expect(opened.webview.html).toContain('DIFF_RUN_ONE');

    // клик ВНУТРИ вкладки маршрутизируется как в панели (interactivity регресс)
    (opened.webview.onMessageHandlers[0] as unknown as (message: unknown) => void)({ command: 'toggleLanguage' });
    await flush();
    expect(state.config.get('codescout.language')?.globalValue ?? state.config.get('codescout.language')?.workspaceValue).toBe('en');

    // второй аудит с изменившейся находкой: динамика «новых/починено/осталось»
    // обновляет и вкладку (render() синхронизирует оба surfaces)
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('DIFF_RUN_TWO');
    }) as typeof fetch;
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    const finalTab = state.panels.filter((p) => p.viewType === 'codescout.report');
    expect(finalTab).toHaveLength(1);
    expect(finalTab[0]!.webview.html).toContain('DIFF_RUN_TWO');
    expect(finalTab[0]!.webview.html).not.toContain('DIFF_RUN_ONE');
    // полоска динамики против прошлого аудита
    expect(finalTab[0]!.webview.html).toContain('diff-summary');
  }, 120000);

  it('контракт исходников: ветка openReport в панели + вызов openReportTab из команды', () => {
    const panelSource = readFileSync('extension/src/panel.ts', 'utf8');
    expect(panelSource).toContain("message.command === 'openReport'");
    expect(panelSource).toContain('openReportTab(): void');
    expect(panelSource).toContain("'codescout.report'");
    const extensionSource = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extensionSource).toContain("registerCommand('codescout.openAuditReport'");
    expect(extensionSource).toContain('panel.openReportTab()');
    expect(extensionSource).toContain("output.show(true)");
  });

  it('после reload last-good карточка с подписанными кнопками восстанавливается и открывает ту же вкладку', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('PERSISTED_REPORT_FINDING');
    }) as typeof fetch;
    bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    const revived = bootPanel();
    await flush();
    expect(revived.html()).toContain('PERSISTED_REPORT_FINDING');
    expect(revived.html()).toContain('<div class="summary-card">');
    expect(revived.html()).toContain('<span>Открыть отчёт</span>');
    expect(revived.html()).toContain('<span>Запустить снова</span>');
    expect(revived.html()).toContain('data-command="openFullReport"');
    expect(revived.html()).toContain('Находок: 2 · Файлов: 2 · Время:');

    revived.receive({ command: 'openReport' });
    await flush();
    expect(state.panels.filter((p) => p.viewType === 'codescout.report')).toHaveLength(1);
    expect(state.panels[0]!.webview.html).toContain('PERSISTED_REPORT_FINDING');

    await (state.commands.get('codescout.openFullReport') as () => Promise<unknown>)();
    await flush();
    expect(state.panels.filter((p) => p.viewType === 'codescout.report')).toHaveLength(1);
    expect(state.panels[0]!.webview.html).toContain('PERSISTED_REPORT_FINDING');
    const panelsBefore = state.panels.length;
    await (state.commands.get('codescout.openFullReport') as () => Promise<unknown>)();
    expect(state.panels.filter((p) => p.viewType === 'codescout.report')).toHaveLength(1);
    expect(state.panels).toHaveLength(panelsBefore);
    expect(state.panels[0]!.revealCalls).toBeGreaterThan(1);
    const manifest = JSON.parse(readFileSync('extension/package.json', 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(manifest.contributes.commands).toContainEqual({ command: 'codescout.openFullReport', title: 'CodeScout: Open Full Report' });
  }, 120000);

  it('само-тест показывает ту же карточку под зелёным баннером «Ревьюер жив!»', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const payload = JSON.stringify({ issues: [
        { line: 3, category: 'bug', severity: 'medium', description: 'SAMPLE_ONE', confidence: 80 },
        { line: 8, category: 'security', severity: 'high', description: 'SAMPLE_TWO', confidence: 90 },
        { line: 13, category: 'bug', severity: 'low', description: 'SAMPLE_THREE', confidence: 75 }
      ], summary: 'ok' });
      return new Response(JSON.stringify({ choices: [{ message: { content: payload } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const panel = bootPanel();
    await flush();
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await flush();
    const html = panel.html();
    expect(html).toContain('Ревьюер жив!');
    expect(html).toContain('<div class="summary-card">');
    expect(html).toContain('<span>Открыть отчёт</span>');
    expect(html).toContain('<span>Запустить снова</span>');
    expect(html.indexOf('Ревьюер жив!')).toBeLessThan(html.indexOf('<div class="summary-card">'));
  }, 120000);

  it('пустой diff сохраняет карточку последнего полного аудита с датой и моделью; отчётная вкладка открывает last-good', async () => {
    writeFileSync(join(root, '.gitignore'), '.codescout/\n', 'utf8');
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'codescout-test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'CodeScout Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('FULL_AUDIT_LAST_GOOD');
    }) as typeof fetch;
    const panel = bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(panel.html()).toContain('FULL_AUDIT_LAST_GOOD');

    // Полный чистый аудит заменяет текущий результат, но не удаляет доступ
    // к последнему непустому completed audit.
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('');
    }) as typeof fetch;
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(panel.html()).toContain('<strong>0 issues</strong>');
    expect(panel.html()).toMatch(/Полный аудит от .+ · gemini-1\.5-flash/);

    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('пустой diff не должен отправляться модели');
    }) as typeof fetch;
    execFileSync('git', ['commit', '--allow-empty', '-m', 'empty diff'], { cwd: root, stdio: 'ignore' });
    await (state.commands.get('codescout.scanLastCommit') as () => Promise<unknown>)();
    await flush();
    const html = panel.html();
    expect(html).toContain('<div class="summary-card">');
    expect(html).toMatch(/Полный аудит от .+ · gemini-1\.5-flash/);
    expect(html).toContain('data-command="openFullReport"');
    expect(html).toContain('title="Открыть отчёт"');
    expect(html).not.toContain('FULL_AUDIT_LAST_GOOD');
    expect(html).toContain('<strong>0 issues</strong>');
    expect(state.outputLines.join('\n')).toContain('Итог проверки коммита: 0 находок');
    panel.receive({ command: 'openFullReport' });
    await flush();
    expect(state.panels.filter((p) => p.viewType === 'codescout.report')).toHaveLength(1);
    expect(state.panels[0]!.webview.html).toContain('FULL_AUDIT_LAST_GOOD');
  }, 120000);

  it('пустой отчёт не показывает постоянную кнопку полного отчёта', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return response('');
    }) as typeof fetch;
    const panel = bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    expect(panel.html()).not.toContain('data-command="openFullReport"');
  }, 120000);
});
