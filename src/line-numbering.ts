const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function numberPatch(patch: string): string {
  let newLine = 0;
  return patch.split('\n').map((line) => {
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      return line;
    }
    if (newLine === 0 || line.startsWith('\\')) return line;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith(' ')) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith('-') && !line.startsWith('---')) return line;
    return line;
  }).join('\n');
}
