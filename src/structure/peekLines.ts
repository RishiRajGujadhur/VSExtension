/** The line at `line` trimmed (for the bar under a chart), and the lines from `line` to `endLine`, at most 12, without their common indentation (for the hover card). */
export function peekLines(lineAt: (i: number) => string, lineCount: number, line: number, endLine = line): { code: string; block: string } {
  if (line < 0 || line >= lineCount) return { code: '', block: '' };
  const last = Math.min(lineCount - 1, Math.max(line, endLine), line + 11);
  const lines: string[] = [];
  for (let i = line; i <= last; i++) lines.push(lineAt(i).replace(/\s+$/, ''));
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const block = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  const more = Math.max(line, endLine) - last;
  return { code: lineAt(line).trim().slice(0, 200), block: more > 0 ? `${block}\n// … ${more} more line${more === 1 ? '' : 's'}` : block };
}
