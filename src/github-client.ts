import { Octokit } from '@octokit/rest';
import { DiffFile, GitHubPullRequestContext, ReviewIssue } from './types';

export class GitHubClient {
  constructor(private readonly octokit: Octokit, private readonly context: GitHubPullRequestContext) {}

  async getPullRequestFiles(): Promise<DiffFile[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, { owner: this.context.owner, repo: this.context.repo, pull_number: this.context.pullNumber, per_page: 100 });
    return files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch ?? '' }));
  }

  async postIssue(issue: ReviewIssue): Promise<void> {
    await this.octokit.rest.pulls.createReviewComment({ owner: this.context.owner, repo: this.context.repo, pull_number: this.context.pullNumber, body: formatIssue(issue), commit_id: this.context.headSha, path: issue.file, line: issue.line, side: 'RIGHT' });
  }
}

export function formatIssue(issue: ReviewIssue): string {
  const title = `${issue.severity.toUpperCase()} ${issue.category}`;
  return `**${title}**\n\n${issue.description}${issue.suggestion ? `\n\n**Suggestion:** ${issue.suggestion}` : ''}\n\n_Confidence: ${Math.round(issue.confidence * 100)}%_`;
}
