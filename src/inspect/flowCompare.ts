import { ControlFlowChart } from './controlFlowChart';

/**
 * A function's flowchart now, compared with the same function in another version of its file (the last commit):
 * which boxes are new, which changed, which are gone, and which paths through the function are new or gone.
 * Deterministic: boxes are matched by kind and code, in order, with no guessing beyond that.
 */
export interface FlowComparison {
  /** What it was compared with, as people say it: "the last commit". */
  against: string;
  /** Boxes of the chart now that were not there before. */
  added: number[];
  /** Boxes of the chart now whose code changed, with the code they had. */
  changed: { id: number; before: string }[];
  /** Boxes that were there before and are gone, with their code and the line they were on. */
  removed: { kind: string; text: string; line?: number }[];
  /** Paths of the chart now that it did not have, by index. */
  newPaths: number[];
  /** Paths it had and has no longer: how each ended and the branches it took. */
  gonePaths: { ending: string; steps: string[] }[];
  /** How many boxes are the same. */
  unchanged: number;
  /** Not found by name, so matched by where it is in the file. */
  byPosition?: boolean;
  /** The function was not in that version (a new function): every box counts as added. */
  isNew?: boolean;
}

type Chart = Pick<ControlFlowChart, 'nodes' | 'paths'>;
type Box = Chart['nodes'][number];

const isTerminal = (n: Box) => n.kind === 'start' || n.kind === 'end';
/** Boxes of a called function expanded in place (ƒ+) are not the function's own code: they are left out. */
const ownBox = (n: Box) => !n.owner;
const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();
/** A box's identity across versions: its kind and its code, ignoring spacing and line breaks. */
const keyOf = (n: Box) => (isTerminal(n) ? n.kind : `${n.kind}\u0000${squeeze(n.text || n.lines.join(' '))}`);

/** Compares the chart now (`after`) with the chart of the same function before. */
export function compareCharts(before: Chart | undefined, after: Chart, against = 'the last commit'): FlowComparison {
  if (!before) {
    return {
      against,
      added: after.nodes.filter((n) => !isTerminal(n) && ownBox(n)).map((n) => n.id),
      changed: [],
      removed: [],
      newPaths: after.paths.map((_, i) => i),
      gonePaths: [],
      unchanged: 0,
      isNew: true,
    };
  }
  // Boxes with the same kind and code are the same box, taken in order so that two identical boxes pair up one to one.
  const waiting = new Map<string, Box[]>();
  for (const n of before.nodes) {
    if (isTerminal(n) || !ownBox(n)) continue;
    const list = waiting.get(keyOf(n)) ?? [];
    list.push(n);
    waiting.set(keyOf(n), list);
  }
  let unchanged = 0;
  const unmatched: Box[] = [];
  for (const n of after.nodes) {
    if (isTerminal(n) || !ownBox(n)) continue;
    const same = waiting.get(keyOf(n))?.shift();
    if (same) unchanged++;
    else unmatched.push(n);
  }
  const left = [...waiting.values()].flat().sort((a, b) => a.id - b.id);
  // What is left on both sides: a box of the same kind with code alike enough is that box changed, the most alike
  // pairs first; the rest are new or gone.
  const candidates: { n: Box; old: Box; score: number }[] = [];
  for (const n of unmatched) {
    for (const old of left) {
      if (old.kind !== n.kind) continue;
      const score = similarity(n.text || n.lines.join(' '), old.text || old.lines.join(' '));
      if (score >= 0.4) candidates.push({ n, old, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.n.id - b.n.id || a.old.id - b.old.id);
  const paired = new Map<number, Box>();
  const taken = new Set<number>();
  for (const c of candidates) {
    if (paired.has(c.n.id) || taken.has(c.old.id)) continue;
    paired.set(c.n.id, c.old);
    taken.add(c.old.id);
  }
  const changed: FlowComparison['changed'] = [];
  const added: number[] = [];
  for (const n of unmatched) {
    const old = paired.get(n.id);
    if (old) changed.push({ id: n.id, before: old.text || old.lines.join('\n') });
    else added.push(n.id);
  }
  left.splice(0, left.length, ...left.filter((old) => !taken.has(old.id)));
  const removed = left.map((n) => ({ kind: n.kind, text: n.text || n.lines.join('\n'), line: n.location ? n.location.line + 1 : undefined }));

  // A path is the same path when it goes through the same boxes (by kind and code) and ends the same way.
  const signature = (chart: Chart, p: Chart['paths'][number]) => `${p.nodes.filter((id) => ownBox(chart.nodes[id])).map((id) => keyOf(chart.nodes[id])).join('\u0001')}\u0002${p.ending}`;
  const counts = new Map<string, number>();
  for (const p of before.paths) counts.set(signature(before, p), (counts.get(signature(before, p)) ?? 0) + 1);
  const newPaths: number[] = [];
  after.paths.forEach((p, i) => {
    const s = signature(after, p);
    const left = counts.get(s) ?? 0;
    if (left > 0) counts.set(s, left - 1);
    else newPaths.push(i);
  });
  const gonePaths: FlowComparison['gonePaths'] = [];
  for (const p of before.paths) {
    const s = signature(before, p);
    const left = counts.get(s) ?? 0;
    if (left > 0) {
      counts.set(s, left - 1);
      gonePaths.push({ ending: p.ending, steps: p.steps.map((step) => step.text) });
    }
  }
  return { against, added, changed, removed, newPaths, gonePaths, unchanged };
}

/** How alike two pieces of code are, from 0 to 1: the share of their words and symbols they have in common. */
function similarity(a: string, b: string): number {
  const tokens = (s: string) => s.match(/[\w$@#]+|[^\s\w]/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens(a)) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  const other = tokens(b);
  for (const t of other) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(t, left - 1);
    }
  }
  const total = tokens(a).length + other.length;
  return total ? (2 * shared) / total : 0;
}

/** The name a chart's function is called by in code: `Price` for `Cart.Price`, `usp_Grade` for `[dbo].[usp_Grade]`. */
export function shortName(chartName: string): string | undefined {
  const last = chartName.replace(/\(\)$/, '').split('.').pop()?.replace(/^\[|\]$/g, '');
  return last && /^[@#$\w]+$/.test(last) ? last : undefined;
}

/**
 * Finds the chart of the same function in another version of the file. `chartAt` draws the chart of the function at
 * an offset of that text (throwing when there is none). The function is the one with the same name; when several
 * functions share it (overloads, methods of different classes), the one in the same place among them, counted the same
 * way in the text now. Functions without a name are matched by line.
 */
export async function findSameFunction(
  now: { text: string; chart: Pick<ControlFlowChart, 'name' | 'anchor'> },
  beforeText: string,
  chartAt: (text: string, offset: number) => Promise<ControlFlowChart>,
): Promise<{ chart: ControlFlowChart | undefined; byPosition?: boolean }> {
  const name = shortName(now.chart.name);
  if (name) {
    const ordinal = (await namedCharts(now.text, name, now.chart.name, chartAt)).indexOf(now.chart.anchor);
    const anchors = await namedCharts(beforeText, name, now.chart.name, chartAt);
    if (anchors.length) {
      const anchor = anchors[Math.min(Math.max(ordinal, 0), anchors.length - 1)];
      return { chart: await chartAt(beforeText, anchor) };
    }
    return { chart: undefined };
  }
  // No name to go by: the function on the same line, if it has the same (lack of a) name.
  const line = now.text.slice(0, now.chart.anchor).split('\n').length - 1;
  const lines = beforeText.split('\n');
  if (line >= lines.length) return { chart: undefined };
  const offset = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + (lines[line].length - lines[line].trimStart().length);
  try {
    const chart = await chartAt(beforeText, offset);
    return chart.name === now.chart.name ? { chart, byPosition: true } : { chart: undefined };
  } catch {
    return { chart: undefined };
  }
}

/** The anchors of the functions called `fullName` in the text, in order, found from where `name` is written. */
async function namedCharts(text: string, name: string, fullName: string, chartAt: (text: string, offset: number) => Promise<ControlFlowChart>): Promise<number[]> {
  const escaped = name.replace(/[$]/g, '\\$');
  const pattern = new RegExp(`(?<![\\w$@#])${escaped}(?![\\w$@#])`, 'g');
  const anchors = new Set<number>();
  let tries = 0;
  for (let m = pattern.exec(text); m && tries < 60; m = pattern.exec(text), tries++) {
    try {
      const chart = await chartAt(text, m.index);
      if (chart.name === fullName) anchors.add(chart.anchor);
    } catch {
      // Not in a function here (a comment, or a field).
    }
  }
  return [...anchors].sort((a, b) => a - b);
}
