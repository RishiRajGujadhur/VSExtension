import type { Node as SyntaxNode } from 'web-tree-sitter';
import { CfgEdge, CfgEdgeKind, CfgNode, CfgNodeKind, Choice, CodeFacts, FlowGraph } from '../inspect/controlFlow';
import { AnalysisError } from '../analysis/types';
import { ReportLocation } from '../structure/report';
import { ControlFlowChart, CodeOptions, chartFrom, factSource } from '../inspect/controlFlowChart';
import { parseCSharp } from './parser';

/**
 * The control flow of a C# method, from the bundled parser's syntax tree: the same boxes and edges the TypeScript
 * flowchart has (decisions, loops, switch, try/catch/finally, break, continue, return, throw), each box with where it
 * is and the names it sets and reads, so the chart's paths, impossible-path check and dependences work as for
 * TypeScript.
 */

/** Things that have code of their own to chart: methods, constructors, accessors, local functions and lambdas. */
const functionTypes = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
  'accessor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
]);

/** Statements with no branches of their own, merged into one box when they follow each other. */
const simpleTypes = new Set(['expression_statement', 'local_declaration_statement', 'empty_statement', 'local_function_statement', 'yield_statement', 'goto_statement']);
/** `yield break` ends the method, like return: not a plain step. */
const isYieldBreak = (n: SyntaxNode) => n.type === 'yield_statement' && /^\s*yield\s+break\b/.test(n.text);
const isSimple = (n: SyntaxNode) => simpleTypes.has(n.type) && !isYieldBreak(n);
/** Statements that wrap a block: the header is a step, the block runs inside it. */
const wrapperTypes = new Set(['using_statement', 'lock_statement', 'checked_statement', 'unsafe_statement', 'fixed_statement']);

const isStatement = (n: SyntaxNode) => n.type === 'block' || n.type.endsWith('_statement');
const oneLine = (text: string, max = 120) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const statementLine = (n: SyntaxNode) => (n.type === 'local_function_statement' ? `${n.childForFieldName('name')?.text ?? 'function'}(…)` : oneLine(n.text).replace(/;$/, ''));

interface Pending {
  from: number;
  kind: CfgEdgeKind;
  label?: string;
  choice?: Choice;
}
interface Jump {
  label?: string;
  isLoop: boolean;
  breaks: Pending[];
  continueTo?: number;
}

/** The function-like node around the offset, innermost first. */
export function csharpFunctionAt(root: SyntaxNode, offset: number): SyntaxNode | undefined {
  for (let node: SyntaxNode | null = root.descendantForIndex(offset); node; node = node.parent) {
    if (functionTypes.has(node.type)) return node;
    if (node.type === 'property_declaration' || node.type === 'indexer_declaration') {
      // `int Count => items.Count;` is its own getter; on the name of a property with accessors, its get.
      if (node.namedChildren.some((c) => c?.type === 'arrow_expression_clause')) return node;
      const accessors = node.namedChildren.find((c) => c?.type === 'accessor_list');
      const getter = accessors?.namedChildren.find((a) => a?.type === 'accessor_declaration' && /^\s*(?:\w+\s+)*?get/.test(a.text));
      if (getter) return getter;
    }
  }
  return undefined;
}

/** A readable name: `Cart.Price`, `get Total`, `lambda`. */
function functionName(fn: SyntaxNode): string {
  const name = fn.childForFieldName('name')?.text;
  const owner = (() => {
    for (let p = fn.parent; p; p = p.parent) if (['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration'].includes(p.type)) return p.childForFieldName('name')?.text;
    return undefined;
  })();
  if (fn.type === 'accessor_declaration') {
    const keyword = fn.text.match(/^\s*(?:\w+\s+)*?(get|set|init|add|remove)\b/)?.[1] ?? 'get';
    let property: SyntaxNode | null = fn.parent;
    while (property && property.type !== 'property_declaration' && property.type !== 'indexer_declaration' && property.type !== 'event_declaration') property = property.parent;
    return `${keyword} ${property?.childForFieldName('name')?.text ?? 'this[]'}`;
  }
  if (fn.type === 'property_declaration' || fn.type === 'indexer_declaration') return `get ${name ?? 'this[]'}`;
  if (fn.type === 'lambda_expression' || fn.type === 'anonymous_method_expression') return 'lambda';
  if (fn.type === 'constructor_declaration') return `new ${name ?? owner ?? ''}`.trim();
  return owner && name && fn.type !== 'local_function_statement' ? `${owner}.${name}` : (name ?? 'function');
}

/** The names a parameter list declares. */
function parameterNames(fn: SyntaxNode): string[] {
  const list = fn.childForFieldName('parameters') ?? fn.namedChildren.find((c) => c?.type === 'parameter_list');
  if (!list) return fn.type === 'accessor_declaration' && /\b(set|init)\b/.test(fn.text.slice(0, 12)) ? ['value'] : [];
  const names: string[] = [];
  for (const p of list.descendantsOfType('parameter')) {
    const name = p?.childForFieldName('name') ?? p?.namedChildren.filter((c) => c?.type === 'identifier').pop();
    if (name) names.push(name.text);
  }
  // A lambda with one bare parameter: x => …
  if (!names.length && list.type === 'identifier') names.push(list.text);
  return names;
}

/** The root name of an assigned expression: `total` in `total`, `this.total`, `items[0]`, `cart.Total`. */
function rootName(n: SyntaxNode | null | undefined): string | undefined {
  while (n && (n.type === 'member_access_expression' || n.type === 'element_access_expression' || n.type === 'parenthesized_expression')) {
    const inner: SyntaxNode | null = n.type === 'member_access_expression' ? n.childForFieldName('expression') : n.namedChild(0);
    if (n.type === 'member_access_expression' && inner?.type === 'this_expression') return n.childForFieldName('name')?.text;
    n = inner;
  }
  return n?.type === 'identifier' ? n.text : undefined;
}

/** What the syntax sets, replaces and reads, by name. Nested functions and lambdas count as reads only. */
function factsOf(syntax: SyntaxNode[]): Pick<CodeFacts, 'defines' | 'replaces' | 'reads'> {
  const defines = new Set<string>();
  const replaces = new Set<string>();
  const reads = new Set<string>();
  const declared = new Set<SyntaxNode['id']>();
  const written = new Set<SyntaxNode['id']>();
  const visit = (n: SyntaxNode, top: boolean) => {
    if (!top && functionTypes.has(n.type)) {
      for (const id of n.descendantsOfType('identifier')) if (id) reads.add(id.text);
      return;
    }
    switch (n.type) {
      case 'variable_declarator': {
        const name = n.childForFieldName('name') ?? n.namedChild(0);
        if (name?.type === 'identifier') {
          defines.add(name.text);
          replaces.add(name.text);
          declared.add(name.id);
        }
        break;
      }
      case 'assignment_expression': {
        const left = n.childForFieldName('left') ?? n.namedChild(0);
        const name = rootName(left);
        if (name) {
          defines.add(name);
          // `x = …` and `x += …` give x a new value; `x.a = …` only changes it.
          if (left?.type === 'identifier' || (left?.type === 'member_access_expression' && left.childForFieldName('expression')?.type === 'this_expression')) {
            replaces.add(name);
            if (n.text.slice(left.endIndex - n.startIndex).trimStart().startsWith('=')) written.add(left.id);
          }
        }
        break;
      }
      case 'prefix_unary_expression':
      case 'postfix_unary_expression':
        if (/^\s*(\+\+|--)|(\+\+|--)\s*$/.test(n.text)) {
          const name = rootName(n.namedChild(0));
          if (name) {
            defines.add(name);
            replaces.add(name);
          }
        }
        break;
      case 'argument':
        if (/^\s*(out|ref)\b/.test(n.text)) {
          const name = rootName(n.namedChildren.find((c) => c?.type !== 'declaration_expression') ?? null) ?? n.descendantsOfType('identifier').pop()?.text;
          if (name) {
            defines.add(name);
            replaces.add(name);
          }
        }
        break;
      case 'invocation_expression': {
        // list.Add(x) changes list.
        const fn = n.childForFieldName('function') ?? n.namedChild(0);
        if (fn?.type === 'member_access_expression' && /^(Add|AddRange|Remove|RemoveAt|RemoveAll|Clear|Insert|Push|Pop|Enqueue|Dequeue|Sort|Reverse|Set)$/.test(fn.childForFieldName('name')?.text ?? '')) {
          const name = rootName(fn.childForFieldName('expression'));
          if (name) defines.add(name);
        }
        break;
      }
      case 'foreach_statement': {
        const left = n.childForFieldName('left');
        if (left?.type === 'identifier') {
          defines.add(left.text);
          replaces.add(left.text);
          declared.add(left.id);
        }
        break;
      }
      case 'catch_declaration': {
        const name = n.childForFieldName('name') ?? n.namedChildren.filter((c) => c?.type === 'identifier')[1];
        if (name) {
          defines.add(name.text);
          replaces.add(name.text);
          declared.add(name.id);
        }
        break;
      }
      case 'identifier': {
        const parent = n.parent;
        const isMemberName = parent?.type === 'member_access_expression' && parent.childForFieldName('name')?.id === n.id;
        const isTypeName = !!parent && /type|^generic_name$|^qualified_name$|object_creation_expression|^attribute$/.test(parent.type) && parent.childForFieldName('type')?.id !== undefined && parent.childForFieldName('type')?.id === n.id;
        if (!declared.has(n.id) && !written.has(n.id) && !isMemberName && !isTypeName) reads.add(n.text);
        return;
      }
    }
    for (const child of n.namedChildren) if (child) visit(child, false);
  };
  for (const s of syntax) visit(s, true);
  return { defines, replaces, reads };
}

const locationOf = (file: string, from: SyntaxNode, to: SyntaxNode = from): ReportLocation => ({
  file,
  line: from.startPosition.row,
  character: from.startPosition.column,
  endLine: to.endPosition.row,
  endCharacter: to.endPosition.column,
});

/** Code as written, without the indentation of its first line. */
function sourceOf(nodes: SyntaxNode[]): string[] {
  return nodes.flatMap((n) => {
    const column = n.startPosition.column;
    return n.text.split(/\r?\n/).map((l, i) => (i && /^\s*$/.test(l.slice(0, column)) ? l.slice(column) : l).trimEnd());
  });
}

/** The control flow of a C# function-like node. */
export function buildCSharpFlow(fn: SyntaxNode, file: string): FlowGraph {
  const nodes: CfgNode[] = [];
  const edges: CfgEdge[] = [];
  const jumps: Jump[] = [];
  const catches: { throws: Pending[] }[] = [];
  const add = (kind: CfgNodeKind, lines: string[], syntax: SyntaxNode[]): number => {
    const node: CfgNode = { id: nodes.length, kind, lines, nodes: [] };
    if (syntax.length && kind !== 'start' && kind !== 'end') {
      node.facts = { location: locationOf(file, syntax[0], syntax[syntax.length - 1]), source: sourceOf(syntax), ...factsOf(syntax) };
    }
    nodes.push(node);
    return node.id;
  };
  const connect = (pending: Pending[], to: number) => {
    for (const p of pending) edges.push({ from: p.from, to, kind: p.kind, label: p.label, choice: p.choice });
  };
  const enter = (pending: Pending[], kind: CfgNodeKind, lines: string[], syntax: SyntaxNode[]) => {
    const id = add(kind, lines, syntax);
    connect(pending, id);
    return id;
  };
  const name = functionName(fn);
  const start = add('start', [name], []);
  const end = add('end', ['end'], []);

  function list(statements: SyntaxNode[], pending: Pending[]): Pending[] {
    let run: SyntaxNode[] = [];
    const flush = () => {
      if (!run.length) return;
      const id = enter(pending, 'statement', run.map(statementLine), run);
      pending = [{ from: id, kind: 'next' }];
      run = [];
    };
    for (const s of statements) {
      if (isSimple(s)) {
        run.push(s);
        continue;
      }
      flush();
      pending = stmt(s, pending);
    }
    flush();
    return pending;
  }

  const children = (n: SyntaxNode) => n.namedChildren.filter((c): c is SyntaxNode => !!c);

  function loopBody(body: SyntaxNode | null, entry: Pending[], test: number, label: string | undefined): Pending[] {
    const jump: Jump = { label, isLoop: true, breaks: [], continueTo: test };
    jumps.push(jump);
    const out = body ? stmt(body, entry) : entry;
    jumps.pop();
    for (const p of out) edges.push({ from: p.from, to: test, kind: 'back', label: p.label, choice: p.choice });
    return jump.breaks;
  }

  function stmt(s: SyntaxNode, pending: Pending[], label?: string): Pending[] {
    switch (s.type) {
      case 'block':
        return list(children(s).filter(isStatement), pending);
      case 'labeled_statement': {
        const inner = children(s).find((c) => c.type !== 'identifier');
        return inner ? stmt(inner, pending, children(s)[0]?.text) : pending;
      }
      case 'if_statement': {
        const conditionNode = s.childForFieldName('condition')!;
        const condition = oneLine(conditionNode.text);
        const id = enter(pending, 'decision', [condition], [conditionNode]);
        const yes = stmt(s.childForFieldName('consequence')!, [{ from: id, kind: 'true', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'condition' } }]);
        const noEntry: Pending[] = [{ from: id, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'condition' } }];
        const otherwise = s.childForFieldName('alternative');
        return [...yes, ...(otherwise ? stmt(otherwise, noEntry) : noEntry)];
      }
      case 'switch_statement': {
        const valueNode = s.childForFieldName('value') ?? children(s)[0];
        const subject = oneLine(valueNode.text.replace(/^\((.*)\)$/s, '$1'));
        const id = enter(pending, 'switch', [`switch (${subject})`], [valueNode]);
        const jump: Jump = { label, isLoop: false, breaks: [] };
        jumps.push(jump);
        const body = s.childForFieldName('body') ?? children(s).find((c) => c.type === 'switch_body');
        const sections = body ? children(body).filter((c) => c.type === 'switch_section') : [];
        const labelOf = (section: SyntaxNode) => {
          const firstStatement = children(section).find(isStatement);
          const head = (firstStatement ? section.text.slice(0, firstStatement.startIndex - section.startIndex) : section.text).trim().replace(/:$/, '');
          return oneLine(head, 50);
        };
        const values = sections.map(labelOf).filter((l) => !/^default\b/.test(l)).map((l) => l.replace(/^case\s+/, ''));
        let fallThrough: Pending[] = [];
        let hasDefault = false;
        for (const section of sections) {
          const head = labelOf(section);
          const isDefault = /^default\b/.test(head);
          hasDefault ||= isDefault;
          const value = head.replace(/^case\s+/, '');
          const entry: Pending = isDefault
            ? { from: id, kind: 'default', label: 'default', choice: { subject, outcome: 'default', kind: 'case', excludes: values } }
            : { from: id, kind: 'case', label: head, choice: { subject, outcome: value, kind: 'case' } };
          const statements = children(section).filter(isStatement);
          fallThrough = statements.length ? list(statements, [entry, ...fallThrough]) : [entry, ...fallThrough];
        }
        jumps.pop();
        const noMatch: Pending[] = hasDefault ? [] : [{ from: id, kind: 'default', label: 'no case matches', choice: { subject, outcome: 'default', kind: 'case', excludes: values } }];
        return [...jump.breaks, ...fallThrough, ...noMatch];
      }
      case 'while_statement':
      case 'for_statement':
      case 'foreach_statement': {
        let header: string;
        let subject: string;
        if (s.type === 'for_statement') {
          const init = s.childForFieldName('initializer');
          if (init) {
            const id = enter(pending, 'statement', [oneLine(init.text)], [init]);
            pending = [{ from: id, kind: 'next' }];
          }
          const condition = s.childForFieldName('condition');
          const update = s.childForFieldName('update');
          header = `for (${init ? oneLine(init.text, 40) : ''}; ${condition ? oneLine(condition.text, 40) : ''}; ${update ? oneLine(update.text, 40) : ''})`;
          subject = condition ? oneLine(condition.text) : 'true';
        } else if (s.type === 'foreach_statement') {
          const over = s.childForFieldName('right');
          header = oneLine(s.text.slice(0, (s.childForFieldName('body')?.startIndex ?? s.endIndex) - s.startIndex));
          subject = `each item of ${oneLine(over?.text ?? '', 60)}`;
        } else {
          const condition = s.childForFieldName('condition')!;
          header = `while (${oneLine(condition.text)})`;
          subject = oneLine(condition.text);
        }
        const headerNode = s.type === 'while_statement' ? s.childForFieldName('condition')! : s;
        const test = add('loop', [header], []);
        nodes[test].facts = { location: locationOf(file, s, headerNode), source: [header], ...factsOf(s.type === 'foreach_statement' ? [s.childForFieldName('right')!].filter(Boolean) : s.type === 'for_statement' ? [s.childForFieldName('condition'), s.childForFieldName('update')].filter((x): x is SyntaxNode => !!x) : [headerNode]) };
        if (s.type === 'foreach_statement') {
          const left = s.childForFieldName('left');
          if (left?.type === 'identifier') {
            nodes[test].facts!.defines.add(left.text);
            nodes[test].facts!.replaces.add(left.text);
          }
        }
        connect(pending, test);
        const each = s.type === 'foreach_statement';
        const breaks = loopBody(s.childForFieldName('body'), [{ from: test, kind: 'true', label: each ? 'each item' : 'yes', choice: { subject, outcome: 'true', kind: 'loop' } }], test, label);
        return [{ from: test, kind: 'false', label: each ? 'done' : 'no', choice: { subject, outcome: 'false', kind: 'loop' } }, ...breaks];
      }
      case 'do_statement': {
        const first = nodes.length;
        const jump: Jump = { label, isLoop: true, breaks: [] };
        jumps.push(jump);
        const body = s.childForFieldName('body') ?? children(s).find(isStatement);
        const bodyEnd = body ? stmt(body, pending) : pending;
        const conditionNode = s.childForFieldName('condition') ?? children(s).filter((c) => !isStatement(c)).pop()!;
        const condition = oneLine(conditionNode.text);
        const test = enter(bodyEnd, 'loop', [`do … while (${condition})`], [conditionNode]);
        jumps.pop();
        for (const edge of edges) if (edge.to === -1) edge.to = test;
        jump.continueTo = test;
        edges.push({ from: test, to: first < test ? first : test, kind: 'back', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'loop' } });
        return [{ from: test, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'loop' } }, ...jump.breaks];
      }
      case 'break_statement':
      case 'continue_statement': {
        const isBreak = s.type === 'break_statement';
        const jump = [...jumps].reverse().find((j) => isBreak || j.isLoop);
        if (!jump) return pending;
        if (isBreak) jump.breaks.push(...pending.map((p) => ({ ...p })));
        else for (const p of pending) edges.push({ from: p.from, to: jump.continueTo ?? -1, kind: 'continue', label: p.label ?? 'continue', choice: p.choice });
        return [];
      }
      case 'yield_statement':
        // yield return is a step (merged with its neighbours); yield break ends the method like return.
        if (!isYieldBreak(s)) return list([s], pending);
      // falls through
      case 'return_statement': {
        const value = children(s)[0];
        const id = enter(pending, 'return', [isYieldBreak(s) ? 'yield break' : value ? `return ${oneLine(value.text)}` : 'return'], [s]);
        edges.push({ from: id, to: end, kind: 'return' });
        return [];
      }
      case 'throw_statement': {
        const value = children(s)[0];
        const id = enter(pending, 'throw', [value ? `throw ${oneLine(value.text)}` : 'throw'], [s]);
        const handler = catches[catches.length - 1];
        if (handler) handler.throws.push({ from: id, kind: 'throw', label: 'throws' });
        else edges.push({ from: id, to: end, kind: 'throw', label: 'throws' });
        return [];
      }
      case 'try_statement': {
        const catchClauses = children(s).filter((c) => c.type === 'catch_clause');
        const finallyClause = children(s).find((c) => c.type === 'finally_clause');
        const handler = { throws: [] as Pending[] };
        const tryFirst = nodes.length;
        if (catchClauses.length) catches.push(handler);
        const tryBlock = s.childForFieldName('body') ?? children(s).find((c) => c.type === 'block')!;
        const afterTry = stmt(tryBlock, pending);
        if (catchClauses.length) catches.pop();
        let afterCatch: Pending[] = [];
        // Anything in the try block may throw: each catch is reachable from its first box even without a throw statement.
        const fromTry: Pending[] = handler.throws.length ? handler.throws : tryFirst < nodes.length ? [{ from: tryFirst, kind: 'throw', label: 'throws' }] : [];
        for (const clause of catchClauses) {
          const block = children(clause).find((c) => c.type === 'block');
          const head = oneLine(clause.text.slice(0, (block?.startIndex ?? clause.endIndex) - clause.startIndex));
          const catchId = enter(fromTry.map((p) => ({ ...p })), 'catch', [head], children(clause).filter((c) => c.type !== 'block'));
          afterCatch = [...afterCatch, ...(block ? stmt(block, [{ from: catchId, kind: 'next' }]) : [{ from: catchId, kind: 'next' as const }])];
        }
        if (finallyClause) {
          const finallyId = enter([...afterTry, ...afterCatch], 'finally', ['finally'], []);
          const block = children(finallyClause).find((c) => c.type === 'block');
          return block ? stmt(block, [{ from: finallyId, kind: 'next' }]) : [{ from: finallyId, kind: 'next' }];
        }
        return [...afterTry, ...afterCatch];
      }
      default: {
        if (wrapperTypes.has(s.type)) {
          // using (…) { … }, lock (o) { … }: the header is a step, the block runs after it.
          const body = children(s).filter(isStatement).pop();
          const header = body ? s.text.slice(0, body.startIndex - s.startIndex) : s.text;
          const headerSyntax = children(s).filter((c) => c !== body);
          const id = enter(pending, 'statement', [oneLine(header)], headerSyntax.length ? headerSyntax : [s]);
          return body ? stmt(body, [{ from: id, kind: 'next' }]) : [{ from: id, kind: 'next' }];
        }
        if (isSimple(s)) return list([s], pending);
        const id = enter(pending, 'statement', [oneLine(s.text)], [s]);
        return [{ from: id, kind: 'next' }];
      }
    }
  }

  const body = fn.childForFieldName('body') ?? fn.namedChildren.find((c) => c?.type === 'block' || c?.type === 'arrow_expression_clause') ?? null;
  let out: Pending[];
  if (!body) {
    out = [{ from: start, kind: 'next' }];
  } else if (body.type === 'block') {
    out = list(children(body).filter(isStatement), [{ from: start, kind: 'next' }]);
  } else {
    // An expression body (=> …) is the value the function returns.
    const expression = body.type === 'arrow_expression_clause' ? (body.namedChild(0) ?? body) : body;
    const id = enter([{ from: start, kind: 'next' }], 'return', [`return ${oneLine(expression.text)}`], [expression]);
    edges.push({ from: id, to: end, kind: 'return' });
    out = [];
  }
  connect(out, end);
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
  return { name, nodes, edges, start, end, parameters: parameterNames(fn) };
}

/** The flowchart of the C# method (or other function) at the offset. */
export async function csharpFlowChart(code: string, file: string, offset: number, options: CodeOptions = {}): Promise<ControlFlowChart> {
  const tree = await parseCSharp(code);
  try {
    const fn = csharpFunctionAt(tree.rootNode, offset);
    if (!fn) throw new AnalysisError('Put the cursor inside a C# method, constructor, property accessor or lambda.');
    const graph = buildCSharpFlow(fn, file);
    const nameNode = fn.childForFieldName('name') ?? fn;
    return chartFrom(graph, factSource(file, fn.startIndex, locationOf(file, nameNode)), () => [], options);
  } finally {
    tree.delete();
  }
}
