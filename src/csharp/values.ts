import type { Node as SyntaxNode } from 'web-tree-sitter';
import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { Choice } from '../inspect/controlFlow';
import { cfgPaths, describeChoice, maxPaths } from '../inspect/paths';
import { sliceOf } from '../inspect/slice';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import { bodyOf } from './explainTarget';
import { buildCSharpFlow, csharpFunctionAt, functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';

/**
 * The value analyses for C#, on the C# flowchart's boxes and the names each box sets and reads (src/csharp/flow.ts):
 * - Why this value: every value a variable can have at the cursor, with the branch conditions that lead to each;
 * - What feeds this value and What this value feeds: the backward and forward slices, lit up on the flowchart;
 * - Value timeline: every change to a variable in source order, in phases around loops.
 * They work as the TypeScript ones do (src/inspect/paths.ts, slice.ts, timelines.ts), from the bundled parser.
 */

const kids = (n: SyntaxNode): SyntaxNode[] => n.namedChildren.filter((c): c is SyntaxNode => !!c);
const short = (text: string, max = 70) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const where = (file: string, n: SyntaxNode): ReportLocation => ({ file, line: n.startPosition.row, character: n.startPosition.column, endLine: n.endPosition.row, endCharacter: n.endPosition.column });
const contains = (l: ReportLocation, row: number, column: number) =>
  (row > l.line || (row === l.line && column >= l.character)) && (row < l.endLine || (row === l.endLine && column <= l.endCharacter));
const size = (l: ReportLocation) => (l.endLine - l.line) * 10000 + (l.endCharacter - l.character);
/** Parentheses around an expression before an operator is added, except for names and literals. */
const wrap = (text: string) => (/^[\w.[\]]+$/.test(text) || /^"[^"]*"$/.test(text) ? text : `(${text})`);
const isLoop = (n: SyntaxNode) => /^(for|foreach|while|do)_statement$/.test(n.type);
const COLLECTION_CHANGES = new Set(['Add', 'AddRange', 'Insert', 'InsertRange', 'Remove', 'RemoveAt', 'RemoveAll', 'RemoveRange', 'Clear', 'Push', 'Pop', 'Enqueue', 'Dequeue', 'Sort', 'Reverse', 'TryAdd', 'TryRemove', 'Append']);

/** The name at the cursor (or just before it), the function around it and its flowchart graph. */
async function subject(code: string, file: string, offset: number, need: string) {
  const tree = await parseCSharp(code);
  let id: SyntaxNode | null = tree.rootNode.descendantForIndex(offset);
  if (id && id.type !== 'identifier') id = tree.rootNode.descendantForIndex(Math.max(0, offset - 1));
  if (!id || id.type !== 'identifier') {
    tree.delete();
    throw new AnalysisError('Place the cursor on a variable or parameter.');
  }
  const fn = csharpFunctionAt(tree.rootNode, id.startIndex);
  if (!fn || !bodyOf(fn)) {
    tree.delete();
    throw new AnalysisError(`Place the cursor inside a method: ${need} follows the code of one method.`);
  }
  const syntax = new Map<number, SyntaxNode[]>();
  const graph = buildCSharpFlow(fn, file, syntax);
  // The box the cursor is in: the smallest one around it; a parameter is set at the start.
  const row = id.startPosition.row;
  const column = id.startPosition.column;
  const around = graph.nodes.filter((n) => n.facts && contains(n.facts.location, row, column)).sort((a, b) => size(a.facts!.location) - size(b.facts!.location));
  const isParameter = id.parent?.type === 'parameter';
  const at = isParameter ? graph.start : around[0]?.id;
  return { tree, id, fn, graph, syntax, at, name: id.text.replace(/^@/, '') };
}

// ---------------------------------------------------------------- What feeds / What this value feeds

export interface CSharpSlice {
  direction: 'backward' | 'forward';
  name: string;
  /** Where the method starts, to chart it. */
  anchor: number;
  at: number;
  nodes: number[];
  /** The line of the box at the cursor, from 1. */
  line: number;
}

export async function csharpSlice(code: string, file: string, offset: number, direction: 'backward' | 'forward'): Promise<CSharpSlice> {
  const s = await subject(code, file, offset, 'a slice');
  try {
    if (s.at === undefined) throw new AnalysisError('The cursor is not in a statement of the method.');
    const at = s.graph.nodes[s.at];
    return {
      direction,
      name: s.name,
      anchor: (s.fn.childForFieldName('name') ?? s.fn).startIndex,
      at: s.at,
      nodes: sliceOf(s.graph, s.at, s.name, direction),
      line: (at.facts?.location.line ?? s.id.startPosition.row) + 1,
    };
  } finally {
    s.tree.delete();
  }
}

// ---------------------------------------------------------------- Why this value

interface Value {
  text: string;
  node?: SyntaxNode;
}

/** Whether an assigned expression is the variable: `total` or `this.total`. */
const isName = (n: SyntaxNode | null | undefined, name: string) =>
  !!n && ((n.type === 'identifier' && n.text.replace(/^@/, '') === name) || (n.type === 'member_access_expression' && n.childForFieldName('expression')?.text === 'this' && n.childForFieldName('name')?.text === name));

/** The value a box's code leaves in the variable, given the value before; compound updates build on it. */
function lastDefinition(statement: SyntaxNode, name: string, before: Value | undefined, until?: number): Value | undefined {
  let value = before;
  let changed = false;
  const visit = (n: SyntaxNode, top: boolean): void => {
    if (until !== undefined && n.startIndex >= until) return;
    if (!top && functionTypes.has(n.type)) return;
    // A foreach box stands for its whole statement; only its header assigns.
    if (n.type === 'foreach_statement') {
      if (isName(n.childForFieldName('left'), name)) {
        value = { text: `each item of ${short(n.childForFieldName('right')?.text ?? '?', 50)}`, node: n.childForFieldName('left')! };
        changed = true;
      }
      if (top) return;
    }
    for (const c of kids(n)) visit(c, false);
    if (n.type === 'variable_declarator' && isName(n.childForFieldName('name') ?? kids(n)[0], name)) {
      const init = kids(n).find((c) => c.id !== (n.childForFieldName('name') ?? kids(n)[0])?.id);
      value = { text: init ? short((init.type === 'equals_value_clause' ? kids(init)[0] ?? init : init).text, 60) : 'unassigned', node: n };
      changed = true;
    } else if (n.type === 'assignment_expression' && isName(n.childForFieldName('left'), name)) {
      const left = n.childForFieldName('left')!;
      const right = n.childForFieldName('right');
      const op = n.text.slice(left.endIndex - n.startIndex, (right?.startIndex ?? n.endIndex) - n.startIndex).trim();
      if (op === '=') value = { text: short(right?.text ?? '?', 60), node: n };
      else if (op === '??=') value = { text: `${wrap(value?.text ?? '?')} ?? ${short(right?.text ?? '?', 40)}`, node: n };
      else value = { text: `${wrap(value?.text ?? '?')} ${op.slice(0, -1)} ${short(right?.text ?? '?', 40)}`, node: n };
      changed = true;
    } else if ((n.type === 'postfix_unary_expression' || n.type === 'prefix_unary_expression') && /\+\+|--/.test(n.text) && isName(kids(n)[0], name)) {
      value = { text: `${wrap(value?.text ?? '?')} ${/\+\+/.test(n.text) ? '+' : '-'} 1`, node: n };
      changed = true;
    } else if (n.type === 'argument' && /^\s*(out|ref)\b/.test(n.text) && isName(kids(n).at(-1), name) && /^\s*out\b/.test(n.text)) {
      const call = n.parent?.parent;
      value = { text: `set by ${short(call?.childForFieldName('function')?.text ?? 'a call', 40)}(… out ${name})`, node: n };
      changed = true;
    } else if (n.type === 'declaration_expression' && kids(n).at(-1)?.text === name && n.parent?.type === 'argument') {
      const call = n.parent.parent?.parent;
      value = { text: `set by ${short(call?.childForFieldName('function')?.text ?? 'a call', 40)}(… out ${name})`, node: n };
      changed = true;
    }
  };
  visit(statement, true);
  return changed ? value : undefined;
}

/** Before any assignment in the method: an argument, a field's value, or nothing yet. */
function initialValue(fn: SyntaxNode, name: string): Value {
  const list = fn.childForFieldName('parameters') ?? kids(fn).find((c) => c.type === 'parameter_list');
  const parameter = list && kids(list).find((p) => p.type === 'parameter' && (p.childForFieldName('name') ?? kids(p).find((c) => c.type === 'identifier'))?.text === name);
  if (parameter) {
    const last = kids(parameter).at(-1);
    const fallback = last && last.type !== 'identifier' && last.id !== parameter.childForFieldName('type')?.id ? (last.type === 'equals_value_clause' ? kids(last)[0] : last) : undefined;
    return { text: fallback ? `the argument, or ${short(fallback.text, 40)} if left out` : 'the argument callers pass', node: parameter };
  }
  const declaredHere = fn.descendantsOfType(['variable_declarator', 'foreach_statement']).some((d) => d && isName(d.childForFieldName('name') ?? d.childForFieldName('left') ?? kids(d)[0], name));
  return declaredHere ? { text: 'unassigned (not given a value yet)' } : { text: 'its value from outside the method' };
}

export async function csharpExplainValue(code: string, file: string, offset: number): Promise<Report> {
  const s = await subject(code, file, offset, 'Why this value');
  try {
    const { graph, name, syntax, at } = s;
    if (at === undefined) throw new AnalysisError('The cursor is not in a statement of the method.');
    const { paths, truncated } = cfgPaths(graph);
    const sources = new Map<string, { value: string; node?: SyntaxNode; ways: { choices: Choice[]; edges: number[] }[] }>();
    const impossible: { reason?: string; choices: Choice[] }[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const stop = path.nodes.indexOf(at);
      if (stop < 0) continue;
      const key = path.edges.slice(0, stop).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (!path.feasible) {
        impossible.push(path);
        continue;
      }
      let value: Value | undefined;
      for (let i = 0; i <= stop; i++) {
        const node = graph.nodes[path.nodes[i]];
        if (!['statement', 'catch', 'loop'].includes(node.kind)) continue;
        for (const statement of syntax.get(node.id) ?? []) {
          if (i === stop && statement.startIndex >= s.id.startIndex) break;
          if (!statement.text.includes(name)) continue;
          value = lastDefinition(statement, name, value, i === stop ? s.id.startIndex : undefined) ?? value;
        }
      }
      value ??= initialValue(s.fn, name);
      const choices = path.edges.slice(0, stop).map((e) => graph.edges[e].choice).filter((c): c is Choice => !!c);
      const source = sources.get(value.text) ?? { value: value.text, node: value.node, ways: [] };
      source.ways.push({ choices, edges: path.edges.slice(0, stop) });
      sources.set(value.text, source);
    }
    const line = (graph.nodes[at].facts?.location.line ?? s.id.startPosition.row) + 1;
    const conditionRow = (edgeIndex: number): ReportNode => {
      const edge = graph.edges[edgeIndex];
      return { label: describeChoice(edge.choice!), description: edge.label, icon: 'filter', location: graph.nodes[edge.from].facts?.location };
    };
    const roots: ReportNode[] = [...sources.values()].map((source) => ({
      label: /^(unassigned|the argument|its value|each item|set by)/.test(source.value) ? source.value : `= ${source.value}`,
      description: plural(source.ways.length, 'way'),
      tooltip: `${name} is ${source.value} at line ${line} when the code takes ${source.ways.length === 1 ? 'this path' : `one of these ${source.ways.length} paths`}.`,
      icon: 'symbol-variable',
      location: source.node ? where(file, source.node) : undefined,
      expanded: true,
      children: source.ways.map((way) => {
        const decisions = way.edges.filter((e) => graph.edges[e].choice);
        return {
          label: decisions.length ? decisions.map((e) => describeChoice(graph.edges[e].choice!)).join(', ') : 'always',
          description: decisions.length ? plural(decisions.length, 'condition') : 'no branch decides it',
          icon: 'git-branch',
          expanded: source.ways.length <= 3,
          children: decisions.map(conditionRow),
        };
      }),
    }));
    if (impossible.length) {
      roots.push({
        label: 'Impossible paths',
        description: `${plural(impossible.length, 'path')} that cannot happen`,
        icon: 'circle-slash',
        children: impossible.map((p) => ({ label: p.reason ?? 'contradictory conditions', description: p.choices.map(describeChoice).join(', '), icon: 'circle-slash' })),
      });
    }
    const values = sources.size;
    return {
      kind: 'explainValue',
      title: `Value path of ${name}`,
      description: values ? `${plural(values, 'possible value')} at line ${line}` : `no path reaches line ${line}`,
      roots,
      warnings: truncated ? [`Only the first ${maxPaths} paths through ${graph.name} were followed; there may be more values.`] : [],
      fileHashes: { [file]: hashText(code) },
    };
  } finally {
    s.tree.delete();
  }
}

// ---------------------------------------------------------------- Value timeline

type EventKind = 'start' | 'set' | 'change' | 'read';
interface ValueEvent {
  kind: EventKind;
  label: string;
  node: SyntaxNode;
  step?: number;
  loops: SyntaxNode[];
  conditions: string[];
  callback: boolean;
}

/** How a loop starts, as written: "foreach (var item in items)", "while (attempts < 3)". */
function loopHeader(loop: SyntaxNode): string {
  if (loop.type === 'do_statement') return `do … while (${short(loop.childForFieldName('condition')?.text ?? '', 40)})`;
  const body = loop.childForFieldName('body') ?? kids(loop).at(-1);
  return short(loop.text.slice(0, (body?.startIndex ?? loop.endIndex) - loop.startIndex), 60);
}

/** The loops and conditions between a node and the method's body, outermost first, and whether a lambda is in between. */
function context(node: SyntaxNode, scope: SyntaxNode): { loops: SyntaxNode[]; conditions: string[]; callback: boolean } {
  const loops: SyntaxNode[] = [];
  const conditions: string[] = [];
  let callback = false;
  for (let child = node, parent = node.parent; parent && child.id !== scope.id; child = parent, parent = parent.parent) {
    if (parent.id === scope.id) break;
    const body = parent.childForFieldName('body') ?? kids(parent).at(-1);
    if (isLoop(parent) && (parent.type === 'for_statement' ? body?.id === child.id || parent.childForFieldName('update')?.id === child.id || parent.childForFieldName('condition')?.id === child.id : body?.id === child.id)) loops.unshift(parent);
    else if (parent.type === 'if_statement' && child.id !== parent.childForFieldName('condition')?.id) {
      const condition = short(parent.childForFieldName('condition')?.text ?? '', 50);
      conditions.unshift(child.id === parent.childForFieldName('consequence')?.id ? condition : `not ${condition}`);
    } else if (parent.type === 'conditional_expression' && child.id !== kids(parent)[0]?.id) {
      const condition = short(kids(parent)[0]?.text ?? '', 50);
      conditions.unshift(child.id === kids(parent)[1]?.id ? condition : `not ${condition}`);
    } else if (parent.type === 'switch_section') {
      const label = kids(parent).filter((c) => !c.type.endsWith('_statement') && c.type !== 'block').map((c) => c.text).join(', ');
      conditions.unshift(label ? `case ${short(label, 40)}` : 'default');
    } else if (parent.type === 'binary_expression' && child.id === parent.childForFieldName('right')?.id && /^(&&|\|\|)$/.test(parent.childForFieldName('operator')?.text ?? '')) {
      const left = short(parent.childForFieldName('left')?.text ?? '', 46);
      conditions.unshift(parent.childForFieldName('operator')?.text === '&&' ? left : `not ${left}`);
    } else if (functionTypes.has(parent.type)) callback = true;
  }
  return { loops, conditions, callback };
}

export async function csharpValueTimeline(code: string, file: string, offset: number): Promise<Report> {
  const s = await subject(code, file, offset, 'Value timeline');
  try {
    const { fn, name } = s;
    const body = bodyOf(fn)!;
    const events: ValueEvent[] = [];
    const add = (kind: EventKind, label: string, node: SyntaxNode, step?: number) => events.push({ kind, label, node, step, ...context(node, body) });
    const start = initialValue(fn, name);
    const declaration = body.descendantsOfType(['variable_declarator', 'foreach_statement']).find((d): d is SyntaxNode => !!d && isName(d.childForFieldName('name') ?? d.childForFieldName('left') ?? kids(d)[0], name));
    if (declaration?.type === 'variable_declarator') {
      const init = kids(declaration).find((c) => c.id !== (declaration.childForFieldName('name') ?? kids(declaration)[0])?.id);
      add('start', init ? `starts as ${short((init.type === 'equals_value_clause' ? kids(init)[0] ?? init : init).text, 60)}` : 'starts unassigned', declaration);
    } else if (declaration?.type === 'foreach_statement') {
      add('start', `takes each item of ${short(declaration.childForFieldName('right')?.text ?? '?', 50)}`, declaration.childForFieldName('left')!);
    } else if (start.node) {
      add('start', start.text.startsWith('the argument, or') ? `comes in as an argument, or ${start.text.replace(/^the argument, or /, '').replace(/ if left out$/, '')} when none is passed` : 'comes in as an argument', start.node);
    }
    const header = (node: SyntaxNode): string | undefined => {
      for (let child = node, n = node.parent; n && n.id !== body.id; child = n, n = n.parent) {
        if (isLoop(n)) return (n.childForFieldName('body') ?? kids(n).at(-1))?.id === child.id ? undefined : loopHeader(n);
        if (n.type === 'if_statement') return child.id === n.childForFieldName('condition')?.id ? `if (${short(n.childForFieldName('condition')!.text, 50)})` : undefined;
        if (n.type.endsWith('_statement') || n.type === 'block') return undefined;
      }
      return undefined;
    };
    const statementOf = (node: SyntaxNode) => {
      let n = node;
      while (n.parent && n.parent.type !== 'block' && n.parent.type !== 'switch_section' && !functionTypes.has(n.parent.type) && n.parent.type !== 'arrow_expression_clause') n = n.parent;
      return n;
    };
    const insideOwnChange = (node: SyntaxNode) => {
      for (let n = node.parent; n && n.id !== body.id; n = n.parent) {
        if (n.type === 'assignment_expression' && isName(n.childForFieldName('left'), name)) return true;
        if (n.type.endsWith('_statement')) return false;
      }
      return false;
    };
    const visit = (n: SyntaxNode) => {
      if (n.type === 'identifier' && n.text.replace(/^@/, '') === name) {
        const parent = n.parent!;
        const subject = parent.type === 'member_access_expression' && parent.childForFieldName('name')?.id === n.id ? parent : n;
        const declared = (parent.childForFieldName('name')?.id === n.id || parent.childForFieldName('left')?.id === n.id) && /declarator|parameter|foreach/.test(parent.type);
        const ownName = subject === n ? !(parent.type === 'member_access_expression' && parent.childForFieldName('name')?.id === n.id) : parent.childForFieldName('expression')?.text === 'this';
        const around = subject.parent;
        if (declared || !ownName || parent.type === 'member_binding_expression') {
          // not this variable
        } else if (around?.type === 'assignment_expression' && around.childForFieldName('left')?.id === subject.id) {
          const right = around.childForFieldName('right');
          const op = around.text.slice(subject.endIndex - around.startIndex, (right?.startIndex ?? around.endIndex) - around.startIndex).trim();
          const literal = right && /^\d+(\.\d+)?[mMdDfFlLuU]?$/.test(right.text) ? Number(right.text.replace(/[a-zA-Z]+$/, '')) : undefined;
          if (op === '=') add('set', `= ${short(right?.text ?? '', 60)}`, around);
          else add('change', `${op} ${short(right?.text ?? '', 50)}`, around, op === '+=' && literal !== undefined ? literal : op === '-=' && literal !== undefined ? -literal : undefined);
        } else if ((around?.type === 'postfix_unary_expression' || around?.type === 'prefix_unary_expression') && /\+\+|--/.test(around.text)) {
          add('change', around.text, around, /\+\+/.test(around.text) ? 1 : -1);
        } else if (around?.type === 'member_access_expression' && around.childForFieldName('expression')?.id === subject.id && COLLECTION_CHANGES.has(around.childForFieldName('name')?.text ?? '') && around.parent?.type === 'invocation_expression') {
          add('change', short(around.parent.text, 60), around.parent);
        } else if (!insideOwnChange(subject)) {
          const statement = statementOf(subject);
          const h = header(subject);
          add('read', h ? `checked in ${h}` : statement.type === 'return_statement' || statement.parent?.type === 'arrow_expression_clause' ? `returned: ${short(statement.text.replace(/^return\s*/, '').replace(/;$/, ''), 50)}` : `read in ${short(statement.text, 56)}`, subject);
        }
      }
      for (const c of kids(n)) visit(c);
    };
    visit(body);
    events.sort((a, b) => a.node.startIndex - b.node.startIndex);

    // Phases: runs of events in the same loop, in order.
    const loopKey = (e: ValueEvent) => e.loops.map((l) => l.startIndex).join('/');
    const phases: { loops: SyntaxNode[]; events: ValueEvent[] }[] = [];
    for (const e of events) {
      const last = phases[phases.length - 1];
      if (last && loopKey(last.events[0]) === loopKey(e)) last.events.push(e);
      else phases.push({ loops: e.loops, events: [e] });
    }
    const first = events.find((e) => e.kind === 'start');
    const startValue = first && /^starts as /.test(first.label) ? first.label.replace(/^starts as /, '') : start.node ? 'the argument' : start.text;
    let seenLoop = false;
    const icon: Record<EventKind, string> = { start: 'debug-start', set: 'edit', change: 'diff-modified', read: 'eye' };
    const roots: ReportNode[] = phases.map((phase, i) => {
      const inLoop = phase.loops.length > 0;
      const head = inLoop ? loopHeader(phase.loops[phase.loops.length - 1]) : '';
      const label = inLoop ? `Every pass of ${head}` : i === 0 ? 'At the start' : seenLoop ? 'After the loop' : 'Then';
      if (inLoop) seenLoop = true;
      const rows: ReportNode[] = phase.events.map((e) => ({
        label: e.label,
        description: [`line ${e.node.startPosition.row + 1}`, e.conditions.length ? `when ${e.conditions.join(' and ')}` : '', e.callback ? 'inside a lambda: runs later' : ''].filter(Boolean).join(' · '),
        icon: icon[e.kind],
        tone: e.callback && e.kind !== 'read' ? ('info' as const) : undefined,
        location: where(file, e.node),
      }));
      if (inLoop) {
        const writes = phase.events.filter((e) => e.kind === 'set' || e.kind === 'change');
        const reads = phase.events.some((e) => e.kind === 'read' || e.kind === 'change');
        const counter = writes.length === 1 && writes[0].step !== undefined && !writes[0].conditions.length ? writes[0].step : undefined;
        let note: string;
        if (counter !== undefined) {
          const term = (k: number) => (k === 0 ? startValue : `${startValue} ${counter * k < 0 ? '−' : '+'} ${Math.abs(counter * k)}`);
          note = `Pass by pass: ${term(0)}, then ${term(1)}, ${term(2)}, … one step of ${counter > 0 ? '+' : ''}${counter} each pass`;
        } else if (writes.length && reads) note = `Each pass starts with what the pass before left; the first pass starts with ${short(startValue, 40)}`;
        else if (writes.length) note = 'Each pass replaces it: after the loop it holds what the last pass set';
        else note = 'Only read in the loop: the same value on every pass';
        rows.unshift({ label: note, icon: 'sync', tone: 'info' });
      }
      return { label, description: plural(phase.events.filter((e) => e.kind !== 'read').length, 'change'), icon: inLoop ? 'sync' : i === 0 ? 'debug-start' : 'arrow-down', expanded: true, children: rows };
    });
    const changes = events.filter((e) => e.kind === 'set' || e.kind === 'change').length;
    // The last change, outside lambdas, with no read after it: nothing ever sees that value (locals only).
    const plain = events.filter((e) => !e.callback);
    const lastChange = [...plain].reverse().find((e) => e.kind === 'set' || e.kind === 'change');
    if (declaration && lastChange && lastChange.kind === 'set' && !lastChange.loops.length && !plain.some((e) => e.kind === 'read' && e.node.startIndex > lastChange.node.startIndex)) {
      const row = roots.flatMap((p) => p.children ?? []).find((r) => r.location?.line === lastChange.node.startPosition.row && r.label === lastChange.label);
      if (row) {
        row.description = `${row.description} · nothing reads it after this`;
        row.tone = 'warning';
      }
    }
    const inLambdas = events.filter((e) => e.callback && e.kind !== 'read').length;
    if (!changes) roots.push({ label: `${name} never changes after it starts`, description: 'every read sees the same value', icon: 'pass', tone: 'ok' });
    const loopsCount = new Set(events.flatMap((e) => e.loops.map((l) => l.startIndex))).size;
    return {
      kind: 'valueTimeline',
      title: `Value timeline of ${name}`,
      description: `${plural(changes, 'change')}${loopsCount ? ` in and around ${plural(loopsCount, 'loop')}` : ''}${inLambdas ? ` (${inLambdas} in lambdas)` : ''}, ${plural(events.filter((e) => e.kind === 'read').length, 'read')}`,
      roots,
      warnings: declaration || start.node ? [] : [`${name} is not declared in ${functionName(fn)}: only its changes and reads there are shown.`],
      fileHashes: { [file]: hashText(code) },
    };
  } finally {
    s.tree.delete();
  }
}

