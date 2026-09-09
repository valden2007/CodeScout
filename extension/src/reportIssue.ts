import { t, type Lang } from '../../src/i18n';

export const CODESCOUT_REPO_URL = 'https://github.com/valden2007/CodeScout';

export interface IssueReportInput {
  extVersion: string;
  vscodeVersion: string;
  os: string;
  provider: string;
  model: string;
  language: string;
  uiTheme: string;
  auditPasses: number;
  rateLimitPauses: number;
  hasKey: boolean;
  // Реальные значения ключей используются ТОЛЬКО для вычёркивания из body
  // и сами в body не попадают никогда.
  keyValues: string[];
  outputTail: string[];
  lastScanError?: string;
}

const SECRET_PATTERNS = /\b(?:sk|gsk|ghp|glpat|AIza|ya29)[A-Za-z0-9_-]{4,}\b/g;

export function redactSecrets(value: string, keyValues: string[] = []): string {
  let out = value;
  for (const key of keyValues) {
    if (key && key.length >= 4) out = out.split(key).join('***');
  }
  return out.replace(SECRET_PATTERNS, '***');
}

export function reportIssueUrl(body: string): string {
  return `${CODESCOUT_REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

// Markdown-шаблон issue на языке пользователя: что случилось / шаги /
// ожидал-получил / диагностика (версии, настройки, наличие ключа,
// последние строки Output, последняя ошибка). Секреты вычищаются redactSecrets.
export function buildIssueBody(lang: Lang, input: IssueReportInput): string {
  const T = (key: string, vars?: Record<string, string | number>) => t(key, lang, vars);
  const safe = (value: string) => redactSecrets(value, input.keyValues);
  const lines = [
    `**CodeScout ${input.extVersion} · VS Code ${input.vscodeVersion} · ${safe(input.os)}**`,
    '',
    `## ${T('issue.happened')}`,
    `_${T('issue.hint')}_`,
    '',
    `## ${T('issue.steps')}`,
    '1. ',
    '',
    `## ${T('issue.expectedActual')}`,
    `**${T('issue.expected')}:** `,
    `**${T('issue.actual')}:** `,
    '',
    `## ${T('issue.diag')}`,
    `- provider: ${safe(input.provider)} · model: ${safe(input.model)} · language: ${input.language} · uiTheme: ${safe(input.uiTheme)} · auditPasses: ${input.auditPasses} · rateLimitPauses: ${input.rateLimitPauses}`,
    `- ${T(input.hasKey ? 'issue.keyYes' : 'issue.keyNo')}`,
    `- ${input.lastScanError ? T('issue.lastError', { e: safe(input.lastScanError).slice(0, 300) }) : T('issue.noError')}`,
    '',
    `<details><summary>${T('issue.outputTail')}</summary>`,
    '',
    '```text',
    ...input.outputTail.map((line) => safe(line).slice(0, 400)),
    '```',
    '',
    '</details>',
    ''
  ];
  return safe(lines.join('\n'));
}
