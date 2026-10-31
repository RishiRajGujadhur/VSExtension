/** The identifier-like word around an offset, with where it starts. */
export function wordAt(text: string, offset: number): { word: string; start: number } | undefined {
  const isWord = (c: string | undefined) => !!c && /[\w$#]/.test(c);
  let start = offset;
  while (start > 0 && isWord(text[start - 1])) {
    start--;
  }
  let end = offset;
  while (isWord(text[end])) {
    end++;
  }
  return end > start ? { word: text.slice(start, end), start } : undefined;
}

/**
 * Maps a cursor offset in an earlier version of a file to the same symbol in the current text, so
 * re-running an analysis after edits still targets the symbol it was started on.
 */
export function retarget(before: string, after: string, offset: number): number {
  if (before === after) {
    return offset;
  }
  const found = wordAt(before, offset);
  if (!found) {
    return Math.min(offset, after.length);
  }
  const pattern = new RegExp(`(?<![\\w$#])${found.word.replace(/[$#]/g, '\\$&')}(?![\\w$])`, 'g');
  const occurrences = (text: string) => [...text.matchAll(pattern)].map((m) => m.index);
  const old = occurrences(before);
  const current = occurrences(after);
  if (current.length === 0) {
    return Math.min(offset, after.length);
  }
  const within = offset - found.start;
  // Same number of occurrences: assume edits elsewhere and keep the same ordinal occurrence.
  if (old.length === current.length) {
    return current[old.indexOf(found.start)] + within;
  }
  // Otherwise the occurrence whose surrounding text matches best, nearest on ties.
  const score = (at: number) => context(before, found.start, after, at, found.word.length);
  const best = current.reduce((a, b) => {
    const difference = score(b) - score(a);
    return difference > 0 || (difference === 0 && Math.abs(b - found.start) < Math.abs(a - found.start)) ? b : a;
  });
  return best + within;
}

/** How many characters around two occurrences agree, looking up to 80 characters each way. */
function context(before: string, oldAt: number, after: string, newAt: number, length: number): number {
  let score = 0;
  for (let i = 1; i <= 80 && before[oldAt - i] !== undefined && before[oldAt - i] === after[newAt - i]; i++) {
    score++;
  }
  for (let i = 0; i < 80 && before[oldAt + length + i] !== undefined && before[oldAt + length + i] === after[newAt + length + i]; i++) {
    score++;
  }
  return score;
}
