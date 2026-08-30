import { ReviewIssue, ReviewSeverity } from './types';

export const SUMMARY_MARKER = '<!-- codescout-summary -->';
const MAX_COMMENT_LENGTH = 60_000;

const SEVERITY_META: Record<ReviewSeverity, { emoji: string; rank: number }> = {
  critical: { emoji: '🔴', rank: 0 },
  high: { emoji: '🟠', rank: 1 },
  medium: { emoji: '🟡', rank: 2 },
  low: { emoji: '🟢', rank: 3 }
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineCode(value: string): string {
  const cleaned = escapeHtml(value).replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...Array.from(cleaned.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return cleaned.includes('`') ? `${fence} ${cleaned} ${fence}` : `${fence}${cleaned}${fence}`;
}

function safeIssueTitle(issue: ReviewIssue): string {
  return issue.description.split(/[.!?\n]/, 1)[0].trim() || `${issue.category} finding`;
}

function truncateSafely(value: string): string {
  if (value.length <= MAX_COMMENT_LENGTH) return value;
  const suffix = '\n\n_Отчёт сокращён до лимита GitHub комментария._';
  return `${value.slice(0, MAX_COMMENT_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

export function severityEmoji(severity: ReviewSeverity): string {
  return SEVERITY_META[severity]?.emoji ?? '⚪';
}

export function buildSummaryComment(issues: ReviewIssue[], filesAnalyzed: number, durationMs: number): string {
  const sorted = [...issues].sort((left, right) => (SEVERITY_META[left.severity]?.rank ?? 99) - (SEVERITY_META[right.severity]?.rank ?? 99));
  const seconds = (Math.max(0, durationMs) / 1000).toFixed(1);
  const rows = sorted.length > 0
    ? sorted.map((issue) => `| ${severityEmoji(issue.severity)} ${issue.severity} | ${escapeHtml(issue.category)} | ${escapeCell(escapeHtml(issue.description))} | ${inlineCode(`${issue.file}:${issue.line}`)} |`).join('\n')
    : '| — | — | No actionable issues found. | — |';
  const details = sorted.map((issue) => {
    const emoji = severityEmoji(issue.severity);
    const title = safeIssueTitle(issue);
    const codeLine = issue.code ?? `line ${issue.line}`;
    const suggestion = issue.suggestion ? `\n→ ${escapeHtml(issue.suggestion)}` : '';
    return `<details><summary>${emoji} <strong>${escapeHtml(title)}</strong> — ${inlineCode(`${issue.file}:${issue.line}`)}</summary>\n\n${inlineCode(codeLine)}${suggestion}\n\nConfidence: ${Math.round(issue.confidence * 100)}%\n</details>`;
  }).join('\n\n');
  const report = `${SUMMARY_MARKER}\n## 🕵️ CodeScout Report\n\n**${issues.length} issue${issues.length === 1 ? '' : 's'}** in ${filesAnalyzed} file${filesAnalyzed === 1 ? '' : 's'} · analyzed in ${seconds}s\n\n| Severity | Category | Description | Location |\n| --- | --- | --- | --- |\n${rows}${details ? `\n\n${details}` : ''}`;
  return truncateSafely(report);
}
