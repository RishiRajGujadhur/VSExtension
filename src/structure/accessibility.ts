import { ReportNode, Tone } from './report';

/**
 * Words for what the colors and icons say, so screen reader users get the same information (WCAG 1.4.1: color is
 * never the only way something is conveyed; 4.1.2: every control has a name, role and state).
 */
export function toneWord(tone: Tone | undefined): string | undefined {
  return tone === 'error' ? 'Problem' : tone === 'warning' ? 'Warning' : tone === 'ok' ? 'Safe' : tone === 'info' ? 'Note' : undefined;
}

/** "cart.ts, line 12": read aloud more clearly than "cart.ts:12". */
export function spokenPlace(file: string, line: number): string {
  return `${file.replace(/^.*[\\/]/, '')}, line ${line + 1}`;
}

export interface RowState {
  /** What was done to the row, such as "fixed" or "unexported". */
  done?: string;
  /** The row has a quick fix. */
  fixable?: boolean;
  /** The row names a language construct the ? button explains. */
  explainable?: boolean;
}

/**
 * What a screen reader says for a result row: its tone, text, place and state, such as
 * "Warning: user.name, may be undefined here. cart.ts, line 12. Fix available."
 */
export function rowAccessibleLabel(node: ReportNode, state: RowState = {}): string {
  const tone = state.done ? undefined : toneWord(node.tone);
  const text = [node.label, node.description].filter(Boolean).join(', ');
  const parts = [`${tone ? `${tone}: ` : ''}${text}`];
  if (node.location) {
    parts.push(spokenPlace(node.location.file, node.location.line));
  }
  if (node.children?.length) {
    parts.push(`${node.children.length} ${node.children.length === 1 ? 'row' : 'rows'} inside`);
  }
  if (state.done) {
    parts.push(`Done: ${state.done}`);
  } else if (state.fixable) {
    parts.push('Fix available');
  }
  if (state.explainable) {
    parts.push('Explanation available');
  }
  return parts.join('. ') + '.';
}

/** The inspections status bar item read aloud: "TypeScript Structure: 2 errors, 1 warning in this file." */
export function inspectionStatusLabel(counts: { error: number; warning: number; info: number }, paused = false): string {
  if (paused) {
    return 'TypeScript Structure live inspections are paused. Open the inspections menu to resume them.';
  }
  const parts = (['error', 'warning', 'info'] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${kind === 'info' ? 'information' : kind}${counts[kind] === 1 || kind === 'info' ? '' : 's'}`);
  return `TypeScript Structure: ${parts.length ? parts.join(', ') : 'no problems'} in this file. Open the inspections menu.`;
}
