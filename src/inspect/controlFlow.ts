import ts = require('typescript');
import { FunctionWithBody, functionLabel } from '../structure/util';

/**
 * Control flow of one function: the statements and decisions execution can pass through and the edges between
 * them, labeled with the branch taken. Built from the syntax tree only (no type information), so it is exact for
 * if/else, switch (with fall-through), loops, break/continue, return, throw and try/catch/finally, and it does not
 * model branches hidden inside expressions (&&, ||, ?:, ?.) or exceptions thrown by called functions.
 */

export type CfgNodeKind = 'start' | 'end' | 'statement' | 'decision' | 'switch' | 'loop' | 'return' | 'throw' | 'catch' | 'finally';

export interface CfgNode {
  id: number;
  kind: CfgNodeKind;
  /** One line per statement for statement blocks; the condition or header for decisions and loops. */
  lines: string[];
  /** The syntax the node stands for: its statements, or the condition. */
  nodes: ts.Node[];
  /** No edge leads here: code after a return, throw, break or continue. */
  unreachable?: boolean;
}

export type CfgEdgeKind = 'next' | 'true' | 'false' | 'case' | 'default' | 'back' | 'break' | 'continue' | 'return' | 'throw' | 'exit';

export interface CfgEdge {
  from: number;
  to: number;
  kind: CfgEdgeKind;
  /** What the edge shows: yes, no, case "admin", default, each item, done… */
  label?: string;
  /** The condition this branch decides, for paths: the tested code and the outcome. */
  choice?: Choice;
}

/** A branch taken: `!user.active` is false, `user.role` is "member", the loop over `items` runs. */
export interface Choice {
  /** The code that is tested, such as `!user.active` or `user.role`. */
  subject: string;
  /** true or false for conditions; the case value or 'default' for switches. */
  outcome: string;
  kind: 'condition' | 'case' | 'loop';
  /** For a default case, the case values it excludes. */
  excludes?: string[];
}

export interface Cfg {
  name: string;
  fn: FunctionWithBody;
  nodes: CfgNode[];
  edges: CfgEdge[];
  start: number;
  end: number;
}

/** A dangling edge waiting for the next node. */
interface Pending {
  from: number;
  kind: CfgEdgeKind;
  label?: string;
  choice?: Choice;
}

interface Jump {
  /** Loop or switch label, such as `outer:`. */
  label?: string;
  isLoop: boolean;
  breaks: Pending[];
  /** Where continue goes: the loop's test. */
  continueTo?: number;
}

const text = (node: ts.Node, max = 120): string => {
  const t = node.getText().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Statements with no branches of their own, merged into one box when they follow each other. */
function isSimple(statement: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isEmptyStatement(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isDebuggerStatement(statement)
  );
}

/** The text a simple statement shows: nested functions and classes as one line. */
function statementLine(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement)) return `function ${statement.name?.text ?? ''}(…)`;
  if (ts.isClassDeclaration(statement)) return `class ${statement.name?.text ?? ''}`;
  return text(statement).replace(/;$/, '');
}

export function buildCfg(fn: FunctionWithBody): Cfg {
  const nodes: CfgNode[] = [];
  const edges: CfgEdge[] = [];
  const jumps: Jump[] = [];
  // Catch targets of the try blocks we are in, innermost last, and the throws collected for each.
  const catches: { throws: Pending[] }[] = [];
  const add = (kind: CfgNodeKind, lines: string[], syntax: ts.Node[]): number => {
    nodes.push({ id: nodes.length, kind, lines, nodes: syntax });
    return nodes.length - 1;
  };
  const connect = (pending: Pending[], to: number): void => {
    for (const p of pending) edges.push({ from: p.from, to, kind: p.kind, label: p.label, choice: p.choice });
  };
  /** A node reached from `pending`, marked unreachable when nothing leads to it. */
  const enter = (pending: Pending[], kind: CfgNodeKind, lines: string[], syntax: ts.Node[]): number => {
    const id = add(kind, lines, syntax);
    connect(pending, id);
    return id;
  };

  const start = add('start', [functionLabel(fn)], [fn]);
  const end = add('end', ['end'], []);

  function list(statements: readonly ts.Statement[], pending: Pending[]): Pending[] {
    let run: ts.Statement[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const id = enter(pending, 'statement', run.map(statementLine), run);
      pending = [{ from: id, kind: 'next' }];
      run = [];
    };
    for (const statement of statements) {
      if (isSimple(statement)) {
        run.push(statement);
        continue;
      }
      flush();
      pending = stmt(statement, pending);
    }
    flush();
    return pending;
  }

  /** A loop body, with break and continue going to the loop. */
  function loopBody(body: ts.Statement, entry: Pending[], test: number, label: string | undefined): Pending[] {
    const jump: Jump = { label, isLoop: true, breaks: [], continueTo: test };
    jumps.push(jump);
    const out = stmt(body, entry);
    jumps.pop();
    for (const p of out) edges.push({ from: p.from, to: test, kind: 'back', label: p.label, choice: p.choice });
    return jump.breaks;
  }

  function stmt(statement: ts.Statement, pending: Pending[], label?: string): Pending[] {
    if (ts.isBlock(statement)) return list(statement.statements, pending);
    if (isSimple(statement)) return list([statement], pending);

    if (ts.isLabeledStatement(statement)) return stmt(statement.statement, pending, statement.label.text);

    if (ts.isIfStatement(statement)) {
      const condition = text(statement.expression);
      const id = enter(pending, 'decision', [condition], [statement.expression]);
      const yes = stmt(statement.thenStatement, [{ from: id, kind: 'true', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'condition' } }]);
      const noEntry: Pending[] = [{ from: id, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'condition' } }];
      const no = statement.elseStatement ? stmt(statement.elseStatement, noEntry) : noEntry;
      return [...yes, ...no];
    }

    if (ts.isSwitchStatement(statement)) {
      const subject = text(statement.expression);
      const id = enter(pending, 'switch', [`switch (${subject})`], [statement.expression]);
      const jump: Jump = { label, isLoop: false, breaks: [] };
      jumps.push(jump);
      const values = statement.caseBlock.clauses.filter(ts.isCaseClause).map((c) => text(c.expression, 40));
      let fallThrough: Pending[] = [];
      let hasDefault = false;
      for (const clause of statement.caseBlock.clauses) {
        const isDefault = ts.isDefaultClause(clause);
        hasDefault ||= isDefault;
        const value = isDefault ? 'default' : text(clause.expression, 40);
        const entry: Pending = isDefault
          ? { from: id, kind: 'default', label: 'default', choice: { subject, outcome: 'default', kind: 'case', excludes: values } }
          : { from: id, kind: 'case', label: `case ${value}`, choice: { subject, outcome: value, kind: 'case' } };
        // An empty case shares the statements of the next one: `case "a": case "b": …`.
        fallThrough = clause.statements.length ? list(clause.statements, [entry, ...fallThrough]) : [entry, ...fallThrough];
      }
      jumps.pop();
      const noMatch: Pending[] = hasDefault ? [] : [{ from: id, kind: 'default', label: 'no case matches', choice: { subject, outcome: 'default', kind: 'case', excludes: values } }];
      return [...jump.breaks, ...fallThrough, ...noMatch];
    }

    if (ts.isWhileStatement(statement) || ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      if (ts.isForStatement(statement) && statement.initializer) {
        const id = enter(pending, 'statement', [text(statement.initializer)], [statement.initializer]);
        pending = [{ from: id, kind: 'next' }];
      }
      let header: string;
      let subject: string;
      if (ts.isWhileStatement(statement)) {
        header = `while (${text(statement.expression)})`;
        subject = text(statement.expression);
      } else if (ts.isForStatement(statement)) {
        header = `for (${statement.initializer ? text(statement.initializer, 40) : ''}; ${statement.condition ? text(statement.condition, 40) : ''}; ${statement.incrementor ? text(statement.incrementor, 40) : ''})`;
        subject = statement.condition ? text(statement.condition) : 'true';
      } else {
        header = `for (${text(statement.initializer, 40)} ${ts.isForOfStatement(statement) ? 'of' : 'in'} ${text(statement.expression, 60)})`;
        subject = `${ts.isForOfStatement(statement) ? 'each item of' : 'each key of'} ${text(statement.expression, 60)}`;
      }
      const test = enter(pending, 'loop', [header], [statement]);
      const each = ts.isForOfStatement(statement) || ts.isForInStatement(statement);
      const breaks = loopBody(statement.statement, [{ from: test, kind: 'true', label: each ? 'each item' : 'yes', choice: { subject, outcome: 'true', kind: 'loop' } }], test, label);
      return [{ from: test, kind: 'false', label: each ? 'done' : 'no', choice: { subject, outcome: 'false', kind: 'loop' } }, ...breaks];
    }

    if (ts.isDoStatement(statement)) {
      // The body runs first; the condition at the bottom loops back to the body's first node.
      const first = nodes.length;
      const jump: Jump = { label, isLoop: true, breaks: [] };
      jumps.push(jump);
      const bodyEnd = stmt(statement.statement, pending);
      const condition = text(statement.expression);
      const test = enter(bodyEnd, 'loop', [`do … while (${condition})`], [statement.expression]);
      jumps.pop();
      for (const edge of edges) {
        // continue inside a do…while goes to the condition.
        if (edge.to === -1) edge.to = test;
      }
      jump.continueTo = test;
      edges.push({ from: test, to: first < test ? first : test, kind: 'back', label: 'yes', choice: { subject: condition, outcome: 'true', kind: 'loop' } });
      return [{ from: test, kind: 'false', label: 'no', choice: { subject: condition, outcome: 'false', kind: 'loop' } }, ...jump.breaks];
    }

    if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
      const target = statement.label?.text;
      const isBreak = ts.isBreakStatement(statement);
      const jump = [...jumps].reverse().find((j) => (target ? j.label === target : isBreak || j.isLoop));
      if (!jump) return pending;
      if (isBreak) {
        jump.breaks.push(...pending.map((p) => ({ ...p })));
      } else {
        for (const p of pending) edges.push({ from: p.from, to: jump.continueTo ?? -1, kind: 'continue', label: p.label ?? 'continue', choice: p.choice });
      }
      return [];
    }

    if (ts.isReturnStatement(statement)) {
      const id = enter(pending, 'return', [statement.expression ? `return ${text(statement.expression)}` : 'return'], [statement]);
      edges.push({ from: id, to: end, kind: 'return' });
      return [];
    }

    if (ts.isThrowStatement(statement)) {
      const id = enter(pending, 'throw', [`throw ${statement.expression ? text(statement.expression) : ''}`.trim()], [statement]);
      const handler = catches[catches.length - 1];
      if (handler) handler.throws.push({ from: id, kind: 'throw', label: 'throws' });
      else edges.push({ from: id, to: end, kind: 'throw', label: 'throws' });
      return [];
    }

    if (ts.isTryStatement(statement)) {
      const handler = { throws: [] as Pending[] };
      const tryFirst = nodes.length;
      if (statement.catchClause) catches.push(handler);
      const afterTry = list(statement.tryBlock.statements, pending);
      if (statement.catchClause) catches.pop();
      let afterCatch: Pending[] = [];
      if (statement.catchClause) {
        // Anything in the try block may throw: the catch is reachable from its first node even without a throw statement.
        const fromTry: Pending[] = handler.throws.length ? handler.throws : tryFirst < nodes.length ? [{ from: tryFirst, kind: 'throw', label: 'throws' }] : [];
        const declaration = statement.catchClause.variableDeclaration;
        const catchId = enter(fromTry, 'catch', [declaration ? `catch (${text(declaration)})` : 'catch'], [statement.catchClause]);
        afterCatch = list(statement.catchClause.block.statements, [{ from: catchId, kind: 'next' }]);
      }
      if (statement.finallyBlock) {
        const finallyId = enter([...afterTry, ...afterCatch], 'finally', ['finally'], [statement.finallyBlock]);
        return list(statement.finallyBlock.statements, [{ from: finallyId, kind: 'next' }]);
      }
      return [...afterTry, ...afterCatch];
    }

    // Anything else (with, nested declarations…) is one plain step.
    const id = enter(pending, 'statement', [text(statement)], [statement]);
    return [{ from: id, kind: 'next' }];
  }

  let out: Pending[];
  const body = fn.body;
  if (!body) {
    out = [{ from: start, kind: 'next' }];
  } else if (ts.isBlock(body)) {
    out = list(body.statements, [{ from: start, kind: 'next' }]);
  } else {
    // An arrow function's expression body is its return value.
    const id = enter([{ from: start, kind: 'next' }], 'return', [`return ${text(body)}`], [body]);
    edges.push({ from: id, to: end, kind: 'return' });
    out = [];
  }
  // Falling off the end of the body.
  connect(out, end);
  // Code nothing leads to from the start: after a return, throw, break or continue.
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.from === id && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const node of nodes) {
    if (!reached.has(node.id) && node.id !== end) node.unreachable = true;
  }
  return { name: functionLabel(fn), fn, nodes, edges, start, end };
}
