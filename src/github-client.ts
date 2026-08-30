import { Octokit } from '@octokit/rest';
import { DiffFile, GitHubPullRequestContext, ReviewIssue } from './types';
import { SUMMARY_MARKER } from './report-formatter';

export class GitHubClient {
  constructor(private readonly octokit: Octokit, private readonly context: GitHubPullRequestContext) {}

  async getPullRequestFiles(): Promise<DiffFile[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, { owner: this.context.owner, repo: this.context.repo, pull_number: this.context.pullNumber, per_page: 100 });
    return files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch ?? '' }));
  }

  async postIssue(issue: ReviewIssue): Promise<void> {
    await this.octokit.rest.pulls.createReviewComment({ owner: this.context.owner, repo: this.context.repo, pull_number: this.context.pullNumber, body: formatIssue(issue), commit_id: issue.commitId ?? this.context.headSha, path: issue.file, line: issue.line, side: 'RIGHT' });
  }

  async stampCommitIds(issues: ReviewIssue[]): Promise<void> {
    const targets = [...new Set(issues.map((issue) => issue.file))];
    if (!targets.length) return;
    const prCommits = await this.octokit.paginate(this.octokit.rest.pulls.listCommits, { owner: this.context.owner, repo: this.context.repo, pull_number: this.context.pullNumber, per_page: 100 });
    const prShas = new Set(prCommits.map((commit) => commit.sha));
    for (const target of targets) {
      try {
        const commits = await this.octokit.paginate(this.octokit.rest.repos.listCommits, { owner: this.context.owner, repo: this.context.repo, path: target, sha: this.context.headSha, per_page: 100 });
        const stamp = commits.find((commit) => prShas.has(commit.sha))?.sha;
        if (stamp) for (const issue of issues) if (issue.file === target) issue.commitId = stamp;
      } catch (error) {
        console.warn(`CodeScout: не удалось проставить commit_id для ${target}: ${error instanceof Error ? error.message : String(error)} — fallback на headSha`);
      }
    }
  }

  async upsertSummaryComment(body: string): Promise<void> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, { owner: this.context.owner, repo: this.context.repo, issue_number: this.context.pullNumber, per_page: 100 });
    const existing = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.includes(SUMMARY_MARKER));
    if (existing) {
      await this.octokit.rest.issues.updateComment({ owner: this.context.owner, repo: this.context.repo, comment_id: existing.id, body });
      return;
    }
    await this.octokit.rest.issues.createComment({ owner: this.context.owner, repo: this.context.repo, issue_number: this.context.pullNumber, body });
  }
}

export function formatIssue(issue: ReviewIssue): string {
  const emoji = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟠' : issue.severity === 'medium' ? '🟡' : '🟢';
  const code = issue.code ?? `line ${issue.line}`;
  return `${emoji} **${issue.severity.toUpperCase()} · ${issue.category}**\n\`${code}\`\n→ ${issue.suggestion ?? issue.description}\nConfidence: ${Math.round(issue.confidence * 100)}%`;
}
