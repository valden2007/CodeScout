const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// Заголовок файла = пара строк "--- a/… | --- /dev/null" + "+++ b/… | +++ /dev/null".
// Одной строки "--- " недостаточно: удалённый SQL/Lua-комментарий "-- x" в диффе
// выглядит как "--- x" и не должен сбрасывать нумерацию хунка.
const FILE_OLD_HEADER = /^--- (?:a\/|\/dev\/null)/;
const FILE_NEW_HEADER = /^\+\+\+ (?:b\/|\/dev\/null)/;

function isFileHeaderAt(lines: string[], index: number): boolean {
  return index >= 0 && index + 1 < lines.length
    && FILE_OLD_HEADER.test(lines[index]) && FILE_NEW_HEADER.test(lines[index + 1]);
}

export function numberPatch(patch: string): string {
  let newLine = 0;
  let inHunk = false;
  const lines = patch.split('\n');
  return lines.map((line, index) => {
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      const parsed = Number(hunk[1]);
      if (Number.isNaN(parsed)) return line;
      newLine = parsed;
      inHunk = true;
      return line;
    }
    if (line.startsWith('diff --git ') || isFileHeaderAt(lines, index)) {
      inHunk = false;
      return line;
    }
    // Вторая строка пары заголовка ("+++ b/…") тоже не нумеруется.
    if (isFileHeaderAt(lines, index - 1)) return line;
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
