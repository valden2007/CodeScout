import { ReviewIssue } from '../../src/types';

export interface ReportStats {
  files: number;
  seconds: number;
  critical: number;
  medium: number;
  low: number;
}

const severityOrder: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityLabel(severity: ReviewIssue['severity']): string {
  return severity.toUpperCase();
}

function severityEmoji(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return '🔴';
  if (severity === 'medium') return '🟡';
  return '🟢';
}

function severityClass(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return 'critical';
  return severity;
}

function issueCard(issue: ReviewIssue): string {
  const severity = severityClass(issue.severity);
  const code = issue.code ? `<pre><code>${escapeHtml(issue.code)}</code></pre>` : '';
  const suggestion = issue.suggestion ? `<div class="suggestion"><span>→</span> ${escapeHtml(issue.suggestion)}</div>` : '';
  return `<article class="issue-card ${severity}">
  <div class="issue-top"><span class="badge ${severity}">${severityEmoji(issue.severity)} ${severityLabel(issue.severity)}</span><span class="category">${escapeHtml(issue.category)}</span><span class="confidence">${Math.round(issue.confidence * 100)}%</span></div>
  <div class="location">${escapeHtml(issue.file)}:${issue.line}</div>
  <div class="description">${escapeHtml(issue.description)}</div>
  ${code}
  ${suggestion}
</article>`;
}

export function buildReportHtml(issues: ReviewIssue[], stats: ReportStats, isScanning = false, emptyState = false): string {
  const sorted = [...issues].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const grouped = new Map<string, ReviewIssue[]>();
  for (const issue of sorted) grouped.set(issue.file, [...(grouped.get(issue.file) ?? []), issue]);
  const sections = [...grouped.entries()].map(([file, fileIssues]) => `<section class="file-section"><h2>${escapeHtml(file)}</h2>${fileIssues.map(issueCard).join('')}</section>`).join('');
  const body = sections || (emptyState
    ? '<div class="empty"><div class="empty-icon">🕵️</div><strong>CodeScout готов к работе</strong><small>Нажмите одну из кнопок выше, чтобы начать ревью.</small></div>'
    : '<div class="empty"><div class="empty-icon">✓</div><div>No issues found</div><small>Your changes look clean.</small></div>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 14px 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
.header { position: sticky; top: -16px; z-index: 2; margin: -16px -14px 0; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; letter-spacing: -0.2px; }
.brand-mark { color: var(--vscode-textLink-foreground); }
.actions { display: flex; gap: 6px; margin-top: 12px; flex-direction: column; }
button { width: 100%; padding: 6px 9px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.65; cursor: default; }
.spinner { display: inline-block; width: 11px; margin-right: 4px; }
.stats { margin-top: 9px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.pills { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.pill, .badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.pill.critical, .badge.critical { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); }
.pill.medium, .badge.medium { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent); }
.pill.low, .badge.low { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent); }
.file-section { margin-top: 18px; }
h2 { margin: 0 0 8px; color: var(--vscode-textLink-foreground); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.issue-card { margin: 8px 0; padding: 10px 10px 11px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-testing-iconPassed); border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
.issue-card.critical { border-left-color: var(--vscode-errorForeground); }
.issue-card.medium { border-left-color: var(--vscode-editorWarning-foreground); }
.issue-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.category { color: var(--vscode-descriptionForeground); font-size: 11px; }
.confidence { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.location { margin: 6px 0; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; overflow-wrap: anywhere; }
.description { margin-top: 5px; }
pre { margin: 9px 0; padding: 8px; overflow-x: auto; border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 3px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.suggestion { color: var(--vscode-testing-iconPassed); }
.suggestion span { font-weight: 700; }
.empty { padding: 48px 10px; color: var(--vscode-descriptionForeground); text-align: center; }
.empty-icon { margin-bottom: 8px; color: var(--vscode-testing-iconPassed); font-size: 24px; }
.empty small { display: block; margin-top: 5px; }
</style>
</head>
<body>
  <header class="header">
    <div class="brand"><span class="brand-mark">🕵️</span> CodeScout</div>
    <div class="actions">
      <button type="button" data-command="scanLastCommit" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '🔍'} Review last commit</button>
      <button type="button" data-command="scanUncommitted" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '📝'} Review uncommitted</button>
    </div>
    <div class="stats"><strong>${issues.length} issues</strong> · ${stats.files} files · ${stats.seconds.toFixed(1)}s</div>
    <div class="pills"><span class="pill critical">🔴 ${stats.critical}</span><span class="pill medium">🟡 ${stats.medium}</span><span class="pill low">🟢 ${stats.low}</span></div>
  </header>
  <main>${body}</main>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
}

export function buildEmptyReportHtml(): string {
  return buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, true);
}
