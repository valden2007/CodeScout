import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { auditResultsPath, readAuditResults, writeAuditResultsFromCheckpoint } from '../extension/src/projectAudit';

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

function bootPanel(): { html: () => string } {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const { view } = createView();
  provider.resolveWebviewView(view);
  return { html: () => view.webview.html };
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-results-'));
  mkdirSync(join(root, 'src'));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

function issueFor(file: string, desc: string): string {
  const payload = JSON.stringify({ issues: [{ file: `src/${file}`, line: 1, code: 'const x', category: 'bug', severity: 'medium', description: desc, suggestion: 'fix', confidence: 0.8 }], summary: 'ok' });
  return JSON.stringify({ choices: [{ message: { content: payload } }] });
}

describe('v1.4b-15 персистентные частичные результаты аудита', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = makeWorkspace();
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'AIzaTEST123456');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('после каждого файла пишется частичный отчёт; рестарт VS Code рисует находки + баннер; «начать заново» с подтверждением чистит', async () => {
    // c.ts «падает» не-ретриабельной ошибкой → скипается → аудит прерван на 2/3
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/c.ts')) throw new Error('upstream exploded');
      if (body.includes('src/a.ts')) return new Response(issueFor('a.ts', 'ALPHA_DESC'), { status: 200 });
      return new Response(issueFor('b.ts', 'BETA_DESC'), { status: 200 });
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();

    // 1) файл на диске = то, что видит панель живьём
    const results = readAuditResults(root);
    expect(results).toBeDefined();
    expect(results!.findings.map((f) => f.description).sort()).toEqual(['ALPHA_DESC', 'BETA_DESC']);
    expect(results!.checkedFiles).toBe(2);
    expect(results!.total).toBe(3);
    expect(existsSync(auditResultsPath(root))).toBe(true);
    expect(live.html()).toContain('ALPHA_DESC');

    // 2) рестарт VS Code в середине прерванного аудита: новая панель рисует ЭТИ находки + баннер с кнопками
    const revived = bootPanel();
    await flush();
    expect(revived.html()).toContain('ALPHA_DESC');
    expect(revived.html()).toContain('BETA_DESC');
    expect(revived.html()).toContain('Аудит оборвался');
    expect(revived.html()).toContain('находок 2');
    expect(revived.html()).toContain('data-command="resumeAudit"');
    expect(revived.html()).toContain('data-command="restartAudit"');
    expect(revived.html()).toContain('Продолжить (2 из 3)');
    // находки на диске и в панели совпадают посимвольно (тот же source of truth)
    for (const finding of results!.findings) expect(revived.html()).toContain(finding.description);

    // 3) «Начать заново» без подтверждения — ничего не трогает
    state.warningAnswers.push(undefined);
    await (state.commands.get('codescout.restartAudit') as () => Promise<unknown>)();
    await flush();
    expect(readAuditResults(root)!.findings.map((f) => f.description).sort()).toEqual(['ALPHA_DESC', 'BETA_DESC']);
    expect(existsSync(join(root, '.codescout', 'audit-progress.json'))).toBe(true);

    // 4) с подтверждением — прогресс и СТАРЫЕ результаты стёрты; перезапуск
    // создал свежий пустой чекпоинт/отчёт (0 находок вместо 2)
    state.warningAnswers.push('Удалить и начать заново');
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('offline after restart');
    }) as typeof fetch;
    await (state.commands.get('codescout.restartAudit') as () => Promise<unknown>)();
    await flush();
    const afterRestart = readAuditResults(root);
    expect(afterRestart).toBeDefined();
    expect(afterRestart!.findings).toEqual([]);
    expect(afterRestart!.checkedFiles).toBe(0);
    const after = bootPanel();
    await flush();
    expect(after.html()).not.toContain('ALPHA_DESC');
    expect(after.html()).not.toContain('BETA_DESC');
  }, 60000);

  it('writeAuditResultsFromCheckpoint атомарен: temp+rename, без мусора, перечитывается 1-в-1', () => {
    const checkpoint = {
      startedAt: 1,
      model: 'gemini-2.5-flash',
      checked: [
        { file: 'src/a.ts', issues: [{ file: 'src/a.ts', line: 3, category: 'bug' as const, severity: 'high' as const, description: 'D1', code: 'x', suggestion: 'y', confidence: 0.9 }] },
        { file: 'src/b.ts', issues: [{ file: 'src/b.ts', line: 5, category: 'security' as const, severity: 'critical' as const, description: 'D2', code: 'k', suggestion: 's', confidence: 0.95 }] }
      ],
      remaining: ['src/c.ts']
    };
    writeAuditResultsFromCheckpoint(root, checkpoint, 3);
    const file = readFileSync(auditResultsPath(root), 'utf8');
    expect(file).toContain('D1');
    expect(file).toContain('D2');
    expect(readdirSync(join(root, '.codescout')).some((name) => name.endsWith('.tmp'))).toBe(false);
    const back = readAuditResults(root);
    expect(back!.findings.map((f) => f.description)).toEqual(['D1', 'D2']);
    expect(back!.checkedFiles).toBe(2);
    expect(back!.total).toBe(3);
    expect(back!.model).toBe('gemini-2.5-flash');
  });

  it('исходники: атомарная запись через temp+rename, flush после каждого файла, финальный отчёт = единый источник', () => {
    const source = readFileSync('extension/src/projectAudit.ts', 'utf8');
    expect(source).toContain('const temp = join(directory, `${fileName}.${process.pid}.tmp`)');
    expect(source).toContain('writeFileSync(temp,');
    expect(source).toContain('renameSync(temp, target)');
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    const pStart = extension.indexOf('const persist = ()');
    const pEnd = extension.indexOf('persist();', pStart);
    const persistBlock = extension.slice(pStart, pEnd);
    expect(persistBlock).toContain('writeAuditResultsFromCheckpoint(workspaceRoot, state, planFiles.length)');
    expect(extension).toContain('writeAuditResults(workspaceRoot, { findings: mergedIssues');
    expect(extension).toContain('await vscode.window.showWarningMessage(t(\'restart.confirm\', lang), { modal: true }, t(\'restart.confirmBtn\', lang))');
    expect(extension).toContain('clearAuditResults(root)');
    const panel = readFileSync('extension/src/panel.ts', 'utf8');
    expect(panel).toContain('restoreAuditResults(issues: ReviewIssue[], stats: ReportStats, resume: AuditResumeView | undefined)');
  });

  it('баннер EN не содержит кириллицы и печатает findings count', async () => {
    const { buildReportHtml } = await import('../extension/src/reportHtml');
    const html = buildReportHtml([], { files: 2, seconds: 1, critical: 0, medium: 2, low: 0 }, false, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', { done: 35, total: 42, model: 'groq/x', startedAt: 1, findings: 7 }, undefined, false, 0, 0, undefined, 'n1', undefined, 'en');
    expect(html).toContain('Audit interrupted');
    expect(html).toContain('· 7 findings');
    expect(html).not.toMatch(/[\u0400-\u04FF]/);
  });
});
