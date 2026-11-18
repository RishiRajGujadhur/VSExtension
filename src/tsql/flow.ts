import { CfgEdge, CfgEdgeKind, CfgNode, CfgNodeKind, Choice, CodeFacts, FlowGraph } from '../inspect/controlFlow';
import { ControlFlowChart, CodeOptions, chartFrom, factSource } from '../inspect/controlFlowChart';
import { AnalysisError } from '../analysis/types';
import { ReportLocation } from '../structure/report';
import { Token, isWord } from './lexer';
import { Routine, Statement, routineAt } from './parser';

/**
 * The control flow of a T-SQL procedure, function, trigger or script: IF … ELSE, WHILE (with BREAK and CONTINUE),
 * BEGIN TRY … BEGIN CATCH, RETURN, THROW and GOTO, as the same boxes and edges the TypeScript and C# flowcharts have.
 * Each box knows the @variables it sets and reads, so paths, the impossible-path check and dependences work too.
 */

interface Pending {
  from: number;
  kind: CfgEdgeKind;
  label?: string;
  choice?: Choice;
}

/** A line or position from a character offset. */
function positions(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: offset - starts[low] };
  };
}

const oneLine = (text: string, max = 120) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The @variables the tokens set and read: SET @x =, SELECT @x =, DECLARE @x … =, FETCH … INTO @x, EXEC … @x OUTPUT. */
export function variableFacts(tokens: Token[]): Pick<CodeFacts, 'defines' | 'replaces' | 'reads'> {
  const defines = new Set<string>();
  const reads = new Set<string>();
  const first = tokens[0];
  let into = false;
  tokens.forEach((t, i) => {
    if (t.kind !== 'variable' || t.text.startsWith('@@')) {
      if (isWord(t, 'INTO')) into = true;
      return;
    }
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    const assigned =
      ((isWord(first, 'SET') && i === 1) || (isWord(first, 'SELECT', 'UPDATE') && (before?.text === ',' || isWord(before, 'SELECT', 'SET', 'TOP')) && after?.text === '=')) ||
      (isWord(first, 'SET') && i === 1 && after?.kind === 'operator') ||
      (isWord(first, 'DECLARE') && (before?.text === ',' || isWord(before, 'DECLARE'))) ||
      (isWord(first, 'FETCH') && into) ||
      (isWord(after, 'OUTPUT', 'OUT') && isWord(first, 'EXEC', 'EXECUTE'));
    if (assigned) {
      defines.add(t.text);
      // SET @x += 1 also reads x.
      if (after && /^[-+*/%&|^]=$/.test(after.text)) reads.add(t.text);
    } else reads.add(t.text);
  });
  return { defines, replaces: new Set(defines), reads };
}

export function buildTsqlFlow(routine: Routine, text: string, file: string): FlowGraph {
  const at = positions(text);
  const location = (start: number, end: number): ReportLocation => {
    const a = at(start);
    const b = at(end);
    return { file, line: a.line, character: a.character, endLine: b.line, endCharacter: b.character };
  };
  const nodes: CfgNode[] = [];
  const edges: CfgEdge[] = [];
  const loops: { breaks: Pending[]; test: number }[] = [];
  const catches: { throws: Pending[] }[] = [];
  const labels = new Map<string, number>();
  const gotos: { from: number; label: string }[] = [];
  const add = (kind: CfgNodeKind, lines: string[], parts: { start: number; end: number; tokens: Token[] }[]): number => {
    const node: CfgNode = { id: nodes.length, kind, lines, nodes: [] };
    if (parts.length) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      const column = at(first.start).character;
      const source = parts.flatMap((p) => text.slice(p.start, p.end).split(/\r?\n/).map((l, i) => (i && /^\s*$/.test(l.slice(0, column)) ? l.slice(column) : l).trimEnd()));
      // Each statement's variables on its own (what a statement sets depends on its first word), then together.
      const each = parts.map((p) => variableFacts(p.tokens));
      const merge = (key: 'defines' | 'replaces' | 'reads') => new Set(each.flatMap((f) => [...f[key]]));
      node.facts = { location: location(first.start, last.end), source, defines: merge('defines'), replaces: merge('replaces'), reads: merge('reads') };
    }
    nodes.push(node);
    return node.id;
  };
  const connect = (pending: Pending[], to: number) => {
    for (const p of pending) edges.push({ from: p.from, to, kind: p.kind, label: p.label, choice: p.choice });
  };
  const enter = (pending: Pending[], kind: CfgNodeKind, lines: string[], parts: { start: number; end: number; tokens: Token[] }[]) => {
    const id = add(kind, lines, parts);
    connect(pending, id);
    return id;
  };
  const textOf = (tokens: Token[]) => (tokens.length ? text.slice(tokens[0].start, tokens[tokens.length - 1].end) : '');
  const start = add('start', [routine.name], []);
  const end = add('end', ['end'], []);

  function list(statements: Statement[], pending: Pending[]): Pending[] {
    let run: Statement[] = [];
    const flush = () => {
      if (!run.length) return;
      const id = enter(pending, 'statement', run.map((s) => oneLine(textOf(s.tokens)).replace(/;$/, '')), run.map((s) => ({ start: s.start, end: s.end, tokens: s.tokens })));
      pending = [{ from: id, kind: 'next' }];
      run = [];
    };
    for (const s of statements) {
      if (s.kind === 'simple') {
        run.push(s);
        continue;
      }
      flush();
      pending = stmt(s, pending);
    }
    flush();
    return pending;
  }

  function stmt(s: Statement | undefined, pending: Pending[]): Pending[] {
    if (!s) return pending;
    const own = { start: s.tokens[0]?.start ?? s.start, end: s.tokens[s.tokens.length - 1]?.end ?? s.end, tokens: s.tokens };
    switch (s.kind) {
      case 'simple':
        return list([s], pending);
      case 'block':
        return list(s.statements ?? [], pending);
      case 'if': {
        const condition = oneLine(textOf(s.tokens).replace(/^\((.*)\)$/s, '$1'));
        const id = enter(pending, 'decision', [condition], [own]);
        const yes = stmt(s.body, [{ from: id, kind: 'true', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'condition' } }]);
        const noEntry: Pending[] = [{ from: id, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'condition' } }];
        return [...yes, ...(s.otherwise ? stmt(s.otherwise, noEntry) : noEntry)];
      }
      case 'while': {
        const condition = oneLine(textOf(s.tokens).replace(/^\((.*)\)$/s, '$1'));
        const test = enter(pending, 'loop', [`WHILE ${condition}`], [own]);
        const loop = { breaks: [] as Pending[], test };
        loops.push(loop);
        const out = stmt(s.body, [{ from: test, kind: 'true', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'loop' } }]);
        loops.pop();
        for (const p of out) edges.push({ from: p.from, to: test, kind: 'back', label: p.label, choice: p.choice });
        return [{ from: test, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'loop' } }, ...loop.breaks];
      }
      case 'break':
      case 'continue': {
        const loop = loops[loops.length - 1];
        if (!loop) return pending;
        if (s.kind === 'break') loop.breaks.push(...pending.map((p) => ({ ...p })));
        else for (const p of pending) edges.push({ from: p.from, to: loop.test, kind: 'continue', label: p.label ?? 'continue', choice: p.choice });
        return [];
      }
      case 'return': {
        const value = s.tokens.slice(1);
        const id = enter(pending, 'return', [value.length ? `RETURN ${oneLine(textOf(value))}` : 'RETURN'], [own]);
        edges.push({ from: id, to: end, kind: 'return' });
        return [];
      }
      case 'throw': {
        const id = enter(pending, 'throw', [oneLine(textOf(s.tokens)).replace(/;$/, '')], [own]);
        const handler = catches[catches.length - 1];
        if (handler) handler.throws.push({ from: id, kind: 'throw', label: 'throws' });
        else edges.push({ from: id, to: end, kind: 'throw', label: 'throws' });
        return [];
      }
      case 'try': {
        const handler = { throws: [] as Pending[] };
        const tryFirst = nodes.length;
        catches.push(handler);
        const afterTry = list(s.statements ?? [], pending);
        catches.pop();
        // Any statement of the TRY block may fail: the CATCH is reachable from its first box even without THROW.
        const fromTry: Pending[] = handler.throws.length ? handler.throws : tryFirst < nodes.length ? [{ from: tryFirst, kind: 'throw', label: 'error' }] : [];
        const catchId = enter(fromTry, 'catch', ['BEGIN CATCH'], []);
        const afterCatch = list(s.handler ?? [], [{ from: catchId, kind: 'next' }]);
        return [...afterTry, ...afterCatch];
      }
      case 'label': {
        const id = enter(pending, 'statement', [`${s.tokens[0]?.text ?? s.label}:`], [own]);
        labels.set(s.label!, id);
        return [{ from: id, kind: 'next' }];
      }
      case 'goto': {
        const id = enter(pending, 'statement', [`GOTO ${s.tokens[1]?.text ?? ''}`.trim()], [own]);
        if (s.label) gotos.push({ from: id, label: s.label });
        return [];
      }
    }
  }

  const out = list(routine.body, [{ from: start, kind: 'next' }]);
  connect(out, end);
  for (const g of gotos) {
    const to = labels.get(g.label);
    if (to !== undefined) edges.push({ from: g.from, to, kind: to <= g.from ? 'back' : 'next', label: 'goto' });
  }
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) if (e.from === id && !reached.has(e.to)) {
      reached.add(e.to);
      queue.push(e.to);
    }
  }
  for (const n of nodes) if (!reached.has(n.id) && n.id !== end) n.unreachable = true;
  return { name: routine.name, nodes, edges, start, end, parameters: routine.parameters };
}

/** The flowchart of the procedure, function, trigger or script at the offset. */
export function tsqlFlowChart(text: string, file: string, offset: number, options: CodeOptions = {}): ControlFlowChart {
  const routine = routineAt(text, offset);
  if (!routine || !routine.body.length) throw new AnalysisError('Put the cursor inside a T-SQL procedure, function, trigger or script with statements in it.');
  const graph = buildTsqlFlow(routine, text, file);
  const at = positions(text);
  const a = at(routine.nameStart);
  const b = at(routine.nameEnd);
  return chartFrom(graph, factSource(file, routine.start, { file, line: a.line, character: a.character, endLine: b.line, endCharacter: b.character }), () => [], options);
}
