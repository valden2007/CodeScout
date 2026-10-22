import { DiffFile } from './types';

const IGNORED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', '.next']);
const IGNORED_BASENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const IGNORED_EXTENSIONS = /\.(min\.(js|css)|map|png|jpe?g|gif|webp|ico|pdf|zip|woff2?)$/i;

export function shouldReviewFile(filename: string): boolean {
  const segments = filename.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? '';
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return false;
  if (IGNORED_BASENAMES.has(basename)) return false;
  if (IGNORED_EXTENSIONS.test(basename)) return false;
  return true;
}

// Git берёт путь в двойные кавычки, если он содержит не-ASCII (кириллица),
// кавычки, обратный слэш или управляющие символы. Не-ASCII приходит как
// восьмеричные байты UTF-8 (\320\277 = "п"), поэтому декодируем байты целиком.
const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };

export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const tokens = body.match(/\\[0-7]{3}|\\[\s\S]|[^\\]+/g) ?? [];
  const bytes: number[] = [];
  for (const token of tokens) {
    if (token.length === 4 && /^\\[0-7]{3}$/.test(token)) {
      bytes.push(parseInt(token.slice(1), 8));
    } else if (token.startsWith('\\')) {
      bytes.push(...Buffer.from(C_ESCAPES[token[1]] ?? token[1], 'utf8'));
    } else {
      bytes.push(...Buffer.from(token, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Заголовок секции: "a/<path> b/<path>", где каждый путь может быть в кавычках.
const SECTION_HEADER = /^("(?:[^"\\]|\\[\s\S])*"|a\/.+?) ("(?:[^"\\]|\\[\s\S])*"|b\/.+?)(?:\n|$)/;

function filenameFromHeader(section: string): string | undefined {
  const header = section.match(SECTION_HEADER);
  if (!header) return undefined;
  const bSide = unquoteGitPath(header[2]);
  return bSide.startsWith('b/') ? bSide.slice(2) : undefined;
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const filename = filenameFromHeader(section);
    if (!filename) continue;
    if (!shouldReviewFile(filename)) continue;
    const lines = section.split('\n');
    let inHunk = false;
    let additions = 0;
    let deletions = 0;
    let hasNewSide = false;
    for (const line of lines) {
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { inHunk = true; continue; }
      if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git '))) {
        if (line.startsWith('+++ ')) hasNewSide = true;
        if (line.startsWith('diff --git ')) inHunk = false;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    if (!hasNewSide && !section.includes('+++ /dev/null')) continue;
    files.push({ filename, status: section.includes('new file mode') ? 'added' : section.includes('deleted file mode') ? 'removed' : 'modified', additions, deletions, patch: section.trim() });
  }
  return files;
}

export function splitPatch(patch: string, maxCharacters = 45000): string[] {
  if (patch.length <= maxCharacters) return [patch];
  const lines = patch.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxCharacters) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
