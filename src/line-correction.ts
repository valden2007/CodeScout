import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewIssue } from './types';

export function correctIssueLine(issue: ReviewIssue, repoPath: string): ReviewIssue {
  if (!issue.code?.trim()) return issue;
  try {
    const content = readFileSync(join(repoPath, issue.file), 'utf8');
    const snippet = issue.code.trim();
    const matches = content.split('\n').flatMap((line, index) => line.includes(snippet) ? [index + 1] : []);
    return matches.length === 1 ? { ...issue, line: matches[0] } : issue;
  } catch {
    return issue;
  }
}
