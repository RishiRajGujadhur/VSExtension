/**
 * A replacement whose text may be built from the (already rewritten) text of ranges inside it.
 * This lets edits nest: `f(f(1, 2), 3)` rewrites the inner call's arguments and then uses the
 * result when rewriting the outer call's arguments.
 */
export interface Edit {
  start: number;
  end: number;
  render: (sub: (start: number, end: number) => string) => string;
}

export function replace(start: number, end: number, text: string): Edit {
  return { start, end, render: () => text };
}

/** Applies edits to text. Edits may nest but must not partially overlap; duplicate ranges keep the first. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  // Insertions sort before a replacement starting at the same offset, so they land in front of it.
  const isInsertion = (edit: Edit) => (edit.start === edit.end ? 0 : 1);
  const sorted = dedupe([...edits].sort((a, b) => a.start - b.start || isInsertion(a) - isInsertion(b) || b.end - a.end));
  const open: Edit[] = [];
  for (const edit of sorted) {
    while (open.length > 0 && open[open.length - 1].end <= edit.start) {
      open.pop();
    }
    const parent = open[open.length - 1];
    if (parent && edit.end > parent.end) {
      throw new Error(`Overlapping edits at ${edit.start}-${edit.end} and ${parent.start}-${parent.end}`);
    }
    open.push(edit);
  }

  /** The text of [start, end) with the outermost edits inside it applied; those render their own insides. */
  const within = (start: number, end: number, self: Edit | undefined): string => {
    let out = '';
    let cursor = start;
    for (const edit of sorted) {
      if (edit === self || edit.start < cursor || edit.end > end) {
        continue;
      }
      out += text.slice(cursor, edit.start) + edit.render((s, e) => within(s, e, edit));
      cursor = edit.end;
    }
    return out + text.slice(cursor, end);
  };
  return within(0, text.length, undefined);
}

function dedupe(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.start}:${edit.end}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
