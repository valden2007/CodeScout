// Батч 28, раздел 1: умный догон — пер-файловые SHA-256 хэши в чекпоинте.
// Unit: fileContentHash/checkpointHasFileHashes/reconcileCheckedHashes
// (хэш совпал → kept; не совпал → requeued; новый → requeued; вне скоупа →
// dropped). e2e через реальный activate()+vscode-stub: догон перепроверяет
// ТОЛЬКО изменённые/новые файлы, находки совпавших сохраняются, удалённые
// из скоупа файлы теряют findings; жёлтый баннер «Скоуп изменился»; legacy
// чекпоинт без хэшей по-прежнему даёт КРАСНЫЙ баннер и блок догона.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { computeScopeHash, getGitHead } from '../extension/src/auditResume';
import { checkpointHasFileHashes, collectCheckpointFindings, fileContentHash, hashAuditFile, readAuditProgress, readAuditResults, reconcileCheckedHashes, writeAuditProgress, writeAuditResultsFromCheckpoint, type AuditCheckpoint } from '../extension/src/projectAudit';
import { buildReportHtml } from '../extension/src/reportHtml';
import type { ReviewIssue } from '../src/types';

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

function createView(): { view: CapturedView } {
  const view: CapturedView = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (cb) => { void cb; return { dispose: () => {} }; }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  return { view };
}

function bootPanel(): { html: () => string } {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const { view } = createView();
  provider.resolveWebviewView(view);
  return { html: () => view.webview.html };
}

function writeFile(root: string, name: string, content: string): void {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-b28-'));
  writeFile(root, 'src/a.ts', 'export const a = 1;\n');
  writeFile(root, 'src/b.ts', 'export const b = 2;\n');
  writeFile(root, 'src/c.ts', 'export const c = 3;\n');
  return root;
}

function checkpointIssue(file: string, line: number, description: string): ReviewIssue {
  return { file, line, category: 'bug', severity: 'medium', description, confidence: 80 };
}

function modelIssue(line: number, description: string): unknown {
  return { file: 'ignored-by-parser', line, category: 'bug', severity: 'medium', description, suggestion: 'fix', code: 'const x', confidence: 80, proof: 'citation line' };
}

function chatContent(issues: unknown[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues, summary: 'ok' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function waitFor(check: () => boolean, timeoutMs = 20000, stepMs = 50): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor: timeout; output tail: ${state.outputLines.slice(-12).join(' | ')}`);
    await new Promise((resolveDone) => setTimeout(resolveDone, stepMs));
  }
}

describe('батч 28 unit: пер-файловые хэши и reconcile', () => {
  it('fileContentHash = SHA-256 hex содержимого; hashAuditFile читает с диска, удалённый = ""', () => {
    const root = makeWorkspace();
    try {
      const content = 'export const a = 1;\n';
      expect(fileContentHash(content)).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
      expect(hashAuditFile(root, 'src/a.ts')).toBe(fileContentHash(content));
      expect(hashAuditFile(root, 'src/missing.ts')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checkpointHasFileHashes: legacy без hash → false; все с hash → true; пустой checked → true', () => {
    const legacy: AuditCheckpoint = { startedAt: 1, model: 'm', checked: [{ file: 'a.ts', issues: [] }], remaining: [] };
    expect(checkpointHasFileHashes(legacy)).toBe(false);
    const modern: AuditCheckpoint = { startedAt: 1, model: 'm', checked: [{ file: 'a.ts', issues: [], hash: 'f'.repeat(64) }], remaining: [] };
    expect(checkpointHasFileHashes(modern)).toBe(true);
    expect(checkpointHasFileHashes({ checked: [] })).toBe(true);
    const partial: AuditCheckpoint = { startedAt: 1, model: 'm', checked: [{ file: 'a.ts', issues: [], hash: 'f'.repeat(64) }, { file: 'b.ts', issues: [] }], remaining: [] };
    expect(checkpointHasFileHashes(partial)).toBe(false);
  });

  it('collectCheckpointFindings: метка foundBy.key из записи чекпоинта уходит в находку', () => {
    const cp: AuditCheckpoint = {
      startedAt: 1,
      model: 'm',
      provider: 'groq',
      checked: [{ file: 'a.ts', issues: [checkpointIssue('a.ts', 1, 'ALPHA')], provider: 'groq', model: 'llama', profile: 'Alpha', key: 'ключ-2', hash: 'a'.repeat(64) }],
      remaining: []
    };
    const merged = collectCheckpointFindings(cp);
    expect(merged[0].foundBy).toEqual({ provider: 'groq', model: 'llama', profile: 'Alpha', key: 'ключ-2' });
  });

  it('reconcileCheckedHashes: совпал → kept; не совпал → requeued; новый → requeued; вне скоупа → dropped', () => {
    const hashA = 'a'.repeat(64);
    const hashC = 'c'.repeat(64);
    const progress: AuditCheckpoint = {
      startedAt: 1,
      model: 'm',
      checked: [
        { file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 5, 'ALPHA')], hash: hashA },
        { file: 'src/b.ts', issues: [checkpointIssue('src/b.ts', 3, 'BETA_OLD')], hash: 'b'.repeat(64) },
        { file: 'src/c.ts', issues: [], hash: hashC },
        { file: 'src/gone.ts', issues: [checkpointIssue('src/gone.ts', 1, 'GONE')], hash: 'g'.repeat(64) }
      ],
      remaining: []
    };
    // скоуп: a (не менялся), b (изменён), c (не менялся), d (новый); gone.ts удалён
    const plan = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const currentHashes: Record<string, string> = { 'src/a.ts': hashA, 'src/b.ts': 'BB'.repeat(32), 'src/c.ts': hashC, 'src/d.ts': 'd'.repeat(64) };
    const rec = reconcileCheckedHashes(progress, plan, (file) => currentHashes[file] ?? '');
    expect(rec.kept.map((entry) => entry.file)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(rec.keptFindings).toBe(1);
    expect(rec.requeued).toEqual(['src/b.ts', 'src/d.ts']);
    expect(rec.dropped).toEqual(['src/gone.ts']);
  });
});

describe('батч 28 e2e: умный догон после смены скоупа', () => {
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

  function hashTrackedCheckpoint(): AuditCheckpoint {
    const plan = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    return {
      startedAt: Date.now() - 1000,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      scopeHash: computeScopeHash(getGitHead(root), plan),
      state: 'cancelled',
      checked: [
        { file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 1, 'ALPHA_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 1, hash: hashAuditFile(root, 'src/a.ts') },
        { file: 'src/b.ts', issues: [checkpointIssue('src/b.ts', 1, 'BETA_OLD_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 2, hash: 'f'.repeat(64) },
        { file: 'src/c.ts', issues: [], provider: 'gemini', model: 'gemini-1.5-flash', ts: 3, hash: hashAuditFile(root, 'src/c.ts') }
      ],
      remaining: []
    };
  }

  it('хэш файла изменился + новый файл → в догон ушли ТОЛЬКО они; совпавшие находки сохранены; жёлтый баннер', async () => {
    writeAuditProgress(root, hashTrackedCheckpoint());
    writeAuditResultsFromCheckpoint(root, readAuditProgress(root)!, 3);
    // содержимое b.ts изменилось, d.ts — новый файл скоупа
    writeFile(root, 'src/b.ts', 'export const b = 999; // edited\n');
    writeFile(root, 'src/d.ts', 'export const d = 4;\n');

    const chatFiles: string[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/b.ts')) { chatFiles.push('src/b.ts'); return chatContent([modelIssue(1, 'BETA_NEW_DESC')]); }
      if (body.includes('src/d.ts')) { chatFiles.push('src/d.ts'); return chatContent([modelIssue(1, 'DELTA_DESC')]); }
      chatFiles.push('UNEXPECTED');
      return chatContent([]);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();

    // 1) сеть дёрнулась ТОЛЬКО для изменённого и нового файла
    expect(chatFiles.sort()).toEqual(['src/b.ts', 'src/d.ts']);
    // 2) a.ts не перепроверялся: его находка цела; старая находка b удалена, новая на месте
    const html = live.html();
    expect(html).toContain('ALPHA_DESC');
    expect(html).toContain('BETA_NEW_DESC');
    expect(html).toContain('DELTA_DESC');
    expect(html).not.toContain('BETA_OLD_DESC');
    // 3) Output-строка догона + жёлтый счётчик
    expect(state.outputLines.some((line) => line.includes('🟡 Скоуп изменился: 2 файлов обновлено') && line.includes('1 результатов сохранено'))).toBe(true);
    // 4) результаты: 3 находки, 4 файла в чекпоинте итога
    const results = readAuditResults(root);
    expect(results).toBeDefined();
    expect(results!.findings.map((f) => f.description).sort()).toEqual(['ALPHA_DESC', 'BETA_NEW_DESC', 'DELTA_DESC']);
    expect(results!.checkedFiles).toBe(4);
    expect(results!.total).toBe(4);
  }, 60000);

  it('файл удалён из скоупа → его findings выпадают из результатов догона', async () => {
    const cp = hashTrackedCheckpoint();
    // c.ts содержал находку и исчез из скоупа
    cp.checked[2].issues = [checkpointIssue('src/c.ts', 1, 'GAMMA_DESC')];
    writeAuditProgress(root, cp);
    writeAuditResultsFromCheckpoint(root, readAuditProgress(root)!, 3);
    unlinkSync(join(root, 'src', 'c.ts'));

    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return chatContent([]);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();

    const html = live.html();
    expect(html).toContain('ALPHA_DESC');
    expect(html).not.toContain('GAMMA_DESC');
    const results = readAuditResults(root);
    expect(results!.findings.map((f) => f.description)).toEqual(['ALPHA_DESC']);
  }, 60000);

  it('хэши совпали, scopeHash не менялся → ни одного запроса к сети кроме плана, findings целы', async () => {
    writeAuditProgress(root, hashTrackedCheckpoint());
    writeAuditResultsFromCheckpoint(root, readAuditProgress(root)!, 3);

    let chatRequests = 0;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatRequests += 1;
      return chatContent([]);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    // scopeHash чекпоинта = план из трёх неизменённых файлов → verdict 'ok',
    // reconcile не нужен: весь checked остаётся, в очередь догона ничего не попадает.
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();
    expect(chatRequests).toBe(0);
    expect(live.html()).toContain('ALPHA_DESC');
    expect(state.outputLines.some((line) => line.includes('🟡'))).toBe(false);
  }, 60000);

  it('legacy чекпоинт БЕЗ хэшей + изменённый скоуп → по-прежнему КРАСНЫЙ баннер, сеть не дёргается', async () => {
    const plan = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const legacy: AuditCheckpoint = {
      startedAt: Date.now() - 1000,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      scopeHash: computeScopeHash(getGitHead(root), plan),
      state: 'cancelled',
      checked: [{ file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 1, 'ALPHA_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 1 }],
      remaining: ['src/b.ts', 'src/c.ts']
    };
    expect(checkpointHasFileHashes(legacy)).toBe(false);
    writeAuditProgress(root, legacy);
    writeAuditResultsFromCheckpoint(root, legacy, 3);
    writeFile(root, 'src/d.ts', 'export const d = 4;\n');

    let chatRequests = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatRequests += 1;
      return chatContent([]);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();

    expect(chatRequests).toBe(0);
    expect(live.html()).toContain('Скоуп изменился после остановки — догон некорректен');
    expect(live.html()).toContain('data-command="scanFull"');
    // красный legacy-баннер: жёлтой полосы умного догона быть не должно
    // (CSS-класс scope-update есть в стилях всегда — сверяем разметку)
    expect(live.html()).not.toContain('class="audit-resume scope-update"');
  }, 60000);

  it('«Начать заново» очищает checkedFiles (с хэшами) полностью', async () => {
    writeAuditProgress(root, hashTrackedCheckpoint());
    writeAuditResultsFromCheckpoint(root, readAuditProgress(root)!, 3);
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('offline after restart');
    }) as typeof fetch;
    bootPanel();
    await flush();
    state.warningAnswers.push('Удалить и начать заново');
    await (state.commands.get('codescout.restartAudit') as () => Promise<unknown>)();
    await flush();
    const fresh = readAuditProgress(root);
    expect(fresh!.checked).toHaveLength(0);
    expect(readAuditResults(root)).toBeUndefined();
  }, 60000);
});

describe('батч 28 unit: жёлтый баннер в разметке панели', () => {
  const stats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
  const resumeView = { done: 3, total: 7, model: 'gemini-1.5-flash', startedAt: 1, findings: 3, scopeUpdate: { files: 2, findings: 5 } };

  it('RU: текст «Скоуп изменился: N файлов обновлены… M результатов сохранено» + class scope-update', () => {
    const base = [stats, false, true, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', resumeView, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const html = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, undefined);
    expect(html).toContain('class="audit-resume scope-update"');
    expect(html).toContain('Скоуп изменился: 2 файлов обновлены — догон перепроверит их, 5 результатов сохранено');
  });

  it('жёлтая полоса видна и во время живого скана догона (в отличие от экшен-баннера)', () => {
    const base = [stats, true, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', resumeView, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const html = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, undefined);
    expect(html).toContain('scope-update');
    expect(html).not.toContain('data-command="resumeAudit"'); // экшен-баннер скрыт во время скана
  });

  it('EN-рендер без кириллицы', () => {
    const base = [stats, false, true, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', resumeView, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const en = buildReportHtml([], ...base, 'en', {}, '', undefined, undefined, undefined);
    expect(en).toContain('Scope changed: 2 files updated');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });
});
