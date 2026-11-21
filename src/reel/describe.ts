import * as path from 'path';
import ts = require('typescript');
import { ControlFlowChart } from '../inspect/controlFlowChart';
import { FlowComparison } from '../inspect/flowCompare';
import { callPhrase, conditionWords, declarationPhrase, exitPhrase, listWords, loopPhrase, noun, settingPhrase, valueWords, verbPhrase, words } from './words';

/**
 * What a change does, in plain sentences, for the Git reel's captions and voice-over: "applyCoupon now returns 0
 * early when the amount is at most 0." "This new file adds validateSettings, which validates the settings." Built by
 * rules from the code (its flowchart, its lines, its syntax), never counts of boxes or lines, and never a model: the
 * same change always reads the same, offline.
 */

/** A line of a diff, as the describer reads it: `span` marks the words changed in a line changed in place. */
export interface DiffText {
  kind: string;
  text: string;
  span?: [number, number];
}

interface Phrase {
  /** "now …", "no longer …", or a sentence of its own. */
  mode: 'now' | 'no longer' | 'is';
  text: string;
  weight: number;
}

/** Sentences for a function that changed (or is new): the most telling first, at most `max`. */
export function describeFunctionChange(name: string, chart: ControlFlowChart, comparison: FlowComparison, max = 3, diff: DiffText[] = []): string[] {
  const nodes = chart.nodes;
  const textOf = (id: number) => oneLine(nodes[id].text || nodes[id].lines.join(' '));
  if (comparison.isNew) return describeNewFunction(name, chart).slice(0, max);

  const added = new Set(comparison.added);
  const used = new Set<number>();
  const phrases: Phrase[] = [];
  const edgeFrom = (id: number) => chart.edges.filter((e) => e.from === id);

  for (const id of comparison.added) {
    const n = nodes[id];
    if (n.kind !== 'decision' || used.has(id)) continue;
    const cond = conditionWords(stripIf(textOf(id)));
    // A check whose branch ends at once: an early exit.
    const exits = edgeFrom(id).filter((e) => added.has(e.to) && ['return', 'throw'].includes(nodes[e.to].kind));
    const exit = exits.find((e) => e.label !== 'no') ?? exits[0];
    if (exit) {
      const what = exitPhrase(textOf(exit.to), nodes[exit.to].kind);
      phrases.push({ mode: 'now', weight: what === 'stops' ? 8 : 10, text: exit.label === 'no' ? `checks whether ${cond}, and otherwise ${what}` : `${what} early when ${cond}` });
      used.add(id).add(exit.to);
      continue;
    }
    // A check that leads to a new step: "tracks the window state when primary is set".
    const step = edgeFrom(id).find((e) => e.label !== 'no' && added.has(e.to) && nodes[e.to].kind === 'statement');
    const action = step && firstAction(nodes[step.to].text || nodes[step.to].lines.join('\n'));
    if (step && action) {
      phrases.push({ mode: 'now', weight: 9, text: `${action} when ${cond}` });
      used.add(id).add(step.to);
      continue;
    }
    phrases.push({ mode: 'now', weight: 7, text: `checks whether ${cond}` });
    used.add(id);
  }
  for (const id of comparison.added) {
    if (used.has(id)) continue;
    const n = nodes[id];
    const code = textOf(id);
    if (n.kind === 'loop') phrases.push({ mode: 'now', weight: 8, text: loopPhrase(code) });
    else if (n.kind === 'switch') phrases.push({ mode: 'now', weight: 8, text: `chooses what to do based on ${valueWords(stripIf(code.replace(/^switch\s*/, '')))}` });
    else if (n.kind === 'return' || n.kind === 'throw') phrases.push({ mode: 'now', weight: 6, text: exitPhrase(code, n.kind) });
    else if (n.kind === 'catch') {
      // What it does with the error, from the first step after the catch.
      const next = chart.edges.find((e) => e.from === id)?.to;
      const after = next !== undefined ? actionsIn(nodes[next].text || nodes[next].lines.join('\n'))[0] : undefined;
      const reports = !!after && /^(shows|logs|reports|sends|updates|sets|clears) /.test(after);
      phrases.push({ mode: 'now', weight: 7, text: reports ? `${after} if something goes wrong` : 'carries on safely if something goes wrong' });
      if (next !== undefined && reports) used.add(next);
    }
    else if (n.kind === 'finally') phrases.push({ mode: 'now', weight: 5, text: 'always tidies up at the end' });
    else for (const action of actionsIn(n.text || n.lines.join('\n')).slice(0, 2)) phrases.push({ mode: 'now', weight: 6, text: action });
  }

  // Code changed in place: from the diff's own lines (exact), else from the boxes.
  const pairs = changedPairs(diff);
  for (const [before, after] of pairs.slice(0, 3)) {
    const phrase = describeLineChange(before, after);
    if (phrase) phrases.push({ mode: 'now', weight: 7, text: phrase });
  }
  // A one-line step rewritten too much for the diff to pair its lines: the step before and after, side by side.
  if (!pairs.length) {
    for (const c of comparison.changed.slice(0, 3)) {
      const now = (nodes[c.id].text || '').trim();
      if (c.before.includes('\n') || now.includes('\n')) continue;
      const phrase = describeLineChange(c.before, now);
      if (phrase) phrases.push({ mode: 'now', weight: 7, text: phrase });
    }
  }
  if (comparison.changed.length) {
    const source = diff.length
      ? { added: diff.filter((l) => l.kind === 'add' && !l.span).map((l) => l.text), removed: diff.filter((l) => l.kind === 'del' && !l.span).map((l) => l.text) }
      : boxLines(comparison, nodes);
    const helpers = helpersIn(source.added).filter((h) => !helpersIn(source.removed).includes(h));
    for (const h of helpers.slice(0, 1)) phrases.push({ mode: 'now', weight: 6, text: `uses a new helper, ${h}, which ${verbPhrase(h)}` });
    const gained = actionsIn(source.added.join('\n')).filter((a) => !actionsIn(source.removed.join('\n')).includes(a));
    const lost = actionsIn(source.removed.join('\n')).filter((a) => !actionsIn(source.added.join('\n')).includes(a));
    for (const a of gained.slice(0, 2)) phrases.push({ mode: 'now', weight: 5, text: a });
    for (const a of lost.slice(0, 1)) phrases.push({ mode: 'no longer', weight: 5, text: a });
  }
  for (const r of comparison.removed) {
    const code = oneLine(r.text);
    if (r.kind === 'decision') phrases.push({ mode: 'no longer', weight: 6, text: `checks whether ${conditionWords(stripIf(code))}` });
    else if (r.kind === 'loop') phrases.push({ mode: 'no longer', weight: 6, text: loopPhrase(code) });
    else if (r.kind === 'return' || r.kind === 'throw') phrases.push({ mode: 'no longer', weight: 5, text: exitPhrase(code, r.kind) });
    else for (const a of actionsIn(r.text).slice(0, 1)) phrases.push({ mode: 'no longer', weight: 4, text: a });
  }
  const sentences = toSentences(name, phrases);
  return sentences.length ? sentences.slice(0, max) : [`${name} works a little differently now.`];
}

/** A new function: what its name says it does, and what it does along the way. */
function describeNewFunction(name: string, chart: ControlFlowChart): string[] {
  const traits: string[] = [];
  for (const n of chart.nodes) {
    const code = oneLine(n.text || n.lines.join(' '));
    if (n.kind === 'loop') traits.push(loopPhrase(code));
    else if (n.kind === 'decision') {
      const exit = chart.edges.find((e) => e.from === n.id && e.label !== 'no' && ['return', 'throw'].includes(chart.nodes[e.to].kind));
      if (exit) traits.push(`${exitPhrase(oneLine(chart.nodes[exit.to].text), chart.nodes[exit.to].kind)} early when ${conditionWords(stripIf(code))}`);
    } else if (n.kind === 'statement') traits.push(...actionsIn(n.text || n.lines.join('\n')));
    else if (n.kind === 'catch') traits.push('handles errors');
  }
  const unique = [...new Set(traits)].slice(0, 2);
  return [`${name} is new: it ${verbPhrase(name)}.`, ...(unique.length ? [`It ${listWords(unique)}.`] : [])];
}

/** "applyCoupon now returns 0 early …", then "It also …", one sentence per phrase. */
function toSentences(name: string, phrases: Phrase[]): string[] {
  const seen = new Set<string>();
  const ordered = phrases
    .filter((p) => readable(p.text))
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .filter((p) => {
      const key = `${p.mode}:${p.text.replace(/ (early )?when .*$/, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return ordered.map((p, i) => {
    const subject = i === 0 ? name : 'It';
    if (p.mode === 'is') return `${p.text}.`;
    if (p.mode === 'no longer') return `${subject}${i === 0 ? '' : ' also'} no longer ${p.text}.`;
    if (i === 0) return `${subject} now ${p.text}.`;
    // "It also …", then "And it …", so three sentences in a row do not all start the same way.
    return i === 1 ? `It also ${p.text}.` : `And it ${p.text}.`;
  });
}

/**
 * Whether a phrase reads as English: no operators or dotted names left in it (outside quotes), not a single word,
 * not too long. The rest are left out rather than read out as code.
 */
export function readable(phrase: string): boolean {
  const bare = phrase.replace(/"[^"]*"/g, '""');
  return phrase.length <= 110 && /\s/.test(phrase.trim()) && !/[*/+=<>!?{}()[\]|&;`]|[A-Za-z_]\.[A-Za-z_]|\s-\s/.test(bare);
}

/** One line changed in place, as what it now does differently. */
function describeLineChange(before: string, after: string): string | undefined {
  const a = oneLine(after).replace(/;$/, '');
  const b = oneLine(before).replace(/;$/, '');
  if (isComment(a) || isComment(b)) return undefined;
  const ca = conditionIn(a);
  const cb = conditionIn(b);
  if (ca !== undefined && cb !== undefined) {
    const now = conditionWords(ca);
    const was = conditionWords(cb);
    return now === was ? undefined : `checks whether ${now}, instead of whether ${was}`;
  }
  if (/^return\b/.test(a) && /^return\b/.test(b)) {
    // What the returned value gains: rounding, a fallback, a call it goes through.
    if (/Math\.(round|floor|ceil|trunc)\(/.test(a) && !/Math\.(round|floor|ceil|trunc)\(/.test(b)) return 'rounds what it returns';
    if (/\?\?|\|\|/.test(a) && !/\?\?|\|\|/.test(b)) return 'falls back to a default when there is no value';
    const now = exitPhrase(a, 'return');
    const was = valueWords(b.replace(/^return\s*/, '')) || 'nothing';
    if (now.replace(/^returns /, '') === was) {
      const gained = callPhrase(a.replace(/^return\s*/, ''));
      return gained && gained !== callPhrase(b.replace(/^return\s*/, '')) ? `${gained} before returning` : undefined;
    }
    return `${now} instead of ${was}`;
  }
  const [from, to] = differingSpan(b, a);
  const literal = /^(-?\d[\d_.]*|"[^"]*"|'[^']*'|`[^`]*`|true|false|null|undefined)$/;
  const subject = /^(?:const|let|var)?\s*([\w$.]+)\s*[-+*/]?=(?!=)/.exec(a)?.[1] ?? /^\s*["']?([\w$]+)["']?\s*:/.exec(a)?.[1];
  if (literal.test(from) && literal.test(to)) return `uses ${to} instead of ${from}${subject ? ` for ${noun(subject)}` : ''}`;
  const callA = callPhrase(a);
  const callB = callPhrase(b);
  if (callA && callA === callB) return undefined;
  if (callA && callA !== callB) return callA;
  return undefined;
}

/** Calls that say little about what code does: list and text helpers. */
const VAGUE = /^(adds to the list|turns each one into something else|keeps only some of them|goes through each one|joins them together|splits it up|tidies the text|replaces part of it|looks for one|waits for it|keeps it within limits|rounds the number|goes through the object|finds part of the page|changes how it looks|removes from the list|creates a new (set|map|array|object|date|reg exp|promise|URL))$/;

/** What lines of code do, one phrase per line that does something: calls, settings of values. */
function actionsIn(code: string): string[] {
  const out: string[] = [];
  for (const raw of code.split('\n')) {
    const line = oneLine(raw).replace(/;$/, '');
    if (!line || isComment(line) || /^[})\]]/.test(line) || /^(import|export\s+\{)/.test(line)) continue;
    // Something put on screen: "<Button" → "shows a button".
    const shown = jsxShown(line);
    if (shown) {
      out.push(shown);
      continue;
    }
    // Reacting to the user: "onClick={…}" → "reacts to clicks".
    const handler = /\bon([A-Z]\w*)\s*=\s*\{/.exec(line);
    if (handler) {
      out.push(`reacts to ${eventWords(handler[1])}`);
      continue;
    }
    // Counting: "count++", "total += price".
    const step = /^([\w$.]+)\s*(\+\+|--|\+=|-=)\s*(.*)$/.exec(line);
    if (step) {
      const [, name, operator, by] = step;
      if (operator === '++' || (operator === '+=' && by.trim() === '1')) out.push(`counts up ${noun(name)}`);
      else if (operator === '--' || (operator === '-=' && by.trim() === '1')) out.push(`counts down ${noun(name)}`);
      else out.push(`${operator === '+=' ? 'adds' : 'takes'} ${valueWords(by)} ${operator === '+=' ? 'to' : 'from'} ${noun(name)}`);
      continue;
    }
    // A declaration: state kept, a choice made, a value loaded.
    if (/^(?:const|let|var)\s/.test(line)) {
      const declared = declarationPhrase(line);
      if (declared) {
        if (!VAGUE.test(declared)) out.push(declared);
        continue;
      }
    }
    const call = callPhrase(line);
    if (call) {
      if (!VAGUE.test(call)) out.push(call);
      continue;
    }
    const set = /^([\w$.]+)\s*=(?!=)\s*(.+)$/.exec(line);
    if (!set) continue;
    // Settings by what they become: cleared, emptied, turned on or off.
    const becomes = settingPhrase(set[1].split('.').pop() ?? set[1], set[2]);
    if (!/^updates /.test(becomes)) {
      out.push(becomes);
      continue;
    }
    const prop = set[1].split('.').pop() ?? '';
    if (/^(className|style|hidden|disabled|tabIndex|title|id|width|height|left|top)$/.test(prop) || /\.style\./.test(set[1]) || /\.dataset\./.test(set[1])) continue;
    if (/^(textContent|innerText|innerHTML)$/.test(prop)) {
      out.push('changes the text it shows');
      continue;
    }
    if (/^(type|checked|value|src|href|onclick|onload|onerror|onmessage)$/.test(prop)) continue;
    const value = valueWords(set[2]);
    if (!/^(a calculated value|an object|an empty object|a list|an empty list|a text|a function|a result|a new \w+)$/.test(value)) out.push(`sets ${noun(set[1])} to ${value}`);
  }
  return [...new Set(out)];
}

/** What a JSX line puts on screen: "<Button …" → "shows a button", "<input" → "shows an input"; else undefined. */
function jsxShown(line: string): string | undefined {
  const m = /^<([A-Za-z][\w.]*)[\s>/]/.exec(line) ?? /^return\s*\(?\s*<([A-Za-z][\w.]*)/.exec(line);
  if (!m) return undefined;
  const tag = m[1];
  const html: Record<string, string> = {
    div: '', span: '', p: 'a paragraph', a: 'a link', button: 'a button', input: 'an input', select: 'a list to choose from', textarea: 'a text box', img: 'an image',
    ul: 'a list', ol: 'a list', li: '', table: 'a table', form: 'a form', label: 'a label', h1: 'a heading', h2: 'a heading', h3: 'a heading', svg: 'a drawing',
    canvas: 'a drawing', video: 'a video', dialog: 'a dialog', nav: 'a menu', header: 'a header', footer: 'a footer', section: '', main: '', strong: '', em: '', i: '', br: '', hr: 'a divider', option: '',
  };
  if (tag in html) return html[tag] ? `shows ${html[tag]}` : undefined;
  if (!/^[A-Z]/.test(tag)) return undefined;
  const w = words(tag.split('.').pop() ?? tag).join(' ');
  return `shows ${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`;
}

/** An event by name as what the user does: "Click" → "clicks", "KeyDown" → "key presses". */
function eventWords(event: string): string {
  const w = words(event).join(' ');
  const special: Record<string, string> = {
    'key down': 'key presses', 'key up': 'key presses', 'mouse enter': 'the pointer coming over it', 'mouse leave': 'the pointer leaving it', 'pointer down': 'presses',
    submit: 'the form being sent', change: 'changes', input: 'typing', blur: 'losing the focus', focus: 'getting the focus', 'double click': 'double clicks', 'context menu': 'right clicks',
  };
  return special[w] ?? `${w}s`.replace(/ss$/, 's').replace(/chs$/, 'ches');
}

/** Functions declared in lines: `function sizeOf(` or `const sizeOf = (…) =>`. */
function helpersIn(lines: string[]): string[] {
  return lines
    .map((l) => /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1] ?? m[2]);
}

/** Lines of the boxes changed in place, when there is no diff to read. */
function boxLines(comparison: FlowComparison, nodes: ControlFlowChart['nodes']): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const c of comparison.changed) {
    const old = c.before.split('\n').map(oneLine);
    const now = (nodes[c.id].text || '').split('\n').map(oneLine);
    added.push(...now.filter((l) => !old.includes(l)));
    removed.push(...old.filter((l) => !now.includes(l)));
  }
  return { added, removed };
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
    for (let k = 0; k < Math.min(d - i, a - d); k++) if (diff[i + k].span && diff[d + k].span) out.push([diff[i + k].text, diff[d + k].text]);
    i = a;
  }
  return out;
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

// ---------------------------------------------------------------------------------------------------------------
// Files

/**
 * Sentences for a file's changes outside any function: a new file by what it holds (its functions, components,
 * tests, styles or settings); a changed one by its imports, exports, settings and styles. `text` is the file now.
 */
export function describeFileChange(file: string, added: string[], removed: string[], isNew: boolean, text = added.join('\n'), max = 3, changedTests: string[] = []): string[] {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (isTestFile(file)) return describeTestFile(added, removed, isNew, text, changedTests).slice(0, max);
  const out = isNew ? describeNewFile(file, ext, base, text) : describeEditedFile(ext, base, added, removed);
  return (out.length ? out : [isNew ? 'This file is new.' : 'This file is updated.']).slice(0, max);
}

/** A test or spec file: `cart.test.ts`, `cart.spec.js`, anything under `__tests__/` or `test/`, `CartTests.cs`. */
export function isTestFile(file: string): boolean {
  const name = file.replace(/\\/g, '/');
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(__tests__|tests?)\//.test(name) || /Tests?\.cs$/.test(name);
}

const testTitles = (lines: string) => [...lines.matchAll(/\b(?:it|test)\(\s*(['"`])(.+?)\1/g)].map((m) => m[2]);

/**
 * A test's name as what it checks: "rejects an empty cart" → "that it rejects an empty cart", "should save" → "that it
 * saves"; a name that is not a phrase like that stays in quotes.
 */
export function testClaim(title: string): string {
  const t = title.trim().replace(/\.$/, '');
  const should = /^should (not )?(\w+)(.*)$/i.exec(t);
  if (should) return `that it ${should[1] ? `does not ${should[2]}` : third(should[2])}${should[3]}`;
  const first = t.split(/\s+/)[0] ?? '';
  // "rejects …", "returns …", "handles …": a verb, so a claim about the code.
  if (/^[a-z]+(s|es)$/.test(first) && !/^(this|is|was|has|its|as|us|yes|news|always)$/.test(first)) return `that it ${t}`;
  return `"${t}"`;
}
const third = (verb: string) => (/(s|sh|ch|x|z|o)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`);

/** Sentences for a test file: "This test file …", by the tests it adds, drops and changes. */
function describeTestFile(added: string[], removed: string[], isNew: boolean, text: string, changedTests: string[]): string[] {
  if (isNew) {
    const titles = testTitles(text).slice(0, 2);
    return [titles.length ? `This test file is new: it checks ${listWords(titles.map(testClaim))}.` : 'This test file is new.'];
  }
  const fresh = testTitles(added.join('\n'));
  const gone = testTitles(removed.join('\n')).filter((t) => !fresh.includes(t));
  const changed = changedTests.filter((t) => !fresh.includes(t) && !gone.includes(t));
  const out: string[] = [];
  if (fresh.length) out.push(`This test file now also checks ${listWords(fresh.slice(0, 2).map(testClaim))}.`);
  if (changed.length) out.push(`${out.length ? 'It' : 'This test file'} changes how it checks ${listWords(changed.slice(0, 2).map(testClaim))}.`);
  if (gone.length) out.push(`${out.length ? 'It' : 'This test file'} no longer checks ${listWords(gone.slice(0, 2).map(testClaim))}.`);
  return out.length ? out : ['This test file is updated.'];
}

function describeNewFile(file: string, ext: string, base: string, text: string): string[] {
  if (['.css', '.scss', '.less'].includes(ext)) return [`This new stylesheet styles ${listWords(selectorsIn(text).slice(0, 3)) || 'the page'}.`];
  if (ext === '.json') {
    const keys = topKeys(text).slice(0, 3);
    return [keys.length ? `This new settings file sets up ${listWords(keys.map((k) => words(k).join(' ')))}.` : 'This new settings file is added.'];
  }
  if (ext === '.md') {
    const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 2);
    return [headings.length ? `This new document explains ${listWords(headings)}.` : 'This new document is added.'];
  }
  if (ext === '.sql') {
    const created = [...text.matchAll(/\bCREATE\s+(?:OR\s+ALTER\s+)?(PROCEDURE|PROC|FUNCTION|TABLE|VIEW|TRIGGER)\s+([\w.[\]]+)/gi)].map((m) => `the ${words(m[2].replace(/[[\]]/g, '').split('.').pop()!).join(' ')} ${m[1].toLowerCase().replace(/^proc$/, 'procedure')}`);
    return [created.length ? `This new script creates ${listWords(created.slice(0, 3))}.` : 'This new script is added.'];
  }
  if (ext === '.cs') {
    const types = [...text.matchAll(/\b(?:class|record|interface|struct|enum)\s+(\w+)/g)].map((m) => m[1]);
    const methods = [...text.matchAll(/\b(?:public|internal|protected)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>[\],?]+\s+(\w+)\s*\(/g)].map((m) => m[1]).filter((m) => !types.includes(m));
    const parts = [types[0] ? `the ${words(types[0]).join(' ')} type` : '', ...methods.slice(0, 2).map((m) => `${m}, which ${verbPhrase(m)}`)].filter(Boolean);
    return [parts.length ? `This new file adds ${listWords(parts)}.` : 'This new file is added.'];
  }
  if (/\.(m|c)?[jt]sx?$/.test(ext)) return describeNewScript(file, text);
  return [];
}

/** A new TypeScript or JavaScript file by what it declares: functions, components, classes, types; or what it runs. */
function describeNewScript(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const items: string[] = [];
  const types: string[] = [];
  const actions: string[] = [];
  const hasJsx = (n: ts.Node): boolean => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || !!ts.forEachChild(n, hasJsx);
  const describeFn = (name: string, body: ts.Node | undefined) => {
    if (/^[A-Z]/.test(name) && body && hasJsx(body)) return `the ${words(name).join(' ')} component, which shows the ${words(name).join(' ').replace(/ (view|panel|page|screen|component)$/, '')}`;
    return `${name}, which ${verbPhrase(name)}`;
  };
  const exported = (s: ts.Statement) => !!ts.getModifiers(s as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const iife = (s: ts.Statement): ts.Statement[] | undefined => {
    if (!ts.isExpressionStatement(s)) return undefined;
    let e: ts.Expression = s.expression;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e)) return undefined;
    let fn: ts.Expression = e.expression;
    while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
    return (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && fn.body && ts.isBlock(fn.body) ? [...fn.body.statements] : undefined;
  };
  const statements = source.statements.flatMap((s) => iife(s) ?? [s]);
  for (const s of statements) {
    if (ts.isFunctionDeclaration(s) && s.name) items.push(describeFn(s.name.text, s.body));
    else if (ts.isClassDeclaration(s) && s.name) items.push(`the ${words(s.name.text).join(' ')} class`);
    else if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && exported(s)) types.push(`the shape of ${noun(s.name.text, false)}`);
    else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) items.push(describeFn(d.name.text, init.body));
        else if (exported(s)) items.push(`the ${words(d.name.text).join(' ')} setting`);
      }
    } else if (ts.isExpressionStatement(s)) {
      // A script's own steps.
      const action = callPhrase(s.expression.getText(source));
      if (action && !VAGUE.test(action) && readable(action)) actions.push(action);
    }
  }
  // What the file does first, its types after.
  const ordered = [...items, ...types];
  const sentences: string[] = [];
  if (ordered.length) sentences.push(`This new file adds ${listWords(ordered.slice(0, 3))}${ordered.length > 3 ? ', among other things' : ''}.`);
  if (actions.length) sentences.push(`${ordered.length ? 'It also' : 'This new file'} ${listWords([...new Set(actions)].slice(0, 2))}.`);
  return sentences;
}

function describeEditedFile(ext: string, base: string, added: string[], removed: string[]): string[] {
  const out: string[] = [];
  if (base === 'package.json') {
    const version = added.map((l) => /"version"\s*:\s*"([^"]+)"/.exec(l)?.[1]).find(Boolean);
    if (version) out.push(`This file sets the version to ${version}.`);
    const packages = added.map((l) => /^\s*"(@?[\w./-]+)"\s*:\s*"[\^~]?\d/.exec(l)?.[1]).filter((p): p is string => !!p && p !== 'version' && !removed.some((r) => r.includes(`"${p}"`)));
    if (packages.length) out.push(`It adds the ${listWords(packages.slice(0, 3))} package${packages.length === 1 ? '' : 's'}.`);
    const commands = added.map((l) => /"command"\s*:\s*"[\w-]+\.([\w.]+)"/.exec(l)?.[1]).filter((c): c is string => !!c);
    if (commands.length) out.push(`It adds the ${listWords([...new Set(commands)].slice(0, 2).map((c) => words(c).join(' ')))} command${commands.length === 1 ? '' : 's'}.`);
    return out;
  }
  if (['.css', '.scss', '.less'].includes(ext)) {
    const styled = selectorsIn(added.join('\n')).slice(0, 3);
    return [styled.length ? `This file restyles ${listWords(styled)}.` : 'This file adjusts the styles.'];
  }
  if (ext === '.md') {
    const headings = added.map((l) => /^#{1,3}\s+(.+)$/.exec(l)?.[1]).filter((h): h is string => !!h);
    return [headings.length ? `This file now documents ${listWords(headings.slice(0, 2))}.` : 'This file updates the documentation.'];
  }
  if (ext === '.json') {
    const keys = added.map((l) => /^\s*"([\w.-]+)"\s*:\s*(.+?),?$/.exec(l)).filter((m): m is RegExpExecArray => !!m).slice(0, 2);
    return keys.length ? [`This file now sets ${listWords(keys.map((k) => `${words(k[1]).join(' ')} to ${shortValue(k[2])}`))}.`] : [];
  }
  const imports = (lines: string[]) => lines.map((l) => /^\s*import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)).*?from\s+['"]([^'"]+)['"]/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ names: (m[1] ?? m[2] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean), from: m[3] }));
  const exportsOf = (lines: string[]) => lines.map((l) => /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+(\w+)/.exec(l)?.[1]).filter((x): x is string => !!x);
  for (const imp of imports(added).filter((i) => !imports(removed).some((r) => r.from === i.from)).slice(0, 1)) out.push(`This file now uses ${listWords(imp.names.slice(0, 2)) || 'code'} from ${moduleWords(imp.from)}.`);
  for (const imp of imports(removed).filter((r) => !imports(added).some((i) => i.from === r.from)).slice(0, 1)) out.push(`It no longer uses ${moduleWords(imp.from)}.`);
  const newExports = exportsOf(added).filter((e) => !exportsOf(removed).includes(e));
  for (const e of newExports.slice(0, 2)) out.push(`It now offers ${e}, which ${verbPhrase(e)}.`);
  const actions = actionsIn(added.join('\n')).filter((a) => !actionsIn(removed.join('\n')).includes(a));
  if (actions.length && out.length < 2) out.push(`${out.length ? 'It now' : 'This file now'} ${listWords(actions.slice(0, 2))}.`);
  return out;
}

const moduleWords = (spec: string) => (spec.startsWith('.') ? `the ${words(path.basename(spec).replace(/\.\w+$/, '')).join(' ')} module` : spec);
const shortValue = (v: string) => (v.length > 24 ? 'a new value' : v.replace(/[",]/g, ''));
function selectorsIn(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/^\s*([.#][\w-]+)/gm)) {
    const name = `the ${words(m[1].slice(1)).join(' ')}`;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
function topKeys(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Speech

/**
 * The words the voice reads for a caption. File names are never read (they are easy to get wrong): a caption that
 * starts with one ("cart.ts — …") loses it, and any other becomes "this file". Code is said as words.
 */
export function speakable(caption: string): string {
  return caption
    .replace(/^\s*[\w@./-]+\.[A-Za-z]{1,6}\s+[—–-]\s+/, '')
    .replace(/(?<![\w@])[\w@./-]*[\w-]\.(?:[cm]?[jt]sx?|json|css|scss|less|md|cs|sql|py|html?|ya?ml|xml|txt|sh|ps1|go|rs|java|kt|rb|php|vue|svelte)\b/g, 'this file')
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
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokens = (s: string) => s.match(/[\w$@#.]+|\s+|[^\w\s]/g) ?? [];
/** The condition of an if or while line, up to its matching parenthesis; undefined for other lines. */
function conditionIn(line: string): string | undefined {
  const m = /^(?:}\s*else\s+)?(?:if|while)\s*\(/.exec(line);
  if (!m) return undefined;
  let depth = 1;
  for (let i = m[0].length; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(m[0].length, i);
  }
  return undefined;
}
const stripIf = (code: string) => conditionIn(code.trim()) ?? (code.replace(/^(?:}\s*else\s+)?(?:if|while)\s*\(?/, '').replace(/\)\s*\{?\s*$/, '').trim() || code);
/** A line that is only a comment: a line comment, a block comment line, or -- in SQL. */
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|--)/.test(line);
const firstAction = (code: string) => actionsIn(code)[0];
