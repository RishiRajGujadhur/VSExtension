import type { DiffLine } from './plan';
import { IntentKind, lineSignal } from './intent';

/**
 * The key change in a piece of a diff: the few lines that matter most, so the Git reel shows them large instead of
 * the whole diff. Every changed line gets a weight (a new check or early exit, a list changed, a request made weigh
 * most; imports, logging, comments, braces and lines only re-spaced weigh nothing), and the best short run of
 * changed lines wins, with a line of context around it.
 */

export interface KeyChange {
  /** The lines to show: the key run with its context, in diff order. */
  lines: DiffLine[];
  /** Index in `lines` of the line that matters most, for the callout. */
  focus: number;
  /** The sum of the weights of the changed lines shown. */
  score: number;
  /** What the key lines do, by the intent patterns that matched, the strongest first. */
  kinds: IntentKind[];
}

/** At most this many changed lines in a key change. */
export const KEY_CHANGED = 6;
/** At most this many lines, context and gaps included. */
export const KEY_SPAN = 10;

const CONTROL = /^\s*(\}\s*)?(if|else|switch|case|default|return|throw|try|catch|finally|for|foreach|while|do|await|yield|break|continue|BEGIN\s+TRY|BEGIN\s+CATCH|RAISERROR|THROW)\b/i;

/** How much a changed line matters. */
export function lineWeight(line: DiffLine): number {
  if (line.kind !== 'add' && line.kind !== 'del') return 0;
  const raw = line.text;
  const t = raw.trim();
  if (!t || /^[{}()[\];,]+$/.test(t) || /^<\/[\w.]*>$/.test(t)) return 0;
  if (/^(\/\/|\/\*|\*|--|#(?!\w+\s*\())/.test(t)) return 0.2;
  if (/^(import\b|using\s+[\w.]+;|export\s+\{|export\s+\*|.*=\s*require\()/.test(t)) return 0.3;
  // Logging says what happens, it does not make it happen.
  if (/^(await\s+)?(console\.\w+|logger\.\w+|log|debug|trace)\(|^PRINT\b/i.test(t)) return 0.4;
  // A line changed in place whose changed part is only spacing, quotes or punctuation.
  if (line.span) {
    const part = raw.slice(line.span[0], line.span[1]);
    if (!/[\w$@]/.test(part)) return 0.1;
  }
  const { weight: signal } = lineSignal(raw);
  let w = 1 + Math.max(-0.8, signal * 0.5);
  if (CONTROL.test(t)) w += 2;
  if (/^\s*if\s*\(.*\)\s*(return|throw)\b/.test(raw)) w += 1;
  else if (/[\w$\])]\s*\(/.test(t)) w += 1;
  if (/^[\w$.[\]'"]+\s*[+\-*/|&?]?=[^=>]/.test(t) || /^(const|let|var)\s/.test(t)) w += 0.5;
  // Types and interface members say what data looks like, not what the code does.
  if (/^(export\s+)?(interface|type)\s/.test(t) || /^[\w$]+\??\s*:\s*[\w$<>[\]|' "]+;?$/.test(t)) w = Math.min(w, 0.8);
  // Only a message or a label changed: worth showing, not first.
  if (line.span && /^['"`].*['"`]$/.test(raw.slice(line.span[0], line.span[1]).trim())) w = Math.min(w, 1);
  // A line changed in place shows twice (old and new): each half counts a little less.
  if (line.span) w *= 0.75;
  return Math.round(w * 100) / 100;
}

/** The key change in a diff's lines (one function's, or one file's). */
export function keyChange(lines: DiffLine[], maxChanged = KEY_CHANGED, maxSpan = KEY_SPAN): KeyChange {
  const weights = lines.map(lineWeight);
  const changed = lines.map((l, i) => (l.kind === 'add' || l.kind === 'del' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return { lines: lines.slice(0, maxSpan), focus: 0, score: 0, kinds: [] };
  let best = { from: changed[0], to: changed[0], score: -1 };
  for (let a = 0; a < changed.length; a++) {
    let score = 0;
    for (let b = a; b < changed.length && b - a < maxChanged; b++) {
      const from = changed[a];
      const to = changed[b];
      if (to - from + 1 > maxSpan) break;
      // No run across a gap between hunks.
      if (lines.slice(from, to + 1).some((l) => l.kind === 'gap')) break;
      // Lines that weigh next to nothing never make a run longer.
      score += weights[to] >= 0.5 ? weights[to] : 0;
      // A tighter run wins a tie; a longer one must add something.
      if (score > best.score + 0.05 || (Math.abs(score - best.score) <= 0.05 && to - from < best.to - best.from)) best = { from, to, score };
    }
  }
  // Removed lines just above the run are the old version of it: shown with it when there is room.
  let { from, to } = best;
  while (from > 0 && lines[from - 1].kind === 'del' && lines[from].kind !== 'ctx' && to - from + 2 <= maxSpan) from--;
  // Trailing lines that weigh nothing are left out, then a line of context on each side.
  while (to > from && weights[to] < 0.5) to--;
  while (from < to && weights[from] < 0.5 && lines[from].kind !== 'del') from++;
  if (from > 0 && lines[from - 1].kind === 'ctx' && to - from + 2 <= maxSpan + 1) from--;
  if (to < lines.length - 1 && lines[to + 1].kind === 'ctx' && to - from + 2 <= maxSpan + 2) to++;
  const shown = lines.slice(from, to + 1);
  let focus = 0;
  shown.forEach((l, i) => {
    // The strongest line, the new version first.
    const w = weights[from + i] + (l.kind === 'add' ? 0.01 : 0);
    if (w > weights[from + focus] + (shown[focus].kind === 'add' ? 0.01 : 0)) focus = i;
  });
  const kinds: IntentKind[] = [];
  for (const l of shown) if (l.kind === 'add' || l.kind === 'del') for (const k of lineSignal(l.text).kinds) if (!kinds.includes(k)) kinds.push(k);
  return { lines: shown, focus, score: Math.round(best.score * 100) / 100, kinds };
}

/**
 * The lines moved left by the indent they all share, so the code reads large; the marked spans move with them.
 */
export function dedent(lines: DiffLine[]): DiffLine[] {
  const indents = lines.filter((l) => l.kind !== 'gap' && l.text.trim()).map((l) => /^[ \t]*/.exec(l.text.replace(/\t/g, '  '))![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  if (!cut) return lines;
  return lines.map((l) => {
    if (l.kind === 'gap') return l;
    const text = l.text.replace(/\t/g, '  ');
    // A tab is two spaces from here on: the spans are moved for every tab before them.
    const shift = (at: number) => at + (l.text.slice(0, at).match(/\t/g)?.length ?? 0) - cut;
    return { ...l, text: text.slice(Math.min(cut, text.length - text.trimStart().length)), ...(l.span ? { span: [Math.max(0, shift(l.span[0])), Math.max(0, shift(l.span[1]))] as [number, number] } : {}) };
  });
}
