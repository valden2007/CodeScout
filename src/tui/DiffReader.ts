import { execFileSync } from 'node:child_process';

export interface LocalDiffFile {
  filename: string;
  patch: string;
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Unable to read git diff in "${cwd}". Make sure the path is a Git repository with at least two commits.`);
  }
}

function parseGitDiff(diff: string): LocalDiffFile[] {
  return diff.split(/^diff --git /m).slice(1).flatMap((section) => {
    const header = section.match(/^a\/(.+?) b\/(.+?)(?:\n|$)/);
    return header ? [{ filename: header[2], patch: `diff --git ${section.trim()}` }] : [];
  });
}

export function readGitDiff(repoPath: string): LocalDiffFile[] {
  runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
  let diff: string;
  try {
    runGit(['rev-parse', '--verify', 'HEAD~1'], repoPath);
    diff = runGit(['-c', 'color.ui=false', 'diff', 'HEAD~1'], repoPath);
  } catch {
    diff = runGit(['-c', 'color.ui=false', 'diff', 'main'], repoPath);
  }
  return parseGitDiff(diff);
}
