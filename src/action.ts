import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import { parseUnifiedDiff, splitPatch, shouldReviewFile } from './diff-parser';
import { GitHubClient } from './github-client';
import { createProvider } from './llm-client';
import { buildReviewPrompt, SYSTEM_PROMPT } from './prompt-builder';
import { postIssues } from './comment-poster';
import { parseReviewResponse } from './response-parser';
import { DiffFile, ReviewIssue } from './types';

export async function run(): Promise<void> {
  const startedAt = Date.now();
  try {
    const token = process.env.GITHUB_TOKEN;
    const apiKey = core.getInput('api-key', { required: true });
    if (!token) throw new Error('GITHUB_TOKEN is not available');
    if (!github.context.payload.pull_request) throw new Error('CodeScout must run on a pull_request event');
    const pullRequest = github.context.payload.pull_request as { number: number; head: { sha: string } };
    const context = { owner: github.context.repo.owner, repo: github.context.repo.repo, pullNumber: pullRequest.number, headSha: pullRequest.head.sha };
    const client = new GitHubClient(new Octokit({ auth: token }), context);
    const provider = createProvider(core.getInput('provider') || 'gemini', apiKey, core.getInput('model') || 'gemini-2.5-flash');
    const allFiles = await client.getPullRequestFiles();
    const files = allFiles.filter((file) => shouldReviewFile(file.filename) && file.patch);
    const issues: ReviewIssue[] = [];
    for (const file of files) {
      const patches = splitPatch(file.patch);
      for (const patch of patches) {
        const result = parseReviewResponse(await provider.review(SYSTEM_PROMPT, buildReviewPrompt(file, patch)), file.filename);
        issues.push(...result.issues);
      }
    }
    const durationMs = Date.now() - startedAt;
    const posted = await postIssues(client, issues, files.length, durationMs);
    const summary = `CodeScout analyzed ${files.length} file(s) and found ${issues.length} actionable issue(s).`;
    core.setOutput('summary', summary);
    core.info(`${summary} Posted ${posted} inline comment(s).`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) void run();

export function parsePatchForTesting(patch: string): DiffFile[] {
  return parseUnifiedDiff(patch);
}
