/** What a C# reference does with the symbol it names. */
export type UsageKind = 'definition' | 'call' | 'write' | 'read';

/** What a reference does, from the code just around it: a call `x(`, `new X(`, an assignment `x =`, `x += …`, `x++`. */
export function classifyCSharpUsage(lineText: string, start: number, end: number): Exclude<UsageKind, 'definition'> {
  const before = lineText.slice(0, start);
  const after = lineText.slice(end);
  if (/^\s*(<[^<>()]*>)?\s*\(/.test(after) || /\bnew\s+$/.test(before)) return 'call';
  if (/^\s*(\+\+|--)/.test(after) || /(\+\+|--)\s*$/.test(before)) return 'write';
  if (/^\s*([-+*/%&|^]|\?\?|<<|>>)?=(?!=|>)/.test(after)) return 'write';
  if (/\b(out|ref)\s+$/.test(before)) return 'write';
  return 'read';
}
