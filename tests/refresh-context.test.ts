import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';

describe('Center refresh context click', () => {
  let root: string;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'cs-refresh-'));
    mkdirSync(join(root, '.codescout'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['en', 'ru'] as const)('clears actual files and stale panel state, rejects an active scan (%s)', async (lang) => {
    const { state, flush, makeFakeContext, StubWebview } = await import('./vscode-stub');
    const { activate } = await import('../extension/src/extension');
    const { writeAuditProgress, writeAuditResultsFromCheckpoint } = await import('../extension/src/projectAudit');
    const { t } = await import('../src/i18n');
    state.reset();
    state.workspaceRoot = root;
    state.set('codescout.language', lang);
    state.set('codescout.showAuditBanner', false);
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.secrets.set('codescout.model', 'test-model');
    const checkpoint = {
      startedAt: 1, model: 'test-model',
      checked: [{ file: 'a.ts', issues: [{ file: 'a.ts', line: 1, category: 'bug' as const, severity: 'medium' as const, description: 'STALE_FINDING', code: 'a', suggestion: 'fix', confidence: 0.9 }] }],
      remaining: ['b.ts']
    };
    writeAuditProgress(root, checkpoint);
    writeAuditResultsFromCheckpoint(root, checkpoint, 2);
    writeFileSync(join(root, '.codescout', 'context.json'), '{}');
    writeFileSync(join(root, '.codescout', 'rules.md'), 'keep rules');
    const files = ['audit-progress.json', 'audit-results.json', 'context.json'].map((name) => join(root, '.codescout', name));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    activate(makeFakeContext() as never);
    const webview = new StubWebview();
    const panel = state.providers.get('codescout.panel') as { resolveWebviewView(view: unknown): void };
    panel.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }) });
    await flush();
    expect(webview.html).toContain('STALE_FINDING');
    expect(webview.html).toContain('data-command="resumeAudit"');
    await state.commands.get('codescout.openSettingsPage')!('sec-project');
    const center = state.panels[0];
    expect(center.webview.html).toMatch(/id="refreshContext"[^>]*>.*codicon-refresh/);
    expect(center.webview.html).toContain(t('project.refreshContext', lang));
    // Execute the actual rendered click binding, then deliver its message to the host.
    let click: () => void = () => { throw new Error('missing click binding'); };
    const binding = center.webview.html.match(/document\.getElementById\('refreshContext'\)\.addEventListener\('click', .*?\);/)![0];
    runInNewContext(binding, {
      document: { getElementById: () => ({ addEventListener: (_: string, cb: () => void) => { click = cb; } }) },
      vscode: { postMessage: (message: never) => center.webview.onMessageHandlers.forEach((handler) => handler(message)) }
    });
    click();
    await flush();
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(root, '.codescout', 'rules.md'), 'utf8')).toBe('keep rules');
    expect(center.webview.html).toContain(t('project.contextCleared', lang));
    expect(webview.html).not.toContain('STALE_FINDING');
    expect(webview.html).not.toContain('data-command="resumeAudit"');
    expect(webview.html).not.toContain('data-command="restartAudit"');

    // Preflight itself is busy, before the first transport request is sent.
    const scan = state.commands.get('codescout.scanFull')!() as Promise<void>;
    click();
    await flush();
    expect(center.webview.html).toContain(t('project.contextBusy', lang));
    await state.commands.get('codescout.cancelScan')!();
    await scan;
    click();
    await flush();
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(center.webview.html).toContain(t('project.contextCleared', lang));
  });
});
