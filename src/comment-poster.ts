import { ReviewIssue } from './types';
import { GitHubClient } from './github-client';
import { buildSummaryComment } from './report-formatter';

function uniqueIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((issue, index, all) => index === all.findIndex((candidate) => candidate.file === issue.file && candidate.line === issue.line && candidate.description === issue.description));
}

export async function postIssues(client: GitHubClient, issues: ReviewIssue[], filesAnalyzed: number, durationMs: number): Promise<number> {
  const unique = uniqueIssues(issues).slice(0, 100);
  await client.upsertSummaryComment(buildSummaryComment(unique, filesAnalyzed, durationMs));
  for (const issue of unique) await client.postIssue(issue);
  return unique.length;
}

export function formatSummary(issues: ReviewIssue[], filesAnalyzed: number, durationMs = 0): string {
  return buildSummaryComment(issues, filesAnalyzed, durationMs);
}
