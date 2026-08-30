import { ReviewIssue } from './types';
import { GitHubClient } from './github-client';
import { buildSummaryComment } from './report-formatter';
import { asyncPool } from './async-pool';

function uniqueIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  const unique: ReviewIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.file}\u0000${issue.line}\u0000${issue.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

export async function postIssues(client: GitHubClient, issues: ReviewIssue[], filesAnalyzed: number, durationMs: number): Promise<number> {
  const unique = uniqueIssues(issues).slice(0, 100);
  await client.upsertSummaryComment(buildSummaryComment(unique, filesAnalyzed, durationMs));
  const posted = await asyncPool(4, unique, (issue) => client.postIssue(issue));
  return posted.filter(Boolean).length;
}

export function formatSummary(issues: ReviewIssue[], filesAnalyzed: number, durationMs = 0): string {
  return buildSummaryComment(issues, filesAnalyzed, durationMs);
}
