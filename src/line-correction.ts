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
    const snippet = issue.code.trim();
    const matches = content.split('\n').flatMap((line, index) => line.includes(snippet) ? [index + 1] : []);
    return matches.length === 1 ? { ...issue, line: matches[0] } : issue;
  } catch {
    return issue;
  }
}
