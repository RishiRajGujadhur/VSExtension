import ts = require('typescript');
import { Cfg, CfgEdge, Choice, buildCfg } from './controlFlow';
import { AnalysisError } from '../analysis/types';
import { FunctionWithBody, enclosingFunction, identifierAt, isFunctionWithBody, symbolAt } from '../structure/util';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';

/** One way through a function: the nodes and edges in order, the branches taken, and how it ends. */
export interface CfgPath {
  nodes: number[];
  /** Indexes into cfg.edges. */
  edges: number[];
  choices: Choice[];
  /** What the path ends with: the returned expression, the thrown error, or falling off the end. */
  ending: { kind: 'return' | 'throw' | 'end'; text?: string };
  /** False when the path takes the same unchanged condition both ways, or two cases of the same unchanged switch. */
  feasible: boolean;
  reason?: string;
}

/** Most paths enumerated per function; beyond it the list says it is incomplete. */
export const maxPaths = 300;

/**
 * Every path from the start of the function to its end. Each loop is taken zero or one times, which is enough to
 * show what every branch inside it does without enumerating iteration counts.
 */
export function cfgPaths(cfg: Cfg, limit = maxPaths): { paths: CfgPath[]; truncated: boolean } {
  const outgoing = new Map<number, number[]>();
  cfg.edges.forEach((edge, index) => outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), index]));
  const paths: CfgPath[] = [];
  let truncated = false;
  const walk = (node: number, nodes: number[], edges: number[], loopsTaken: Set<number>): void => {
    if (paths.length >= limit) {
      truncated = true;
      return;
    }
    if (node === cfg.end) {
      paths.push(finish(cfg, nodes, edges));
      return;
    }
    for (const index of outgoing.get(node) ?? []) {
      const edge = cfg.edges[index];
      const repeats = edge.kind === 'back' || edge.kind === 'continue';
      if (repeats && loopsTaken.has(index)) continue;
      // Any other edge back to a node already on the path would only come from a loop: skip it.
      if (!repeats && nodes.includes(edge.to) && edge.to !== cfg.end) continue;
      const taken = repeats ? new Set([...loopsTaken, index]) : loopsTaken;
      walk(edge.to, [...nodes, edge.to], [...edges, index], taken);
    }
  };
  walk(cfg.start, [cfg.start], [], new Set());
  return { paths, truncated };
}

function finish(cfg: Cfg, nodes: number[], edges: number[]): CfgPath {
  const last = cfg.nodes[nodes[nodes.length - 2]];
  const ending: CfgPath['ending'] =
    last?.kind === 'return' ? { kind: 'return', text: last.lines[0].replace(/^return\s*/, '') || undefined } : last?.kind === 'throw' ? { kind: 'throw', text: last.lines[0].replace(/^throw\s*/, '') } : { kind: 'end' };
  const choices = edges.map((e) => cfg.edges[e].choice).filter((c): c is Choice => !!c);
  const contradiction = contradictionIn(cfg, nodes, edges);
  return { nodes, edges, choices, ending, feasible: !contradiction, reason: contradiction };
}

/** `!user.active` false is the same as `user.active` true. */
function normalize(choice: Choice): { subject: string; outcome: string } {
  let { subject, outcome } = choice;
  if (choice.kind !== 'condition') return { subject, outcome };
  subject = subject.replace(/^\((.*)\)$/, '$1');
  while (/^![\w$.()[\]'"]+$/.test(subject) || /^!\(.*\)$/.test(subject)) {
    subject = subject.slice(1).replace(/^\((.*)\)$/, '$1');
    outcome = outcome === 'true' ? 'false' : 'true';
  }
  return { subject, outcome };
}

/** Names assigned in a node: a later test of them may come out differently. */
function assignedNames(cfg: Cfg, id: number): Set<string> {
  const names = new Set<string>();
  const root = (e: ts.Node): string | undefined => {
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const name = root(node.left);
      if (name) names.add(name);
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const name = root(node.operand);
      if (name) names.add(name);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    } else if (ts.isCallExpression(node)) {
      // A call may change the object it is called on: items.push(x).
      const name = ts.isPropertyAccessExpression(node.expression) ? root(node.expression.expression) : undefined;
      if (name) names.add(name);
    }
    if (!isFunctionWithBody(node)) ts.forEachChild(node, visit);
  };
  const node = cfg.nodes[id];
  if (node.kind === 'statement' || node.kind === 'loop' || node.kind === 'catch') node.nodes.forEach(visit);
  return names;
}

const mentions = (subject: string, names: Set<string>): boolean => [...names].some((name) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(subject));

/** Why a path cannot happen, if it tests the same thing two incompatible ways with nothing changed in between. */
function contradictionIn(cfg: Cfg, nodes: number[], edges: number[]): string | undefined {
  // What each tested subject was found to be, forgotten when something it mentions is assigned.
  let known = new Map<string, { outcome: string; excludes?: string[] }>();
  for (let i = 0; i < edges.length; i++) {
    const edge: CfgEdge = cfg.edges[edges[i]];
    if (edge.choice && edge.choice.kind !== 'loop') {
      const { subject, outcome } = normalize(edge.choice);
      const before = known.get(subject);
      if (before) {
        if (edge.choice.kind === 'condition' && before.outcome !== outcome) return `${subject} cannot be both true and false here`;
        if (edge.choice.kind === 'case') {
          const clash =
            (outcome !== 'default' && before.outcome !== 'default' && outcome !== before.outcome) ||
            (outcome === 'default' && before.outcome !== 'default' && edge.choice.excludes?.includes(before.outcome)) ||
            (before.outcome === 'default' && outcome !== 'default' && before.excludes?.includes(outcome));
          if (clash) return `${subject} cannot match both ${before.outcome} and ${outcome}`;
        }
      }
      known.set(subject, { outcome, excludes: edge.choice.excludes });
    }
    const assigned = assignedNames(cfg, nodes[i + 1]);
    if (assigned.size) known = new Map([...known].filter(([subject]) => !mentions(subject, assigned)));
  }
  return undefined;
}

/** A branch in words: "user.active", "not sensitive", "user.role is 'member'", "the loop over items runs". */
export function describeChoice(choice: Choice): string {
  if (choice.kind === 'case') {
    // switch (true) { case score >= 90: … } tests each case itself.
    if (choice.subject === 'true') {
      return choice.outcome === 'default' ? `none of ${(choice.excludes ?? []).join(', ') || 'the cases'} holds` : choice.outcome;
    }
    return choice.outcome === 'default' ? `${choice.subject} is none of ${(choice.excludes ?? []).join(', ') || 'the cases'}` : `${choice.subject} is ${choice.outcome}`;
  }
  if (choice.kind === 'loop') {
    return choice.outcome === 'true' ? `${choice.subject} runs` : `${choice.subject} is done`;
  }
  const { subject, outcome } = normalize(choice);
  return outcome === 'true' ? subject : `not ${/^[\w$.]+$/.test(subject) ? subject : `(${subject})`}`;
}

export interface ValueSource {
  /** The value, such as `'write'` or `'A or B' + '!'`; or a description when it is not an expression. */
  value: string;
  /** Where the value was given, when it was assigned in the function. */
  node?: ts.Node;
  /** The conditions of each path that gives this value, without repeats. */
  ways: { choices: Choice[]; path: CfgPath }[];
}

export interface ValueExplanation {
  name: string;
  fn: FunctionWithBody;
  cfg: Cfg;
  /** The node the cursor is in. */
  at: number;
  sources: ValueSource[];
  /** Paths that reach the point but cannot happen. */
  impossible: CfgPath[];
  truncated: boolean;
}

/**
 * Explain Value Path: every value a variable can have at the cursor, with the branch conditions that lead to each.
 * Paths to the point are followed backwards to the last assignment of the variable on each of them.
 */
export function explainValue(project: VirtualProject, fileName: string, offset: number): ValueExplanation {
  const sourceFile = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a variable or parameter.');
  const symbol = symbolAt(checker, identifier);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Variable)) {
    throw new AnalysisError(`'${identifier.text}' isn't a variable or parameter.`);
  }
  const fn = enclosingFunction(identifier);
  if (!fn) {
    throw new AnalysisError('Place the cursor inside a function: Explain Value Path follows the paths through it.');
  }
  const cfg = buildCfg(fn);
  const contains = (n: ts.Node) => n.getStart(sourceFile) <= offset && offset <= n.end;
  // The innermost node: a condition inside a statement block wins over the block.
  const candidates = cfg.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end' && n.nodes.some(contains));
  const at = candidates.sort((a, b) => span(a) - span(b))[0]?.id;
  if (at === undefined) {
    throw new AnalysisError('The cursor is not in a statement of the function.');
  }
  const { paths, truncated } = cfgPaths(cfg);
  const same = (n: ts.Node) => ts.isIdentifier(n) && symbolAt(checker, n) === symbol;
  const sources = new Map<string, ValueSource>();
  const impossible: CfgPath[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const stop = path.nodes.indexOf(at);
    if (stop < 0) continue;
    // The path up to the point; the same prefix can belong to many full paths.
    const key = path.edges.slice(0, stop).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!path.feasible) {
      impossible.push(path);
      continue;
    }
    let value: { text: string; node?: ts.Node } | undefined;
    for (let i = 0; i <= stop; i++) {
      const node = cfg.nodes[path.nodes[i]];
      // A loop node stands for its whole statement; only its header assigns (for (const item of items)).
      const statements = node.kind === 'statement' || node.kind === 'catch' ? node.nodes : node.kind === 'loop' ? node.nodes.map(loopHeader).filter((n): n is ts.Node => !!n) : [];
      for (const statement of statements) {
        if (i === stop && statement.getStart(sourceFile) >= offset) break;
        value = lastDefinition(statement, same, value, i === stop ? offset : undefined) ?? value;
      }
    }
    if (!value) {
      value = initialValue(symbol, fn);
    }
    const prefixChoices = path.edges.slice(0, stop).map((e) => cfg.edges[e].choice).filter((c): c is Choice => !!c);
    const source = sources.get(value.text) ?? { value: value.text, node: value.node, ways: [] };
    source.ways.push({ choices: prefixChoices, path });
    sources.set(value.text, source);
  }
  return { name: identifier.text, fn, cfg, at, sources: [...sources.values()], impossible, truncated };
}

/** The part of a loop statement that assigns: the variable of a for…of or for…in. */
function loopHeader(node: ts.Node): ts.Node | undefined {
  return (ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer) ? node : undefined;
}

function span(node: { nodes: ts.Node[] }): number {
  return node.nodes.reduce((total, n) => total + (n.end - n.pos), 0);
}

/** The value a statement leaves in the variable, given the value before it; compound updates build on it. */
function lastDefinition(statement: ts.Node, same: (n: ts.Node) => boolean, before: { text: string; node?: ts.Node } | undefined, until?: number): { text: string; node?: ts.Node } | undefined {
  let value = before;
  let changed = false;
  const visit = (node: ts.Node): void => {
    if (until !== undefined && node.getStart() >= until) return;
    if (isFunctionWithBody(node)) return;
    if (!((ts.isForOfStatement(node) || ts.isForInStatement(node)) && node === statement)) ts.forEachChild(node, visit);
    if (ts.isVariableDeclaration(node) && same(node.name)) {
      value = { text: node.initializer ? node.initializer.getText() : 'undefined', node };
      changed = true;
    } else if (ts.isBinaryExpression(node) && same(node.left)) {
      const op = node.operatorToken.getText();
      if (op === '=') value = { text: node.right.getText(), node };
      else if (op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>=') value = { text: `${wrap(value?.text ?? '?')} ${op.slice(0, -1)} ${node.right.getText()}`, node };
      else return;
      changed = true;
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && same(node.operand) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      value = { text: `${wrap(value?.text ?? '?')} ${node.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'} 1`, node };
      changed = true;
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.some((d) => same(d.name))) {
      value = { text: `${ts.isForOfStatement(node) ? 'each item of' : 'each key of'} ${node.expression.getText()}`, node: node.initializer };
      changed = true;
    }
  };
  visit(statement);
  return changed ? value : undefined;
}

/** Parentheses around an expression before an operator is added, except for names and string literals. */
const wrap = (text: string) => (/^[\w$.[\]]+$/.test(text) || /^(['"`])[^'"`]*\1$/.test(text) ? text : `(${text})`);

/** Before any assignment in the function: a parameter's argument, or a variable declared elsewhere. */
function initialValue(symbol: ts.Symbol, fn: FunctionWithBody): { text: string; node?: ts.Node } {
  const declaration = symbol.valueDeclaration;
  if (declaration && ts.isParameter(declaration)) {
    return { text: declaration.initializer ? `the argument, or ${declaration.initializer.getText()} if left out` : 'the argument callers pass', node: declaration };
  }
  if (declaration && ts.isBindingElement(declaration)) {
    return { text: 'destructured from the argument', node: declaration };
  }
  if (declaration && !(declaration.pos >= fn.pos && declaration.end <= fn.end)) {
    return { text: 'its value from outside the function', node: declaration };
  }
  return { text: 'undefined (not assigned yet)' };
}

/**
 * Explain Value Path as a report: each value the variable can have at the cursor, the ways (sets of branch
 * conditions) that give it, and each condition linked to its code.
 */
export function explainValueReport(project: VirtualProject, fileName: string, offset: number): Report {
  const explanation = explainValue(project, fileName, offset);
  const { cfg, name } = explanation;
  const builder = new ReportBuilder('explainValue', `Value path of ${name}`);
  const conditionRow = (edgeIndex: number): ReportNode => {
    const edge = cfg.edges[edgeIndex];
    const decision = cfg.nodes[edge.from].nodes[0];
    return { label: describeChoice(edge.choice!), description: edge.label, icon: 'filter', location: decision ? builder.at(decision) : undefined };
  };
  const at = cfg.nodes[explanation.at].nodes[0];
  const line = at ? at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1 : undefined;
  const roots: ReportNode[] = explanation.sources.map((source) => ({
    label: /^(undefined|the argument|destructured|its value|each item|each key)/.test(source.value) ? source.value : `= ${source.value}`,
    description: plural(source.ways.length, 'way'),
    tooltip: `${name} is ${source.value} at line ${line} when the code takes ${source.ways.length === 1 ? 'this path' : `one of these ${source.ways.length} paths`}.`,
    icon: 'symbol-variable',
    location: source.node ? builder.at(source.node) : undefined,
    expanded: true,
    children: source.ways.map((way) => {
      const stop = way.path.nodes.indexOf(explanation.at);
      const decisions = way.path.edges.slice(0, stop).filter((e) => cfg.edges[e].choice);
      return {
        label: decisions.length ? decisions.map((e) => describeChoice(cfg.edges[e].choice!)).join(', ') : 'always',
        description: decisions.length ? plural(decisions.length, 'condition') : 'no branch decides it',
        icon: 'git-branch',
        expanded: source.ways.length <= 3,
        children: decisions.map(conditionRow),
      };
    }),
  }));
  if (explanation.impossible.length) {
    roots.push({
      label: 'Impossible paths',
      description: `${plural(explanation.impossible.length, 'path')} that cannot happen`,
      icon: 'circle-slash',
      children: explanation.impossible.map((p) => ({ label: p.reason ?? 'contradictory conditions', description: p.choices.map(describeChoice).join(', '), icon: 'circle-slash' })),
    });
  }
  if (explanation.truncated) {
    builder.warnings.push(`Only the first ${maxPaths} paths through ${cfg.name} were followed; there may be more values.`);
  }
  const values = explanation.sources.length;
  return builder.finish(roots, values ? `${plural(values, 'possible value')} at line ${line}` : `no path reaches line ${line}`);
}
