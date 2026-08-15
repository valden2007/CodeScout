import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, shouldReviewFile, splitPatch } from '../src/diff-parser';
import { parseReviewResponse } from '../src/response-parser';

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

describe('response parser', () => {
  it('parses fenced JSON and normalizes issue fields', () => {
    const result = parseReviewResponse('```json\n{"issues":[{"line":4,"category":"security","severity":"high","description":"Unsafe input","confidence":2}],"summary":"Fix input validation"}\n```', 'src/app.ts');
    expect(result.issues[0]).toMatchObject({ file: 'src/app.ts', line: 4, category: 'security', severity: 'high', confidence: 1 });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseReviewResponse('not json', 'src/app.ts')).toThrow('malformed JSON');
  });
});
