import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, unquoteGitPath } from '../src/diff-parser';
import { numberPatch } from '../src/line-numbering';
import { readGitDiff } from '../src/tui/DiffReader';

describe('batch 19: git modes — untracked, quoted paths, hunk headers', () => {
  it('unquoteGitPath decodes git C-style quoting and UTF-8 octal bytes', () => {
    expect(unquoteGitPath('"a/\\320\\277\\321\\200\\320\\270.ts"')).toBe('a/при.ts');
    expect(unquoteGitPath('"a/tab\\tname\\"q\\\\.ts"')).toBe('a/tab\tname"q\\.ts');
    expect(unquoteGitPath('plain/path.ts')).toBe('plain/path.ts');
  });

  it('parses a diff whose header paths are quoted (Cyrillic filename)', () => {
    const diff = [
      'diff --git "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts" "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.ts"',
      '@@ -0,0 +1 @@',
      '+const x = 1;',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: 'привет.ts', status: 'added', additions: 1 });
  });

  it('keeps SQL "--" comment removals inside a hunk as deletions and numbers the rest of the hunk', () => {
    const patch = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,3 +1,3 @@',
      ' SELECT 1;',
      '--- drop old',
      '+-- keep new',
      ' SELECT 2;',
    ].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file).toMatchObject({ filename: 'q.sql', additions: 1, deletions: 1 });
    const numbered = numberPatch(patch);
    expect(numbered).toContain('1 |  SELECT 1;');
    expect(numbered).toContain('--- drop old');
    expect(numbered).toContain('2 | +-- keep new');
    expect(numbered).toContain('3 |  SELECT 2;');
  });

  it('a removed "-- " comment does not hide the next file header or break the following file', () => {
    const patch = [
      '--- a/one.sql',
      '+++ b/one.sql',
      '@@ -1,2 +1,1 @@',
      '--- old comment',
      ' SELECT 1;',
      '--- a/two.sql',
      '+++ b/two.sql',
      '@@ -5,1 +5,1 @@',
      '+SELECT 5;',
    ].join('\n');
    const numbered = numberPatch(patch);
    expect(numbered).toContain('1 |  SELECT 1;');
    expect(numbered).toContain('+++ b/two.sql');
    expect(numbered).toContain('5 | +SELECT 5;');
  });

  it('readGitDiff includes untracked files in the default mode, with quoted non-ASCII names and noprefix config', () => {
    const root = mkdtempSync(join(tmpdir(), 'codescout-b19-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      // Ломаем git-конфиг пользователя: без принудительных префиксов парсер ослеп бы.
      git('config', 'diff.noprefix', 'true');
      writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
      git('add', '.');
      git('commit', '-m', 'init');
      writeFileSync(join(root, 'a.ts'), 'const a = 2;\n');
      writeFileSync(join(root, 'новый.ts'), 'export const n = 1;\n');
      writeFileSync(join(root, 'migrate.sql'), '-- untracked comment\nSELECT 1;\n');

      const working = readGitDiff(root).map((file) => file.filename).sort();
      expect(working).toEqual(['a.ts', 'migrate.sql', 'новый.ts']);

      const untrackedSql = readGitDiff(root).find((file) => file.filename === 'migrate.sql');
      expect(untrackedSql).toMatchObject({ status: 'added', additions: 2, deletions: 0 });

      // Режимы коммита не должны подмешивать untracked-файлы.
      git('add', '.');
      git('commit', '-m', 'second');
      writeFileSync(join(root, 'scratch.ts'), 'const s = 1;\n');
      expect(readGitDiff(root, { lastCommit: true }).map((file) => file.filename)).not.toContain('scratch.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git reviews enable continueOnFileError and surface skipped files', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('systemPrompt, true, onFileSkipped');
    expect(extension).toContain('Пропущено файлов');
    expect(extension).toContain('Пропущен файл');
  });
});
