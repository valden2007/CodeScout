const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function numberPatch(patch: string): string {
  let newLine = 0;
  let inHunk = false;
  return patch.split('\n').map((line) => {
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      const parsed = Number(hunk[1]);
      if (Number.isNaN(parsed)) return line;
      newLine = parsed;
      inHunk = true;
      return line;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git ')) {
      inHunk = false;
      return line;
    }
    if (!inHunk || newLine === 0 || line.startsWith('\\')) return line;
    if (line.startsWith('+')) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith(' ')) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith('-')) return line;
    return line;
  }).join('\n');
}
