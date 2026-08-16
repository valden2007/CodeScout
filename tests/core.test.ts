import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, shouldReviewFile, splitPatch } from '../src/diff-parser';
import { parseReviewResponse } from '../src/response-parser';
import { buildSummaryComment } from '../src/report-formatter';
import { numberPatch } from '../src/line-numbering';
import { correctIssueLine } from '../src/line-correction';
import { validateGitPath } from '../src/tui/DiffReader';
import { filesWithIssues } from '../src/tui/App';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const value = 1;
+const next = value + 1;

diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-old
+new`;

describe('diff parser', () => {
  it('extracts reviewable files and line counts', () => {
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: 'src/app.ts', additions: 1, deletions: 0 });
  });

  it('filters generated, lock, and binary files', () => {
    expect(shouldReviewFile('package-lock.json')).toBe(false);
    expect(shouldReviewFile('src/app.min.js')).toBe(false);
    expect(shouldReviewFile('src/app.ts')).toBe(true);
  });

  it('splits large patches without losing content', () => {
    const chunks = splitPatch(`${'a'.repeat(8)}\n${'b'.repeat(8)}\n${'c'.repeat(8)}`, 10);
    expect(chunks.join('')).toBe(`${'a'.repeat(8)}\n${'b'.repeat(8)}\n${'c'.repeat(8)}`);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('C4.5 quality fixes', () => {
  it('includes false-positive exclusions in the system prompt', async () => {
    const { SYSTEM_PROMPT } = await import('../src/prompt-builder');
    expect(SYSTEM_PROMPT).toContain('DO NOT flag:');
    expect(SYSTEM_PROMPT).toContain('cuid()');
    expect(SYSTEM_PROMPT).toContain('seed or migration');
    expect(SYSTEM_PROMPT).toContain('Next.js singleton patterns');
    expect(SYSTEM_PROMPT).toContain('Precision over recall');
    expect(SYSTEM_PROMPT).toContain('Report at most 3 issues per file');
    expect(SYSTEM_PROMPT).toContain('BE LENIENT on:');
  });

  it('reports a friendly error for a nonexistent path', () => {
    const error = validateGitPath('/tmp/codescout-path-does-not-exist');
    expect(error).toContain('Путь не найден');
    expect(error).toContain('/tmp/codescout-path-does-not-exist');
  });

  it('filters files with no issues before rendering panels', () => {
    const files = [
      { filename: 'clean.ts', status: 'modified', additions: 0, deletions: 0, patch: '' },
      { filename: 'buggy.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }
    ];
    const issues = new Map([['buggy.ts', [{ severity: 'low' as const, category: 'bug', confidence: 80, line: 2, code: 'x', suggestion: 'fix' }]]]);
    expect(filesWithIssues(files, issues).map((file) => file.filename)).toEqual(['buggy.ts']);
  });

  it('demotes low-confidence critical findings to medium', () => {
    const result = parseReviewResponse('{"issues":[{"line":4,"category":"bug","severity":"critical","description":"Maybe unsafe","confidence":0.6}]}', 'src/app.ts');
    expect(result.issues[0].severity).toBe('medium');
  });
  it('downgrades an index suggestion mislabeled as security', () => {
    const result = parseReviewResponse('{"issues":[{"line":4,"category":"security","severity":"medium","description":"Missing database index","suggestion":"Add an index for this query","confidence":0.8}]}', 'src/db.ts');
    expect(result.issues[0].category).toBe('performance');
  });
});

describe('line accuracy', () => {
  it('numbers added and context lines from the new-file hunk header', () => {
    const patch = `@@ -17,3 +20,4 @@\n const before = true;\n+const token = input.token;\n const after = true;`;
    expect(numberPatch(patch)).toContain('20 |  const before = true;');
    expect(numberPatch(patch)).toContain('21 | +const token = input.token;');
    expect(numberPatch(patch)).toContain('22 |  const after = true;');
  });

  it('corrects the line when the code snippet occurs exactly once', () => {
    const directory = mkdtempSync(join(process.cwd(), 'tmp-line-test-'));
    try {
      writeFileSync(join(directory, 'src.ts'), 'const first = 1;\nconst token = input.token;\nconst last = 3;\n');
      const issue = { file: 'src.ts', line: 18, category: 'bug' as const, severity: 'medium' as const, description: 'Unsafe token use', code: 'const token = input.token;', confidence: 0.9 };
      expect(correctIssueLine(issue, directory).line).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('report formatter', () => {
  const issues = [
    { file: 'src/app.ts', line: 8, category: 'style' as const, severity: 'low' as const, description: 'Minor naming issue.', suggestion: 'Rename the variable.', confidence: 0.8 },
    { file: 'src/auth.ts', line: 3, category: 'security' as const, severity: 'critical' as const, description: 'User input reaches a privileged operation.', code: 'run(input)', suggestion: 'Validate input before use.', confidence: 0.95 },
    { file: 'src/db.ts', line: 14, category: 'performance' as const, severity: 'medium' as const, description: 'This query scans the full table.', suggestion: 'Add an index.', confidence: 0.7 }
  ];

  it('sorts issues by severity and maps severity emojis', () => {
    const report = buildSummaryComment(issues, 3, 1250);
    expect(report).toContain('<!-- codescout-summary -->');
    expect(report).toContain('**3 issues** in 3 files · analyzed in 1.3s');
    expect(report.indexOf('🔴 critical')).toBeLessThan(report.indexOf('🟡 medium'));
    expect(report.indexOf('🟡 medium')).toBeLessThan(report.indexOf('🟢 low'));
    expect(report).toContain('<details><summary>🔴 <strong>User input reaches a privileged operation</strong>');
    expect(report).toContain('`run(input)`');
    expect(report).toContain('Confidence: 95%');
  });

  it('keeps the marker and truncates oversized comments safely', () => {
    const huge = [{ ...issues[0], description: 'x'.repeat(70_000) }];
    const report = buildSummaryComment(huge, 1, 0);
    expect(report.startsWith('<!-- codescout-summary -->')).toBe(true);
    expect(report.length).toBeLessThanOrEqual(60_000);
    expect(report).toContain('Отчёт сокращён до лимита GitHub комментария.');
  });
});

describe('response parser', () => {
  it('parses fenced JSON and normalizes issue fields', () => {
    const result = parseReviewResponse('```json\n{"issues":[{"line":4,"category":"security","severity":"high","description":"Unsafe input","code":"const token = input.token;","confidence":2}],"summary":"Fix input validation"}\n```', 'src/app.ts');
    expect(result.issues[0]).toMatchObject({ file: 'src/app.ts', line: 4, category: 'security', severity: 'high', code: 'const token = input.token;', confidence: 1 });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseReviewResponse('not json', 'src/app.ts')).toThrow('malformed JSON');
  });
});
