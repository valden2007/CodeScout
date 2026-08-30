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
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  } catch {
    throw new Error(`Unable to read git diff in "${cwd}". Make sure the path is a Git repository with at least one commit.`);
  }
}

function tryRunGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

function parseGitDiff(diff: string): LocalDiffFile[] {
  return parseUnifiedDiff(diff);
}

const SAFE_BASE_REF = /^[A-Za-z0-9._/@~-]+$/;

export function readGitDiff(repoPath: string, options: DiffReadOptions = {}): LocalDiffFile[] {
  const validationError = validateGitPath(repoPath);
  if (validationError) throw new Error(validationError);
  if (tryRunGit(['rev-parse', '--verify', 'HEAD'], repoPath) === undefined) {
    throw new Error('В репозитории ещё нет ни одного коммита (unborn branch). Сделай первый коммит и повтори.');
  }
  const git = (...args: string[]) => runGit(['-c', 'color.ui=false', ...args], repoPath);

  if (options.base) {
    const base = options.base.trim();
    if (!base || base.startsWith('-') || !SAFE_BASE_REF.test(base)) throw new Error(`Некорректное имя базовой ветки: "${options.base}". Разрешены буквы, цифры, . _ / @ ~ и дефис (без пробелов и дефиса в начале).`);
    return parseGitDiff(git('diff', `${base}...HEAD`));
  }
  if (options.lastCommit) {
    if (tryRunGit(['rev-parse', '--verify', '--quiet', 'HEAD~1'], repoPath) === undefined) {
      return parseGitDiff(git('show', '--format=', 'HEAD'));
    }
    return parseGitDiff(git('diff', 'HEAD~1', 'HEAD'));
  }

  return parseGitDiff(git('diff', 'HEAD'));
}
