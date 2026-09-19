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
  outputTail: string[];
  lastScanError?: string;
}

const SECRET_PATTERNS = /\b(?:sk|gsk|ghp|glpat|AIza|ya29)[A-Za-z0-9_-]{4,}\b/g;

export function redactSecrets(value: string, keyValues: string[] = []): string {
  const normalized = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  let out = normalized;
  for (const key of keyValues) {
    if (key) out = out.split(key).join('***');
  }
  return out.replace(SECRET_PATTERNS, '***');
}

export function reportIssueUrl(body: string): string {
  return `${CODESCOUT_REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

// Markdown-шаблон issue на языке пользователя: что случилось / шаги /
// ожидал-получил / диагностика (версии, настройки, наличие ключа,
// последние строки Output, последняя ошибка). Caller must redact every string first.
export function buildIssueBody(lang: Lang, input: IssueReportInput): string {
  const T = (key: string, vars?: Record<string, string | number>) => t(key, lang, vars);
  const lines = [
    `**CodeScout ${input.extVersion} · VS Code ${input.vscodeVersion} · ${input.os}**`,
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
    `- provider: ${input.provider} · model: ${input.model} · language: ${input.language} · uiTheme: ${input.uiTheme} · auditPasses: ${input.auditPasses} · rateLimitPauses: ${input.rateLimitPauses}`,
    `- ${T(input.hasKey ? 'issue.keyYes' : 'issue.keyNo')}`,
    `- ${input.lastScanError ? T('issue.lastError', { e: input.lastScanError.slice(0, 300) }) : T('issue.noError')}`,
    '',
    `<details><summary>${T('issue.outputTail')}</summary>`,
    '',
    '```text',
    ...input.outputTail.map((line) => line.slice(0, 400)),
    '```',
    '',
    '</details>',
    ''
  ];
  return lines.join('\n');
}
