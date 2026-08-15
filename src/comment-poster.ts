import { ReviewIssue } from './types';
import { GitHubClient, formatIssue } from './github-client';

export async function postIssues(client: GitHubClient, issues: ReviewIssue[]): Promise<number> {
  const unique = issues.filter((issue, index, all) => index === all.findIndex((candidate) => candidate.file === issue.file && candidate.line === issue.line && candidate.description === issue.description));
  for (const issue of unique.slice(0, 100)) await client.postIssue(issue);
  return Math.min(unique.length, 100);
}

export function formatSummary(issues: ReviewIssue[], filesAnalyzed: number): string {
  const counts = issues.reduce<Record<string, number>>((result, issue) => ({ ...result, [issue.severity]: (result[issue.severity] ?? 0) + 1 }), {});
  const details = Object.entries(counts).map(([severity, count]) => `${severity}: ${count}`).join(', ') || 'no actionable issues';
  return `CodeScout analyzed ${filesAnalyzed} file(s) and found ${issues.length} actionable issue(s) (${details}).`;
}

export { formatIssue };
