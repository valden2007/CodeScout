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

// Конфиг, который задаёт формат diff независимо от пользовательского git-конфига:
// префиксы a/ b/ (иначе diff.noprefix / mnemonicPrefix ломают разбор заголовков),
// без цвета. Кавычки путей обрабатывает diff-parser (unquoteGitPath).
const GIT_DIFF_CONFIG = [
  '-c', 'color.ui=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.srcPrefix=a/',
  '-c', 'diff.dstPrefix=b/',
];

function runGit(args: string[], cwd: string, allowEmptyDiff = false): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    if (allowEmptyDiff && (error as { status?: number }).status === 1) return '';
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

// git diff --no-index возвращает код 1, когда различия найдены, это нормальный
// результат, а не ошибка. Поэтому берём stdout из ошибки. Прочие сбои
// (например, файл больше maxBuffer) дают пустой патч: один файл не должен
// ронять весь ревью.
function runGitNoIndexDiff(path: string, cwd: string): string {
  try {
    return execFileSync('git', [...GIT_DIFF_CONFIG, 'diff', '--no-index', '--', '/dev/null', path], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return failure.status === 1 && typeof failure.stdout === 'string' ? failure.stdout : '';
  }
}

// Неотслеживаемые файлы (new, не добавленные в индекс) не видны в `git diff HEAD`.
// -z отключает кавычки в самом списке имён.
function readUntrackedDiff(repoPath: string): string {
  const listing = tryRunGit([...GIT_DIFF_CONFIG, 'ls-files', '-z', '--others', '--exclude-standard'], repoPath) ?? '';
  return listing
    .split('\0')
    .filter((name) => name.length > 0)
    .map((name) => runGitNoIndexDiff(name, repoPath))
    .join('');
}

function parseGitDiff(diff: string): LocalDiffFile[] {
  return parseUnifiedDiff(diff);
}

const SAFE_BASE_REF = /^[A-Za-z0-9._/-]+$/;

export function readGitDiff(repoPath: string, options: DiffReadOptions = {}): LocalDiffFile[] {
  const validationError = validateGitPath(repoPath);
  if (validationError) throw new Error(validationError);
  if (tryRunGit(['rev-parse', '--verify', 'HEAD'], repoPath) === undefined) {
    throw new Error('В репозитории ещё нет ни одного коммита (unborn branch). Сделай первый коммит и повтори.');
  }
  const git = (...args: string[]) => runGit([...GIT_DIFF_CONFIG, ...args], repoPath, true);

  if (options.base) {
    const base = options.base.trim();
    if (!base || base.startsWith('-') || base.includes('~') || base.includes('@') || !SAFE_BASE_REF.test(base)) throw new Error(`Некорректное имя базовой ветки: "${options.base}". Разрешены буквы, цифры, . _ / и дефис (без пробелов, ~, @ и дефиса в начале).`);
    if (tryRunGit(['rev-parse', '--verify', '--quiet', `${base}^\{commit\}`], repoPath) === undefined && tryRunGit(['rev-parse', '--verify', '--quiet', base], repoPath) === undefined) {
      throw new Error(`Ветка не найдена: "${base}". Проверь имя (git branch -a).`);
    }
    return parseGitDiff(git('diff', `${base}...HEAD`));
  }
  if (options.lastCommit) {
    if (tryRunGit(['rev-parse', '--verify', '--quiet', 'HEAD~1'], repoPath) === undefined) {
      return parseGitDiff(git('show', '--format=', 'HEAD'));
    }
    return parseGitDiff(git('diff', 'HEAD~1', 'HEAD'));
  }

  const tracked = git('diff', 'HEAD');
  const separator = tracked && !tracked.endsWith('\n') ? '\n' : '';
  return parseGitDiff(`${tracked}${separator}${readUntrackedDiff(repoPath)}`);
}
