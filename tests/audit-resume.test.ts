// Батч 25: возобновление аудита другим провайдером после ЛЮБОЙ остановки.
// e2e через реальный activate()+vscode-stub: cancel → баннер с тремя кнопками,
// догон другим стеком без перепроверки checked, guard скоупа, reload окна,
// «начать заново» с подтверждением + чистые unit-хелперы auditResume/findingsStore.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { checkpointScopeVerdict, computeScopeHash, getGitHead, pickResumeTarget } from '../extension/src/auditResume';
import { collectCheckpointFindings, progressView, readAuditProgress, readAuditResults, writeAuditProgress, writeAuditResultsFromCheckpoint, type AuditCheckpoint } from '../extension/src/projectAudit';
import { mergeFindingsByZone, sameFindingZone } from '../extension/src/findingsStore';
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
  const root = mkdtempSync(join(tmpdir(), 'cs-resume-'));
  mkdirSync(join(root, 'src'));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

function modelIssue(line: number, description: string): unknown {
  return { file: 'ignored-by-parser', line, category: 'bug', severity: 'medium', description, suggestion: 'fix', code: 'const x', confidence: 80, proof: 'citation line' };
}

function checkpointIssue(file: string, line: number, description: string): ReviewIssue {
  return { file, line, category: 'bug', severity: 'medium', description, confidence: 80 };
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

function planHash(root: string, files: string[]): string {
  return computeScopeHash(getGitHead(root), files);
}

describe('Батч 25 cross-provider resume', () => {
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

  it('cancel → баннер «остановлен X из Y (provider · model)» с тремя кнопками; чекпоинт state=cancelled; reload восстанавливает баннер', async () => {
    globalThis.fetch = (async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/b.ts')) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return chatContent(body.includes('src/a.ts') ? [modelIssue(5, 'ALPHA_DESC')] : []);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    const audit = (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('✅ файл 1/3: src/a.ts')));
    await (state.commands.get('codescout.cancelScan') as () => Promise<unknown>)();
    await audit;
    await flush();

    // 1) баннер после остановки: X/Y + провайдер · модель + три кнопки
    expect(live.html()).toContain('Аудит остановлен: проверено 1 из 3 файлов');
    expect(live.html()).toContain('gemini · gemini-1.5-flash');
    expect(live.html()).toContain('находок 1');
    expect(live.html()).toContain('data-command="resumeAudit"');
    expect(live.html()).toContain('Продолжить текущими');
    expect(live.html()).toContain('data-command="resumeAuditOther"');
    expect(live.html()).toContain('Продолжить другими');
    expect(live.html()).toContain('data-command="restartAudit"');
    expect(live.html()).toContain('Начать заново');

    // 2) чекпоинт НЕ очищен: состояние cancelled + scopeHash + теги файлов
    const cp = readAuditProgress(root);
    expect(cp).toBeDefined();
    expect(cp!.state).toBe('cancelled');
    expect(cp!.scopeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(cp!.provider).toBe('gemini');
    expect(cp!.checked.map((entry) => entry.file)).toEqual(['src/a.ts']);
    expect(cp!.checked[0].provider).toBe('gemini');
    expect(cp!.checked[0].model).toBe('gemini-1.5-flash');
    expect(typeof cp!.checked[0].ts).toBe('number');
    expect(cp!.remaining.sort()).toEqual(['src/b.ts', 'src/c.ts']);

    // 3) reload окна: новая панель восстанавливает баннер и метку нахождателя
    const revived = bootPanel();
    await flush();
    expect(revived.html()).toContain('ALPHA_DESC');
    expect(revived.html()).toContain('Аудит остановлен: проверено 1 из 3 файлов');
    expect(revived.html()).toContain('data-command="resumeAuditOther"');
    expect(revived.html()).toContain('proof-source');
    expect(revived.html()).toContain('Нашла:');
  }, 60000);

  it('догон другим провайдером: checkedFiles не дёргают сеть, находки мерджатся по зонам ±3 без дублей', async () => {
    const hash = planHash(root, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const legacy: AuditCheckpoint = {
      startedAt: Date.now() - 1000,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      scopeHash: hash,
      state: 'cancelled',
      checked: [
        { file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 5, 'ALPHA_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 111 },
        { file: 'src/c.ts', issues: [], provider: 'gemini', model: 'gemini-1.5-flash', ts: 333 },
        { file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 7, 'ALPHA_ZONE_DUP')], provider: 'openai', model: 'old-model', ts: 222 }
      ],
      remaining: ['src/b.ts'],
      skipped: ['src/b.ts']
    };
    writeAuditProgress(root, legacy);

    // догон идёт другим стеком: groq · llama-mini
    state.secrets.set('codescout.provider', 'groq');
    state.secrets.set('codescout.model', 'llama-mini');
    state.secrets.set('codescout.model.userChosen', 'true');

    const chatFiles: string[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      if (body.includes('src/a.ts')) chatFiles.push('a.ts');
      if (body.includes('src/c.ts')) chatFiles.push('c.ts');
      return chatContent(body.includes('src/b.ts') ? [modelIssue(3, 'BETA_DESC')] : []);
    }) as typeof fetch;

    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.resumeAudit') as () => Promise<unknown>)();
    await flush();

    // 1) проверенные файлы не перепроверяются — запросов по ним не было
    expect(chatFiles).toEqual([]);
    // 2) смешанный провайдер залогирован
    expect(state.outputLines.some((line) => line.includes('🔀 Догон другим провайдером: было openai · old-model'))).toBe(true);
    // 3) находки: ALPHA (gemini) + BETA (groq); zone-дубликат ALPHA@7 отброшен
    expect(live.html()).toContain('ALPHA_DESC');
    expect(live.html()).toContain('BETA_DESC');
    expect(live.html()).not.toContain('ALPHA_ZONE_DUP');
    const results = readAuditResults(root);
    expect(results).toBeDefined();
    expect(results!.findings.map((f) => f.description).sort()).toEqual(['ALPHA_DESC', 'BETA_DESC']);
    const alpha = results!.findings.find((f) => f.description === 'ALPHA_DESC');
    expect(alpha!.foundBy).toEqual({ provider: 'gemini', model: 'gemini-1.5-flash' });
    const beta = results!.findings.find((f) => f.description === 'BETA_DESC');
    expect(beta!.foundBy).toEqual({ provider: 'groq', model: 'llama-mini' });
    // метки нахождателей видны в proof-блоках карточек
    expect(live.html()).toContain('gemini · gemini-1.5-flash');
    expect(live.html()).toContain('groq · llama-mini');
    // чистое завершение догона — чекпоинт удалён, баннера нет
    expect(existsSync(join(root, '.codescout', 'audit-progress.json'))).toBe(false);
    expect(live.html()).not.toContain('data-command="resumeAuditOther"');
  }, 60000);

  it('guard скоупа: новый файл после остановки — догон заблокирован, сеть не дёргается, баннер «Скоуп изменился»', async () => {
    const hash = planHash(root, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    writeAuditProgress(root, {
      startedAt: Date.now() - 1000,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      scopeHash: hash,
      state: 'cancelled',
      checked: [{ file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 5, 'ALPHA_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 1 }],
      remaining: ['src/b.ts', 'src/c.ts']
    });
    writeAuditResultsFromCheckpoint(root, readAuditProgress(root)!, 3);
    // скоуп изменился: добавился файл d.ts
    writeFileSync(join(root, 'src', 'd.ts'), 'export const d = 1;\n', 'utf8');

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
    expect(live.html()).toContain('Новый аудит');
    expect(live.html()).toContain('data-command="scanFull"');
    expect(live.html()).toContain('data-command="restartAudit"');
    expect(live.html()).not.toContain('data-command="resumeAudit"');
    expect(state.outputLines.some((line) => line.includes('⛔ Скоуп изменился после остановки'))).toBe(true);
    // чекпоинт не тронут (старый hash всё ещё там)
    const cp = readAuditProgress(root);
    expect(cp!.scopeHash).toBe(hash);
  }, 60000);

  it('«Начать заново»: без подтверждения — чекпоинт цел; с подтверждением — очищен и создан заново пустым', async () => {
    const hash = planHash(root, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const cp: AuditCheckpoint = {
      startedAt: Date.now() - 1000,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      scopeHash: hash,
      state: 'cancelled',
      checked: [{ file: 'src/a.ts', issues: [checkpointIssue('src/a.ts', 5, 'ALPHA_DESC')], provider: 'gemini', model: 'gemini-1.5-flash', ts: 1 }],
      remaining: ['src/b.ts', 'src/c.ts']
    };
    writeAuditProgress(root, cp);
    writeAuditResultsFromCheckpoint(root, cp, 3);
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      throw new Error('offline after restart');
    }) as typeof fetch;

    bootPanel();
    await flush();

    // отказ от подтверждения — ничего не удалено
    state.warningAnswers.push(undefined);
    await (state.commands.get('codescout.restartAudit') as () => Promise<unknown>)();
    await flush();
    expect(readAuditProgress(root)!.checked).toHaveLength(1);
    expect(readAuditResults(root)!.findings.map((f) => f.description)).toEqual(['ALPHA_DESC']);

    // подтверждение — прогресс и результаты стёрты, свежий запуск пуст
    state.warningAnswers.push('Удалить и начать заново');
    const live = bootPanel();
    await flush();
    await (state.commands.get('codescout.restartAudit') as () => Promise<unknown>)();
    await flush();
    const fresh = readAuditProgress(root);
    expect(fresh!.checked).toHaveLength(0);
    expect(fresh!.scopeHash).toBe(hash);
    expect(readAuditResults(root)!.findings).toEqual([]);
    expect(live.html()).not.toContain('ALPHA_DESC');
  }, 60000);

  it('pickResumeTarget: QuickPick провайдер → живые модели → persist; отмена и отсутствие ключа — без изменений', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'plain-model' }, { id: 'super-coder-9' }] }), { status: 200 });
      throw new Error('unexpected chat');
    }) as typeof fetch;
    const persisted: Array<{ provider: string; model: string }> = [];
    const deps = {
      lang: 'ru' as const,
      resolveKeyFor: async () => 'gsk_test_key',
      resolveBaseUrlFor: async () => 'https://api.groq.com/openai/v1',
      persistSelection: async (provider: string, model: string) => { persisted.push({ provider, model }); },
      log: () => {}
    };
    state.quickPickAnswers.push('groq', 'super-coder-9');
    const picked = await pickResumeTarget(deps);
    expect(picked).toEqual({ provider: 'groq', model: 'super-coder-9' });
    expect(persisted).toEqual([{ provider: 'groq', model: 'super-coder-9' }]);
    // preferred (coder/instruct) идёт первым в списке моделей
    const secondPickItems = state.quickPickCalls[1][0] as string[];
    expect(secondPickItems[0]).toBe('super-coder-9');

    // отмена выбора провайдера = возврат без действия
    state.quickPickCalls.length = 0;
    state.quickPickAnswers.length = 0;
    const cancelled = await pickResumeTarget(deps);
    expect(cancelled).toBeUndefined();
    expect(persisted).toHaveLength(1);

    // без ключа и не localhost — честная ошибка, меню моделей не открывается
    state.quickPickAnswers.push('openai');
    const noKey = await pickResumeTarget({ ...deps, resolveKeyFor: async () => undefined, resolveBaseUrlFor: async () => 'https://api.openai.com/v1' });
    expect(noKey).toBeUndefined();
    expect(state.errorMessages.join('\n')).toContain('Сначала сохрани API-ключ');
  }, 60000);
});

describe('Батч 25 unit: scopeHash, verdict, zone-merge', () => {
  it('computeScopeHash стабилен по порядку/дублям и чувствителен к HEAD и составу файлов', () => {
    const a = computeScopeHash('abc123', ['src/b.ts', 'src/a.ts']);
    const b = computeScopeHash('abc123', ['src/a.ts', 'src/b.ts', 'src/a.ts']);
    expect(a).toBe(b);
    expect(a).not.toBe(computeScopeHash('abc124', ['src/a.ts', 'src/b.ts']));
    expect(a).not.toBe(computeScopeHash('abc123', ['src/a.ts', 'src/b.ts', 'src/c.ts']));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // слеши нормализуются в слэши
    expect(computeScopeHash('h', ['src\\a.ts'])).toBe(computeScopeHash('h', ['src/a.ts']));
  });

  it('getGitHead возвращает "" вне git-репозитория (не падает)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-nogit-'));
    try {
      expect(getGitHead(root)).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checkpointScopeVerdict: ok / changed / untracked для legacy без hash', () => {
    expect(checkpointScopeVerdict({ scopeHash: 'aaa' }, 'aaa')).toBe('ok');
    expect(checkpointScopeVerdict({ scopeHash: 'aaa' }, 'bbb')).toBe('changed');
    expect(checkpointScopeVerdict({}, 'bbb')).toBe('untracked');
    expect(checkpointScopeVerdict(undefined, 'bbb')).toBe('untracked');
  });

  it('sameFindingZone/mergeFindingsByZone: файл+severity+category с допуском ±3', () => {
    const base = checkpointIssue('src/a.ts', 5, 'D1');
    expect(sameFindingZone(base, { ...base, line: 2 })).toBe(true);
    expect(sameFindingZone(base, { ...base, line: 8 })).toBe(true);
    expect(sameFindingZone(base, { ...base, line: 9 })).toBe(false);
    expect(sameFindingZone(base, { ...base, line: 5, severity: 'high' })).toBe(false);
    expect(sameFindingZone(base, { ...base, line: 5, category: 'docs' })).toBe(false);
    expect(sameFindingZone(base, { ...base, line: 5, file: 'src/A.ts' })).toBe(true);
    const merged = mergeFindingsByZone(
      [base],
      [
        { ...base, line: 7, description: 'zone-dup' },
        { ...base, line: 20, description: 'far' },
        { ...base, line: 5, severity: 'high', description: 'sev-diff' },
        { ...base, line: 5, file: 'src/b.ts', description: 'other-file' }
      ]
    );
    expect(merged.map((issue) => issue.description)).toEqual(['D1', 'far', 'sev-diff', 'other-file']);
  });

  it('collectCheckpointFindings: метки foundBy из записей, fallback на provider чекпоинта, zone-мердж', () => {
    const cp: AuditCheckpoint = {
      startedAt: 1,
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      checked: [
        { file: 'a.ts', issues: [checkpointIssue('a.ts', 5, 'D1')], provider: 'groq', model: 'llama', ts: 1 },
        { file: 'a.ts', issues: [checkpointIssue('a.ts', 7, 'D1-DUP')], provider: 'openai', model: 'gpt', ts: 2 },
        { file: 'b.ts', issues: [checkpointIssue('b.ts', 3, 'D2')], ts: 3 }
      ],
      remaining: []
    };
    const found = collectCheckpointFindings(cp);
    expect(found.map((issue) => issue.description)).toEqual(['D1', 'D2']);
    expect(found[0].foundBy).toEqual({ provider: 'groq', model: 'llama' });
    expect(found[1].foundBy).toEqual({ provider: 'gemini', model: 'gemini-1.5-flash' });
  });

  it('readAuditProgress: legacy-чекпоинт читается без новых полей, теги и state round-trip сохраняются', () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-cp-'));
    try {
      writeAuditProgress(root, { startedAt: 1, model: 'm', checked: [{ file: 'a.ts', issues: [] }], remaining: ['b.ts'] } as AuditCheckpoint);
      expect(Object.keys(readAuditProgress(root)!).sort()).toEqual(['checked', 'model', 'remaining', 'startedAt']);
      const tagged: AuditCheckpoint = { startedAt: 2, model: 'm2', provider: 'groq', scopeHash: 'deadbeefdeadbeef', state: 'cancelled', checked: [{ file: 'a.ts', issues: [], provider: 'groq', model: 'm2', ts: 7 }], remaining: [], skipped: ['x.ts'] };
      writeAuditProgress(root, tagged);
      const back = readAuditProgress(root)!;
      expect(back.provider).toBe('groq');
      expect(back.scopeHash).toBe('deadbeefdeadbeef');
      expect(back.state).toBe('cancelled');
      expect(back.checked[0]).toEqual({ file: 'a.ts', issues: [], provider: 'groq', model: 'm2', ts: 7 });
      expect(back.skipped).toEqual(['x.ts']);
      expect(progressView(back)).toEqual({ done: 1, total: 1, model: 'm2', provider: 'groq', startedAt: 2, findings: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('EN-рендер баннеров батча 25 без кириллицы', () => {
    const stats = { files: 1, seconds: 1, critical: 0, medium: 1, low: 0 };
    const stopped = buildReportHtml([], stats, false, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', { done: 12, total: 40, model: 'llama-3.3', provider: 'groq', startedAt: 1, findings: 3 }, undefined, false, 0, 0, undefined, 'n', undefined, 'en');
    expect(stopped).toContain('Audit stopped: checked 12 of 40 files (groq · llama-3.3)');
    expect(stopped).toContain('Continue with current');
    expect(stopped).toContain('Continue with other');
    expect(stopped).not.toMatch(/[\u0400-\u04FF]/);
    const blocked = buildReportHtml([], stats, false, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', { done: 12, total: 40, model: 'llama-3.3', provider: 'groq', startedAt: 1, scopeMismatch: true }, undefined, false, 0, 0, undefined, 'n', undefined, 'en');
    expect(blocked).toContain('Scope changed after stop');
    expect(blocked).toContain('New audit');
    expect(blocked).not.toMatch(/[\u0400-\u04FF]/);
  });
});
