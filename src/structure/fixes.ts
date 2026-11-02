import { pathKey } from '../analysis/paths';
import { TextEdit } from '../intentions/intentions';
import { ReportNode } from './report';

/** A fix stored on a report row: edits computed against the file text with the given hash. */
export interface RowFix {
  file: string;
  hash: string;
  edits: TextEdit[];
  title: string;
}

export function rowFix(node: ReportNode | undefined): RowFix | undefined {
  const action = node?.action;
  return action?.kind === 'applyFix' && typeof action.file === 'string' && typeof action.hash === 'string' && Array.isArray(action.edits)
    ? { file: action.file, hash: action.hash, edits: action.edits as TextEdit[], title: String(action.title ?? 'fix') }
    : undefined;
}

/**
 * The fixes at and below a row, merged into one per file. A row whose fix covers the rows under it
 * (an Inspect Code file row) stands for them, so nothing is fixed twice.
 */
export function fixesUnder(node: ReportNode, skip: (n: ReportNode) => boolean = () => false): RowFix[] {
  const byFile = new Map<string, RowFix[]>();
  const visit = (n: ReportNode): void => {
    if (skip(n)) {
      return;
    }
    const fix = rowFix(n);
    if (fix) {
      byFile.set(pathKey(fix.file), [...(byFile.get(pathKey(fix.file)) ?? []), fix]);
      if (n.children?.some((c) => rowFix(c))) {
        return;
      }
    }
    (n.children ?? []).forEach(visit);
  };
  visit(node);
  return [...byFile.values()].map((fixes) => ({
    file: fixes[0].file,
    hash: fixes[0].hash,
    edits: mergeEdits(fixes.filter((f) => f.hash === fixes[0].hash).flatMap((f) => f.edits)),
    title: fixes.length === 1 ? fixes[0].title : `${fixes.length} fixes`,
  }));
}

/** Counts the rows with a fix at or below a row, for its Fix All button. */
export function countFixes(node: ReportNode, skip: (n: ReportNode) => boolean = () => false): number {
  if (skip(node)) {
    return 0;
  }
  return (rowFix(node) && !node.children?.some((c) => rowFix(c)) ? 1 : 0) + (node.children ?? []).reduce((sum, c) => sum + countFixes(c, skip), 0);
}

/** The edits without repeats or any that overlap an earlier one, in file order. */
export function mergeEdits(edits: readonly TextEdit[]): TextEdit[] {
  const kept: TextEdit[] = [];
  for (const edit of edits) {
    if (!kept.some((k) => sameEdit(k, edit) || (edit.start < k.end && k.start < edit.end))) {
      kept.push(edit);
    }
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Remembers the fixes applied to each file since its analysis, so another row's fix, computed against
 * the text before them, can still be applied: its offsets are moved past the earlier edits, and edits
 * already made (a file's fix-all after one of its rows was fixed) are left out.
 */
export class FixLedger {
  private readonly files = new Map<string, { base: string; current: string; steps: TextEdit[][] }>();

  /** The fix's edits for the file as it is now (`currentHash`), or undefined when they can't be placed. */
  rebase(fix: RowFix, currentHash: string): TextEdit[] | undefined {
    if (fix.hash === currentHash) {
      return fix.edits;
    }
    const entry = this.files.get(pathKey(fix.file));
    if (!entry || entry.base !== fix.hash || entry.current !== currentHash) {
      return undefined;
    }
    let edits = fix.edits;
    for (const step of entry.steps) {
      const moved: TextEdit[] = [];
      for (const edit of edits) {
        const result = shift(edit, step);
        if (result === 'conflict') {
          return undefined;
        }
        if (result !== 'done') {
          moved.push(result);
        }
      }
      edits = moved;
    }
    return edits;
  }

  /** Records edits just applied to the file, given in its coordinates before them. */
  record(file: string, applied: TextEdit[], before: string, after: string): void {
    const key = pathKey(file);
    const entry = this.files.get(key);
    if (entry && entry.current === before) {
      entry.steps.push(applied);
      entry.current = after;
    } else {
      this.files.set(key, { base: before, current: after, steps: [applied] });
    }
  }
}

/** The edit moved past earlier edits to the same text: `done` when it is one of them, `conflict` when it touches one. */
function shift(edit: TextEdit, earlier: readonly TextEdit[]): TextEdit | 'done' | 'conflict' {
  let delta = 0;
  for (const e of earlier) {
    if (sameEdit(e, edit)) {
      return 'done';
    }
    if (e.end <= edit.start) {
      delta += e.text.length - (e.end - e.start);
    } else if (e.start < edit.end) {
      return 'conflict';
    }
  }
  return { ...edit, start: edit.start + delta, end: edit.end + delta };
}

function sameEdit(a: TextEdit, b: TextEdit): boolean {
  return a.start === b.start && a.end === b.end && a.text === b.text;
}
