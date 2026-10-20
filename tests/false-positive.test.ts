// Батч 14: false-positive suppression + proof of finding — интеграция.
// e2e через реальный activate() + CodeScoutPanel на vscode-stub (как path-guard).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { state, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { CodeScoutPanel } from '../extension/src/panel';
import { computeFingerprint, filterSuppressed, getSuppressedFindings, suppressFinding } from '../extension/src/findingsStore';
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

function issue(overrides: Partial<ReviewIssue>): ReviewIssue {
  return { file: 'src/a.ts', line: 10, category: 'bug', severity: 'medium', description: 'd', confidence: 0.7, ...overrides };
}

function mementoOf(context: unknown) {
  return (context as { workspaceState: never }).workspaceState;
}

describe('батч 14: промпт и парсер proof/confidence', () => {
  it('системный промпт требует proof и confidenceLevel', () => {
    expect(SYSTEM_PROMPT).toContain('"confidenceLevel":"verified|suggested"');
    expect(SYSTEM_PROMPT).toContain('"proof"');
    expect(SYSTEM_PROMPT).toContain('"condition"');
    expect(SYSTEM_PROMPT).toContain('"trace"');
    expect(SYSTEM_PROMPT).toContain('When X happens');
    expect(SYSTEM_PROMPT).toContain('concrete code path');
  });

  it('парсер: отсутствие proof/confidence → defaults без падения (обратная совместимость)', () => {
    const result = parseReviewResponse('{"issues":[{"line":4,"category":"bug","severity":"medium","description":"Legacy model","confidence":0.8}],"summary":"ok"}', 'src/a.ts');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].confidenceLevel).toBe('suggested');
    expect(result.issues[0].proof).toEqual({});
    expect(result.issues[0].confidence).toBe(0.8);
  });

  it('парсер: корректные поля читаются как есть', () => {
    const result = parseReviewResponse(JSON.stringify({ issues: [{ line: 4, category: 'bug', severity: 'high', description: 'NPE', confidence: 0.95, confidenceLevel: 'verified', proof: { condition: 'When user is null', trace: ['Line 10: assign', 'Line 25: use'] } }], summary: '' }), 'src/a.ts');
    expect(result.issues[0].confidenceLevel).toBe('verified');
    expect(result.issues[0].proof).toEqual({ condition: 'When user is null', trace: ['Line 10: assign', 'Line 25: use'] });
  });

  it('парсер: мусор в proof не роняет разбор, трассируются только строки', () => {
    const result = parseReviewResponse(JSON.stringify({ issues: [{ line: 4, description: 'x', proof: 'не объект' }] }), 'src/b.ts');
    expect(result.issues[0].proof).toEqual({});
    const messy = parseReviewResponse(JSON.stringify({ issues: [{ line: 4, description: 'y', confidenceLevel: 'bogus', proof: { condition: 7, trace: [null, 5, ' шаг ', '   ', 'z'.repeat(1000)] } }] }), 'src/b.ts');
    expect(messy.issues[0].confidenceLevel).toBe('suggested');
    expect(messy.issues[0].proof).toEqual({ trace: ['шаг', 'z'.repeat(300)] });
  });

  it('парсер: строка вместо числа в confidence не ломает разбор и читается как verified', () => {
    const result = parseReviewResponse('{"issues":[{"line":4,"description":"z","confidence":"verified"}]}', 'src/c.ts');
    expect(result.issues[0].confidence).toBe(0.7);
    expect(result.issues[0].confidenceLevel).toBe('verified');
  });
});

describe('батч 14: плашки confidence и доказательство в UI', () => {
  it('verified → зелёная плашка, suggested → жёлтая, отсутствие поля → suggested', () => {
    const html = buildReportHtml(
      [issue({ description: 'VER-CARD', confidenceLevel: 'verified' }), issue({ description: 'SUG-CARD', confidenceLevel: 'suggested' }), issue({ description: 'DEF-CARD' })],
      stats, false, false, '', 'retry', 'k', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru'
    );
    expect(html).toContain('Подтверждено кодом');
    expect(html).toContain('Предположение модели');
    expect(html).toContain('badge verified');
    expect(html).toContain('badge suggested');
    expect(html).toContain('codicon-lightbulb');
  });

  it('proof раскрывается блоком с условием и трассой; пустой proof — без кнопки', () => {
    const html = buildReportHtml(
      [issue({ description: 'PROOF-CARD', proof: { condition: 'При null-входе', trace: ['Строка 10: присваивание', 'Строка 25: использование'] } }), issue({ description: 'EMPTY-PROOF', proof: {} })],
      stats, false, false, '', 'retry', 'k', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru'
    );
    expect(html).toContain('Показать доказательство');
    expect(html).toContain('При null-входе');
    expect(html).toContain('Строка 25: использование');
    expect(html).toContain('Путь выполнения');
    expect(html.split('Показать доказательство')).toHaveLength(2);
  });

  it('EN-версия плашек и кнопок без кириллицы', () => {
    const html = buildReportHtml(
      [issue({ description: 'X', confidenceLevel: 'verified', proof: { condition: 'null input', trace: ['Line 1: a'] } })],
      stats, false, false, '', 'retry', 'k', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'en'
    );
    expect(html).toContain('Verified by code');
    expect(html).toContain('False positive');
    expect(html).toContain('Show proof');
    expect(html).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('у каждой карточки есть кнопка «Ложное срабатывание» с fingerprint', () => {
    const item = issue({ description: 'FP-UI', line: 10 });
    const html = buildReportHtml([item], stats, false, false, '', 'retry', 'k', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru');
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

describe('батч 14: интеграция pipeline (скрытые находки не возвращаются)', () => {
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

  it('кнопка «Ложное срабатывание» вызывает suppressFinding и убирает карточку', () => {
    const { panel, receive, html, context } = bootPanel();
    const findings = [issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'KEEP-CARD', line: 50 })];
    panel.update(filterSuppressed(findings, mementoOf(context)), stats);
    expect(html()).toContain('FP-CARD');
    const fingerprint = computeFingerprint(findings[0]);
    receive({ command: 'suppressFinding', fingerprint });
    expect(html()).not.toContain('FP-CARD');
    expect(html()).toContain('KEEP-CARD');
    expect(getSuppressedFindings(mementoOf(context))).toEqual([fingerprint]);
  });

  it('скрытая находка не появляется при повторном скане (с сохранением между вызовами)', () => {
    const { panel, receive, html, context } = bootPanel();
    panel.update(filterSuppressed([issue({ description: 'FP-CARD', line: 10 })], mementoOf(context)), stats);
    receive({ command: 'suppressFinding', fingerprint: computeFingerprint(issue({ line: 10 })) });
    // «повторный скан»: модель сдвинула строку на +2 — fingerprint тот же
    const rescan = filterSuppressed([issue({ description: 'FP-CARD', line: 12 })], mementoOf(context));
    expect(rescan).toHaveLength(0);
    panel.update(rescan, stats);
    expect(html()).not.toContain('FP-CARD');
    // подавленное переживает «перезапуск» панели: новый activate на том же сторе
    const { panel: revived, html: revivedHtml } = bootPanel();
    const shown = filterSuppressed([issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'FRESH', line: 30 })], mementoOf(context));
    revived.update(shown, stats);
    expect(revivedHtml()).not.toContain('FP-CARD');
    expect(revivedHtml()).toContain('FRESH');
  });

  it('хост фильтрует перед панелью, signature reviewFiles не раздута, подавление живёт в findingsStore', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('filterSuppressed(result.issues, context.workspaceState)');
    expect(extension).toContain('filterSuppressed(mergedIssues, context.workspaceState)');
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
  });

  it('подавление через прямые хелперы совпадает с кликом панели (единый fingerprint)', () => {
    const { panel, receive, html, context } = bootPanel();
    const findings = [issue({ description: 'STORE-EQ', line: 11 })];
    panel.update(filterSuppressed(findings, mementoOf(context)), stats);
    suppressFinding(mementoOf(context), computeFingerprint(findings[0]));
    expect(filterSuppressed(findings, mementoOf(context))).toHaveLength(0);
    receive({ command: 'suppressFinding', fingerprint: 'несуществующий' });
    expect(html()).toContain('STORE-EQ');
  });
});
