import { DiffFile } from './types';

const IGNORED_FILE = /(^|\/)(node_modules|vendor|dist|build)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(min\.(js|css)|map|png|jpe?g|gif|webp|ico|pdf|zip|woff2?)$/i;

export function shouldReviewFile(filename: string): boolean {
  return !IGNORED_FILE.test(filename);
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const header = section.match(/^a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!header) continue;
    const filename = header[2];
    if (!shouldReviewFile(filename)) continue;
    if (!section.match(/^\+\+\+ b\/.+$/m)) continue;
    const lines = section.split('\n');
    const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
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
