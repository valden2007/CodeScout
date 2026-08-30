import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ReviewIssue } from './types';

export function correctIssueLine(issue: ReviewIssue, repoPath: string): ReviewIssue {
  if (!issue.code?.trim()) return issue;
  try {
    const root = realpathSync(resolve(repoPath));
    const abs = realpathSync(resolve(repoPath, issue.file));
    if (!abs.startsWith(root + sep)) return issue;
    const content = readFileSync(abs, 'utf8');
    const haystack = content.replace(/\r\n/g, '\n');
    const snippet = issue.code.trim().replace(/\r\n/g, '\n');
    const first = haystack.indexOf(snippet);
    if (first < 0) return issue;
    if (haystack.indexOf(snippet, first + snippet.length) >= 0) return issue;
    const line = 1 + (haystack.slice(0, first).match(/\n/g)?.length ?? 0);
    return { ...issue, line };
  } catch {
    return issue;
  }
}
