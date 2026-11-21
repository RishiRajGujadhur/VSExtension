import { ControlFlowChart } from '../inspect/controlFlowChart';
import { FlowComparison } from '../inspect/flowCompare';

/**
 * Plain sentences that say what changed in a function, for the reel's captions and voice-over: "Returns 0 early when
 * items.length is falsy." "Changes 0.9 to 0.8 in sum = sum * 0.9." Built by rules from the flowchart comparison
 * (boxes added, changed and removed, and the edges between them), so the same change is always described the same
 * way, offline. At most `max` sentences, the most telling first.
 */
export function describeFunctionChange(name: string, chart: ControlFlowChart, comparison: FlowComparison, max = 4, diff: DiffText[] = []): string[] {
  const nodes = chart.nodes;
  const text = (id: number) => oneLine(nodes[id].text || nodes[id].lines.join(' '));
  if (comparison.isNew) {
    const decisions = nodes.filter((n) => ['decision', 'switch', 'loop'].includes(n.kind)).length;
    const calls = callsIn(nodes.map((n) => n.text).join('\n')).slice(0, 3);
    return [
      `Adds a new function, ${name}${decisions ? `, with ${plural(decisions, 'decision')} and ${plural(chart.paths.length, 'path')}` : ''}.`,
      ...(calls.length ? [`It ${doing(calls)}.`] : []),
    ].slice(0, max);
  }
  const added = new Set(comparison.added);
  const used = new Set<number>();
  const sentences: { weight: number; text: string }[] = [];

  // A new check whose branch ends at once: "Returns 0 early when …" / "Throws … when …".
  for (const id of comparison.added) {
    const n = nodes[id];
    if (n.kind !== 'decision') continue;
    const exits = chart.edges.filter((e) => e.from === id && added.has(e.to) && ['return', 'throw'].includes(nodes[e.to].kind));
    // The "yes" branch ending at once is an early exit; a new exit on the "no" branch is what happens otherwise.
    const exit = exits.find((e) => e.label !== 'no') ?? exits[0];
    if (exit) {
      const target = nodes[exit.to];
      const what = target.kind === 'return' ? `returns ${returned(text(exit.to)) || 'nothing'}` : `throws ${thrown(text(exit.to))}`;
      sentences.push({ weight: 10, text: exit.label === 'no' ? `Adds a check, ${text(id)}; otherwise ${what}.` : target.kind === 'return' ? `Returns ${returned(text(exit.to)) || 'early'} early when ${text(id)}.` : `Throws ${thrown(text(exit.to))} when ${text(id)}.` });
      used.add(id).add(exit.to);
    }
  }
  for (const id of comparison.added) {
    if (used.has(id)) continue;
    const n = nodes[id];
    const code = text(id);
    if (n.kind === 'decision') sentences.push({ weight: 8, text: `Adds a check: ${code}.` });
    else if (n.kind === 'switch') sentences.push({ weight: 8, text: `Adds a switch on ${code.replace(/^switch\s*/, '')}.` });
    else if (n.kind === 'loop') sentences.push({ weight: 8, text: `Adds a loop: ${short(code)}.` });
    else if (n.kind === 'return') sentences.push({ weight: 6, text: `Now returns ${returned(code) || 'here'}.` });
    else if (n.kind === 'throw') sentences.push({ weight: 7, text: `Now throws ${thrown(code)}.` });
    else if (n.kind === 'catch') sentences.push({ weight: 7, text: `Now catches errors here.` });
    else {
      const calls = callsIn(n.text);
      sentences.push({ weight: 5, text: calls.length ? `Now ${doing(calls.slice(0, 3))}.` : `Adds ${short(code)}.` });
    }
  }
  // Code changed in place: from the diff's own lines (exact, where a box's text may be cut short), else the boxes.
  const pairs = changedPairs(diff);
  if (pairs.length) for (const [from, to] of pairs.slice(0, 2)) sentences.push({ weight: 7, text: describeEdit(from, to) });
  else for (const c of comparison.changed) sentences.push({ weight: 7, text: describeBoxEdit(c.before, nodes[c.id].text) });
  // Plain lines added or removed that call something new, or no longer call it.
  if (comparison.changed.length && diff.length) {
    const addedCalls = callsIn(diff.filter((l) => l.kind === 'add' && !l.span).map((l) => l.text).join('\n'));
    const removedCalls = callsIn(diff.filter((l) => l.kind === 'del' && !l.span).map((l) => l.text).join('\n'));
    const fresh = addedCalls.filter((c) => !removedCalls.includes(c) && !sentences.some((x) => x.text.includes(c.replace(/^new /, ''))));
    const gone = removedCalls.filter((c) => !addedCalls.includes(c));
    if (fresh.length && !sentences.some((x) => x.text.startsWith('Now '))) sentences.push({ weight: 6, text: `Now ${doing(fresh.slice(0, 3))}.` });
    if (gone.length) sentences.push({ weight: 5, text: `No longer ${doing(gone.slice(0, 3))}.` });
  }
  for (const r of comparison.removed) {
    const code = oneLine(r.text);
    const calls = callsIn(r.text);
    sentences.push({
      weight: 6,
      text:
        r.kind === 'decision' ? `Drops the check ${short(code)}.`
        : r.kind === 'loop' ? `Drops the loop ${short(code)}.`
        : r.kind === 'return' ? `No longer returns ${returned(code) || 'there'}.`
        : r.kind === 'throw' ? `No longer throws ${thrown(code)}.`
        : calls.length ? `No longer ${doing(calls.slice(0, 3))}.`
        : `Removes ${short(code)}.`,
    });
  }
  const paths = [comparison.newPaths.length ? `${plural(comparison.newPaths.length, 'new path')}` : '', comparison.gonePaths.length ? `${plural(comparison.gonePaths.length, 'path')} no longer taken` : ''].filter(Boolean);
  if (paths.length) sentences.push({ weight: 3, text: `${capital(paths.join('; '))}.` });
  // The most telling first, in a stable order.
  const out = sentences
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((s) => s.text);
  // One "Now …" and one "No longer …" sentence is enough: the first, the most telling.
  const seen = new Set<string>();
  const once = unique(out).filter((sentence) => {
    const kind = /^(Now|No longer) /.exec(sentence)?.[1];
    if (!kind) return true;
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  return once.slice(0, max);
}

/** A line of a diff, as the describer reads it: `span` marks the words changed in a line changed in place. */
export interface DiffText {
  kind: string;
  text: string;
  span?: [number, number];
}

/** Lines changed in place, as (before, after) pairs: the k-th removed and k-th added line of a run, both marked. */
function changedPairs(diff: DiffText[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < diff.length; ) {
    if (diff[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < diff.length && diff[d].kind === 'del') d++;
    let a = d;
    while (a < diff.length && diff[a].kind === 'add') a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) if (diff[i + k].span && diff[d + k].span && !isComment(diff[i + k].text) && !isComment(diff[d + k].text)) out.push([diff[i + k].text, diff[d + k].text]);
    i = a;
  }
  return out;
}

/**
 * A box of several statements changed: what its lines say now that they did not before. One line changed in place
 * is described by its words ("Changes 0.9 to 0.8 in …"); lines only added or only removed by their calls or code.
 */
export function describeBoxEdit(before: string, after: string): string {
  const linesOf = (s: string) => s.split('\n').map(oneLine).filter((l) => l && !isComment(l) && !/^… \d+ more lines?$/.test(l));
  const old = linesOf(before);
  const now = linesOf(after);
  const removed = old.filter((l) => !now.includes(l));
  const added = now.filter((l) => !old.includes(l));
  const helpers = helpersIn(added).filter((h) => !helpersIn(removed).includes(h));
  if (helpers.length) return `Adds ${helpers.length === 1 ? 'a helper function' : 'helper functions'}, ${list(helpers.slice(0, 3).map((h) => `${h}()`))}.`;
  if (removed.length && added.length) {
    // The pair of lines most alike is the line changed in place.
    let best: [string, string] = [removed[0], added[0]];
    let bestScore = -1;
    for (const r of removed) for (const a of added) {
      const [from, to] = differingSpan(r, a);
      const score = 1 - (from.length + to.length) / Math.max(1, r.length + a.length);
      if (score > bestScore) [best, bestScore] = [[r, a], score];
    }
    const more = Math.max(removed.length, added.length) - 1;
    return bestScore > 0.3 ? `${describeEdit(best[0], best[1]).replace(/\.$/, '')}${more ? ` (and ${plural(more, 'more line')})` : ''}.` : `Rewrites ${short(added[0])}${more ? ` and ${plural(more, 'more line')}` : ''}.`;
  }
  if (added.length) {
    const calls = callsIn(added.join('\n')).filter((c) => !callsIn(removed.join('\n')).includes(c));
    return calls.length ? `Now ${doing(calls.slice(0, 3))}.` : `Adds ${short(added[0])}.`;
  }
  if (removed.length) {
    const calls = callsIn(removed.join('\n'));
    return calls.length ? `No longer ${doing(calls.slice(0, 3))}.` : `Removes ${short(removed[0])}.`;
  }
  return describeEdit(before, after);
}

/** "Changes 0.9 to 0.8 in sum = sum * 0.8." from the code before and after, by the words that differ. */
export function describeEdit(before: string, after: string): string {
  const [from, to] = differingSpan(before, after);
  const where = short(oneLine(after).replace(/;$/, ''), 48);
  if (!from && to) return `Adds ${quote(to)} to ${where}.`;
  if (from && !to) return `Removes ${quote(from)} from ${short(oneLine(before).replace(/;$/, ''), 48)}.`;
  if (from.length + to.length > 70) return `Rewrites ${where}.`;
  return `Changes ${quote(from)} to ${quote(to)} in ${where}.`;
}

/** The part of two pieces of code that differs, by tokens: what is left after the common start and end. */
export function differingSpan(before: string, after: string): [string, string] {
  const a = tokens(oneLine(before));
  const b = tokens(oneLine(after));
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [a.slice(start, a.length - end).join('').trim(), b.slice(start, b.length - end).join('').trim()];
}

/** Lines of a diff that are not in a function: imports, exports and calls added or removed. */
export function describeFileChange(file: string, added: string[], removed: string[], isNew: boolean, max = 3): string[] {
  const base = file.split('/').pop() ?? file;
  const out: string[] = [];
  if (isNew) out.push(`Adds a new file, ${base}, with ${plural(added.length, 'line')}.`);
  const imports = (lines: string[]) => lines.map((l) => /^\s*import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)).*?from\s+['"]([^'"]+)['"]/.exec(l)).filter(Boolean).map((m) => ({ names: (m![1] ?? m![2] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), from: m![3] }));
  const exports = (lines: string[]) => lines.map((l) => /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+(\w+)/.exec(l)?.[1]).filter((x): x is string => !!x);
  if (!isNew) {
    for (const imp of imports(added).slice(0, 2)) out.push(`Imports ${list(imp.names.slice(0, 3)) || 'a module'} from ${imp.from}.`);
    for (const imp of imports(removed).slice(0, 1)) out.push(`No longer imports ${list(imp.names.slice(0, 3)) || 'a module'} from ${imp.from}.`);
  }
  const newExports = exports(added).filter((e) => !exports(removed).includes(e));
  if (newExports.length) out.push(`Exports ${list(newExports.slice(0, 3))}.`);
  const goneExports = exports(removed).filter((e) => !exports(added).includes(e));
  if (goneExports.length) out.push(`No longer exports ${list(goneExports.slice(0, 3))}.`);
  if (!isNew && out.length < max) {
    const calls = callsIn(added.join('\n')).filter((c) => !callsIn(removed.join('\n')).includes(c)).slice(0, 3);
    if (calls.length) out.push(`Now ${doing(calls)}.`);
  }
  if (!out.length) out.push(`Changes ${plural(added.length + removed.length, 'line')} in ${base}: +${added.length} −${removed.length}.`);
  return unique(out).slice(0, max);
}

/**
 * The words a voice reads for a caption: operators said as words, names split ("trackWindowState" → "track window
 * state"), quotes and brackets dropped, so a system voice reads code sensibly.
 */
export function speakable(caption: string): string {
  return caption
    .replace(/`/g, '')
    .replace(/===?/g, ' equals ')
    .replace(/!==?/g, ' is not ')
    .replace(/\?\?/g, ' or else ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/<=/g, ' at most ')
    .replace(/>=/g, ' at least ')
    .replace(/(^|[\s(])!(?=[\w(])/g, '$1not ')
    .replace(/\s<\s/g, ' less than ')
    .replace(/\s>\s/g, ' greater than ')
    .replace(/=>/g, ' gives ')
    .replace(/\(\)/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$]/g, ' ')
    .replace(/\.(?=[A-Za-z])/g, ' dot ')
    .replace(/[{}[\]();"'`]/g, ' ')
    .replace(/−/g, 'minus ')
    .replace(/\+(\d)/g, 'plus $1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const short = (s: string, n = 56) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quote = (s: string) => short(s, 40);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unique = (list: string[]) => [...new Set(list)];
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const tokens = (s: string) => s.match(/[\w$@#.]+|\s+|[^\w\s]/g) ?? [];
const returned = (code: string) => code.replace(/^return\b\s*/, '').replace(/;$/, '').trim();
const thrown = (code: string) => short(code.replace(/^throw\s+(new\s+)?/, '').replace(/;$/, '').trim() || 'an error', 40);

const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'super', 'import', 'require']);
/** A line that is only a comment: a line comment, a block comment line, or -- in SQL. */
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|--|#(?!region))/.test(line);

/** Calls too common to tell anything about a change: array, map and string helpers, Math, JSON, console. */
const COMMON = /^(Math|JSON|console|Object|Array|String|Number|Promise)\.|\.(map|filter|forEach|push|pop|shift|get|has|set|add|delete|join|split|slice|splice|includes|indexOf|find|findIndex|some|every|reduce|sort|concat|toString|replace|trim|trimStart|trimEnd|startsWith|endsWith|toLowerCase|toUpperCase|keys|values|entries|then|catch|test|exec|match|matchAll)$/;

/**
 * What code calls (comments and strings left out), in order, without repeats and without the common helpers:
 * `a.b(…)` gives `a.b`, `new Panel(…)` gives `new Panel`.
 */
function callsIn(code: string): string[] {
  const out: string[] = [];
  const clean = code
    .split('\n')
    .filter((l) => !isComment(l))
    .map((l) => l.replace(/\/\/.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'))
    .join('\n');
  for (const m of clean.matchAll(/(new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const name = `${m[1] ? 'new ' : ''}${m[2]}`;
    if (!NOT_CALLS.has(m[2]) && !COMMON.test(m[2]) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** "creates ReelPanel and calls registerCommand()", for "Now …" and "No longer …". */
function doing(calls: string[]): string {
  const made = calls.filter((c) => c.startsWith('new ')).map((c) => c.slice(4));
  const called = calls.filter((c) => !c.startsWith('new ')).map((c) => `${c}()`);
  return [made.length ? `creates ${list(made)}` : '', called.length ? `calls ${list(called)}` : ''].filter(Boolean).join(' and ');
}

/** Functions declared in lines: `function sizeOf(` or `const sizeOf = (…) =>`. */
function helpersIn(lines: string[]): string[] {
  return lines
    .map((l) => /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1] ?? m[2]);
}
