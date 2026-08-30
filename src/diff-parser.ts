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

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const header = section.match(/^a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!header) continue;
    const filename = header[2];
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
