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
    const positions: number[] = [];
    for (let from = haystack.indexOf(snippet); from >= 0; from = haystack.indexOf(snippet, from + snippet.length)) positions.push(from);
    if (positions.length !== 1) return issue;
    const line = 1 + (haystack.slice(0, positions[0]).match(/\n/g)?.length ?? 0);
    return { ...issue, line };
  } catch {
    return issue;
  }
}
