// Батч 20b: ядро доверия — proof + confidence 0..100, бейджи по числовому
// порогу, подавление ложных срабатываний. e2e через реальный activate() +
// CodeScoutPanel на vscode-stub (как path-guard).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { state, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { CodeScoutPanel } from '../extension/src/panel';
import { computeFingerprint, filterSuppressed, getSuppressed, suppress, type SuppressedEntry } from '../extension/src/findingsStore';
import { parseReviewResponse } from '../src/response-parser';
import { SYSTEM_PROMPT } from '../src/prompt-builder';
import { buildEmptyReportHtml, buildReportHtml } from '../extension/src/reportHtml';
import { ReviewIssue } from '../src/types';

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

const stats = { files: 2, seconds: 1.5, critical: 0, medium: 2, low: 0 };

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return { file: 'src/a.ts', line: 10, category: 'bug', severity: 'medium', description: 'd', confidence: 70, ...overrides };
}

function reportWith(issues: ReviewIssue[], lang: 'ru' | 'en' = 'ru', suppressed?: SuppressedEntry[]): string {
  return buildReportHtml(issues, stats, false, false, '', 'retry', 'k', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, lang, {}, '', undefined, suppressed);
}

const entry = (overrides: Partial<SuppressedEntry>): SuppressedEntry => ({ id: 'fp-1', file: 'src/a.ts', line: 10, severity: 'medium', category: 'bug', description: 'Hidden finding', hiddenAt: 5, ...overrides });

describe('батч 20b: вкладка «Скрытые находки»', () => {
  it('список скрытых рендерится с кнопкой «Вернуть» и data-action', () => {
    const html = reportWith([issue({ description: 'VISIBLE' })], 'ru', [entry({ id: 'fp-alpha' }), entry({ id: 'fp-beta', file: '', description: '' })]);
    expect(html).toContain('Скрытые находки (2)');
    expect(html).toContain('data-command="unsuppressFinding"');
    expect(html).toContain('data-action="restore"');
    expect(html).toContain('data-fingerprint="fp-alpha"');
    expect(html).toContain('Вернуть');
    expect(html).toContain('codicon-arrow-left');
    // пустое описание у второй записи — фолбэк «старая версия»
    expect(html).toContain('Запись подавления из старой версии');
  });

  it('кнопка подавления несёт data-action=suppress и fingerprint', () => {
    const html = reportWith([issue({ description: 'CARD', line: 10 })]);
    expect(html).toContain('data-action="suppress"');
    expect(html).toContain(`data-fingerprint="${computeFingerprint(issue({ line: 10 }))}"`);
  });

  it('EN-версия вкладки без кириллицы', () => {
    const html = reportWith([issue({ description: 'CARD' })], 'en', [entry({ file: 'src/a.ts', description: 'Proofless' })]);
    expect(html).toContain('Hidden findings (1)');
    expect(html).toContain('Restore');
    expect(html).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('пустой список — вкладки нет', () => {
    expect(reportWith([issue()], 'ru', [])).not.toContain('Скрытые находки');
    expect(reportWith([issue()])).not.toContain('unsuppressFinding');
  });
});


function mementoOf(context: unknown) {
  return (context as { workspaceState: never }).workspaceState;
}

describe('батч 20b: промпт требует proof (строку) и confidence 0..100', () => {
  it('в системном промпте объявлены proof-строка и целая шкала уверенности', () => {
    expect(SYSTEM_PROMPT).toContain('"proof":"string"');
    expect(SYSTEM_PROMPT).toContain('"confidence":0');
    expect(SYSTEM_PROMPT).toContain('INTEGER from 0 to 100');
    expect(SYSTEM_PROMPT).toContain('empty string');
    expect(SYSTEM_PROMPT).toContain('at least 90');
    expect(SYSTEM_PROMPT).not.toContain('confidenceLevel');
  });
});

describe('батч 20b: парсер — clamping confidence и proof', () => {
  it('отсутствие/мусор confidence = 50, proof = пустая строка', () => {
    const missing = parseReviewResponse('{"issues":[{"line":4,"category":"bug","severity":"medium","description":"No fields"}],"summary":"ok"}', 'src/a.ts');
    expect(missing.issues[0].confidence).toBe(50);
    expect(missing.issues[0].proof).toBe('');
    const junk = parseReviewResponse('{"issues":[{"line":4,"description":"Junk","confidence":"very sure"}]}', 'src/a.ts');
    expect(junk.issues[0].confidence).toBe(50);
    const nanish = parseReviewResponse('{"issues":[{"line":4,"description":"NaN","confidence":null}]}', 'src/a.ts');
    expect(nanish.issues[0].confidence).toBe(50);
  });

  it('confidence клампится в 0..100 и округляется до целого', () => {
    const high = parseReviewResponse('{"issues":[{"line":4,"description":"over","confidence":150}]}', 'src/a.ts');
    expect(high.issues[0].confidence).toBe(100);
    const negative = parseReviewResponse('{"issues":[{"line":4,"description":"under","confidence":-20}]}', 'src/a.ts');
    expect(negative.issues[0].confidence).toBe(0);
    const float = parseReviewResponse('{"issues":[{"line":4,"description":"round","confidence":76.4}]}', 'src/a.ts');
    expect(float.issues[0].confidence).toBe(76);
    const zero = parseReviewResponse('{"issues":[{"line":4,"description":"zero","confidence":0}]}', 'src/a.ts');
    expect(zero.issues[0].confidence).toBe(0);
  });

  it('proof читается строкой, мусор не роняет разбор, длина ограничена', () => {
    const ok = parseReviewResponse(JSON.stringify({ issues: [{ line: 4, description: 'NPE', proof: 'Line 12: session.user used without null check' }] }), 'src/a.ts');
    expect(ok.issues[0].proof).toBe('Line 12: session.user used without null check');
    const objProof = parseReviewResponse('{"issues":[{"line":4,"description":"x","proof":{"condition":"old shape"}}]}', 'src/b.ts');
    expect(objProof.issues[0].proof).toBe('');
    const longProof = parseReviewResponse(JSON.stringify({ issues: [{ line: 4, description: 'y', proof: 'p'.repeat(5000) }] }), 'src/b.ts');
    expect(longProof.issues[0].proof).toHaveLength(1000);
  });

  it('critical при confidence < 90 понижается до medium, при 90 остаётся', () => {
    const weak = parseReviewResponse('{"issues":[{"line":4,"category":"bug","severity":"critical","description":"Maybe unsafe","confidence":89}]}', 'src/app.ts');
    expect(weak.issues[0].severity).toBe('medium');
    const strong = parseReviewResponse('{"issues":[{"line":4,"category":"security","severity":"critical","description":"Real exploit","confidence":90,"proof":"hardcoded key"}]}', 'src/app.ts');
    expect(strong.issues[0].severity).toBe('critical');
    expect(strong.issues[0].proof).toBe('hardcoded key');
  });
});

describe('батч 20b: плашки уверенности и доказательство в UI', () => {
  it('confidence >= 70 → зелёная плашка с процентом, < 70 → жёлтая', () => {
    const html = reportWith([issue({ description: 'VER-CARD', confidence: 85 }), issue({ description: 'SUG-CARD', confidence: 69 })]);
    expect(html).toContain('Подтверждено кодом (85%)');
    expect(html).toContain('Предположение модели (69%)');
    expect(html).toContain('badge verified');
    expect(html).toContain('badge suggested');
    expect(html).toContain('codicon-lightbulb');
  });

  it('proof раскрывается details-блоком; пустой proof — без кнопки', () => {
    const html = reportWith([
      issue({ description: 'PROOF-CARD', proof: 'Line 10: password = secret123 is hardcoded' }),
      issue({ description: 'EMPTY-PROOF', proof: '' })
    ]);
    expect(html).toContain('Показать доказательство');
    expect(html).toContain('Line 10: password = secret123 is hardcoded');
    expect(html).toContain('<details class="proof"><summary>');
    expect(html.split('Показать доказательство')).toHaveLength(2);
  });

  it('EN-версия плашек и кнопок без кириллицы', () => {
    const html = reportWith([issue({ description: 'X', confidence: 75, proof: 'Line 1: const t = token;' })], 'en');
    expect(html).toContain('Verified by code (75%)');
    expect(html).toContain('False positive');
    expect(html).toContain('Show proof');
    expect(html).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('у каждой карточки есть кнопка «Ложное срабатывание» с fingerprint', () => {
    const item = issue({ description: 'FP-UI', line: 10 });
    const html = reportWith([item]);
    expect(html).toContain('data-command="suppressFinding"');
    expect(html).toContain(`data-fingerprint="${computeFingerprint(item)}"`);
    expect(html).toContain('codicon-thumbsdown');
  });

  it('empty state: две крупные кнопки с подписями (RU + EN)', () => {
    const ru = buildEmptyReportHtml('k', true, 'gemini', 'm', false, 'new', undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru');
    expect(ru).toContain('Проверить последний коммит (Git Diff)');
    expect(ru).toContain('быстрый результат за ~5 секунд');
    expect(ru).toContain('Полный аудит проекта');
    expect(ru).toContain('может занять несколько минут');
    expect(ru).toContain('data-command="scanLastCommit"');
    const en = buildEmptyReportHtml('k', true, 'gemini', 'm', false, 'new', undefined, false, 0, 0, undefined, 'nonce', undefined, 'en');
    expect(en).toContain('Check last commit (Git Diff)');
    expect(en).toContain('quick result in ~5 seconds');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });
});

describe('батч 20b: интеграция pipeline (скрытые находки не возвращаются)', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-fp-'));
    state.workspaceRoot = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function bootPanel(): { panel: CodeScoutPanel; receive: (message: unknown) => void; html: () => string; context: unknown } {
    const context = makeFakeContext();
    activate(context as never);
    const panel = state.providers.get('codescout.panel') as unknown as CodeScoutPanel;
    const { view, receive, html } = createView();
    panel.resolveWebviewView(view as never);
    return { panel, receive, html, context };
  }

  it('кнопка «Ложное срабатывание» пишет запись с метаданными и убирает карточку', () => {
    const { panel, receive, html, context } = bootPanel();
    const findings = [issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'KEEP-CARD', line: 50 })];
    panel.update(filterSuppressed(findings, mementoOf(context)), stats);
    expect(html()).toContain('<div class="description">FP-CARD</div>');
    const fingerprint = computeFingerprint(findings[0]);
    receive({ command: 'suppressFinding', fingerprint });
    expect(html()).not.toContain('<div class="description">FP-CARD</div>');
    expect(html()).toContain('KEEP-CARD');
    // вкладка скрытых показывает, что именно подавлено
    expect(html()).toContain('Скрытые находки (1)');
    expect(html()).toContain('FP-CARD');
    const stored = getSuppressed(mementoOf(context));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: fingerprint, file: 'src/a.ts', line: 10, severity: 'medium', category: 'bug', description: 'FP-CARD' });
  });

  it('unsuppressFinding снимает запись и возвращает карточку со статистикой', () => {
    const { panel, receive, html, context } = bootPanel();
    const findings = [issue({ description: 'FP-CARD', line: 10, severity: 'high' }), issue({ description: 'KEEP-CARD', line: 50 })];
    panel.update(filterSuppressed(findings, mementoOf(context)), stats);
    const fingerprint = computeFingerprint(findings[0]);
    receive({ command: 'suppressFinding', fingerprint });
    expect(html()).not.toContain('<div class="description">FP-CARD</div>');
    receive({ command: 'unsuppressFinding', fingerprint });
    expect(getSuppressed(mementoOf(context))).toHaveLength(0);
    expect(html()).toContain('<div class="description">FP-CARD</div>');
    expect(html()).not.toContain('Скрытые находки');
    expect(html()).toContain('KEEP-CARD');
  });

  it('скрытая находка не появляется при повторном скане (с сохранением между вызовами)', () => {
    const { panel, receive, html, context } = bootPanel();
    panel.update(filterSuppressed([issue({ description: 'FP-CARD', line: 10 })], mementoOf(context)), stats);
    receive({ command: 'suppressFinding', fingerprint: computeFingerprint(issue({ line: 10 })) });
    // «повторный скан»: модель сдвинула строку на +2 — подавление срабатывает по допуску ±3
    const rescan = filterSuppressed([issue({ description: 'FP-CARD', line: 12 })], mementoOf(context));
    expect(rescan).toHaveLength(0);
    panel.update(rescan, stats);
    expect(html()).not.toContain('<div class="description">FP-CARD</div>');
    // подавленное переживает «перезапуск» панели: новый activate на том же сторе
    const { panel: revived, html: revivedHtml } = bootPanel();
    const shown = filterSuppressed([issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'FRESH', line: 30 })], mementoOf(context));
    revived.update(shown, stats);
    expect(revivedHtml()).not.toContain('<div class="description">FP-CARD</div>');
    expect(revivedHtml()).toContain('FRESH');
  });

  it('хост фильтрует перед панелью, signature reviewFiles не раздута, подавление живёт в findingsStore', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('filterSuppressed(result.issues, context.workspaceState)');
    // Батч 26: аудит фильтрует carriedIssues (чекпоинт или last-good при 0 проверенных)
    expect(extension).toContain('filterSuppressed(carriedIssues, context.workspaceState)');
    expect(extension).toContain('filterSuppressed(dedupeIssues(result.issues), context.workspaceState)');
    expect(extension).toContain('filterSuppressed(savedResults.findings, context.workspaceState)');
    expect(extension).toContain('panel.attachWorkspaceState(context.workspaceState)');
    // 21-го параметра нет: adaptive остаётся последним аргументом
    expect(extension).toContain('adaptive: AdaptiveChunkOptions = {}): Promise<ScanResult>');
    expect(extension).not.toMatch(/reviewFiles\([^)]*workspaceState[^)]*\): Promise<ScanResult>/);
    // extension.ts не хранит suppression-логику сам
    expect(extension).not.toContain('codescout.suppressedFindings');
    const panelSource = readFileSync('extension/src/panel.ts', 'utf8');
    expect(panelSource).toContain("message.command === 'suppressFinding'");
    expect(panelSource).toContain("message.command === 'unsuppressFinding'");
  });

  it('подавление через прямые хелперы совпадает с кликом панели (единый fingerprint)', () => {
    const { panel, receive, html, context } = bootPanel();
    const findings = [issue({ description: 'STORE-EQ', line: 11 })];
    panel.update(filterSuppressed(findings, mementoOf(context)), stats);
    suppress(mementoOf(context), findings[0]);
    expect(filterSuppressed(findings, mementoOf(context))).toHaveLength(0);
    receive({ command: 'suppressFinding', fingerprint: 'несуществующий' });
    expect(html()).toContain('STORE-EQ');
  });
});
