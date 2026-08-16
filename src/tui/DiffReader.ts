import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseUnifiedDiff } from '../diff-parser';

export interface LocalDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface DiffReadOptions {
  lastCommit?: boolean;
  base?: string;
}

export function validateGitPath(repoPath: string): string | undefined {
  if (!existsSync(repoPath)) return `Путь не найден: "${repoPath}". Проверь значение --path.`;
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return undefined;
  } catch {
    return `Путь "${repoPath}" не является Git-репозиторием. Укажи папку с .git через --path.`;
  }
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Unable to read git diff in "${cwd}". Make sure the path is a Git repository with at least one commit.`);
  }
}

function parseGitDiff(diff: string): LocalDiffFile[] {
  return parseUnifiedDiff(diff);
}

function mergeFiles(files: LocalDiffFile[]): LocalDiffFile[] {
  const merged = new Map<string, LocalDiffFile>();
  for (const file of files) {
    const previous = merged.get(file.filename);
    if (!previous) {
      merged.set(file.filename, file);
      continue;
    }
    merged.set(file.filename, {
      ...file,
      additions: previous.additions + file.additions,
      deletions: previous.deletions + file.deletions,
      patch: `${previous.patch}\n${file.patch}`
    });
  }
  return [...merged.values()];
}

export function readGitDiff(repoPath: string, options: DiffReadOptions = {}): LocalDiffFile[] {
  const validationError = validateGitPath(repoPath);
  if (validationError) throw new Error(validationError);
  runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
  const git = (...args: string[]) => runGit(['-c', 'color.ui=false', ...args], repoPath);

  if (options.base) return parseGitDiff(git('diff', `${options.base}...HEAD`));
  if (options.lastCommit) return parseGitDiff(git('diff', 'HEAD~1'));

  const unstaged = parseGitDiff(git('diff'));
  const staged = parseGitDiff(git('diff', '--cached'));
  return mergeFiles([...unstaged, ...staged]);
}
