import ts = require('typescript');
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { enclosingFunction, functionAtOffset, identifierAt, isThenable, symbolAt } from '../structure/util';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';

/**
 * Two timelines, read from the code in source order:
 * - Value timeline: every change to a variable, in phases (before a loop, on every pass of it, after it), with the
 *   conditions each change waits for, what one pass hands to the next, and how a counter steps from pass to pass.
 * - Async timeline: what an async function starts and what it waits for, in order: awaits, calls started together,
 *   awaits inside loops (one after another), promises started early, and promises nobody waits for.
 */

const short = (text: string, max = 70) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isLoop = (n: ts.Node): n is ts.IterationStatement => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
const isFunction = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

/** How a loop starts, as written: "for (const item of items)", "while (n > 0)". */
function loopHeader(loop: ts.IterationStatement, sf: ts.SourceFile): string {
  const text = loop.getText(sf);
  if (ts.isDoStatement(loop)) return `do … while (${short(loop.expression.getText(sf), 40)})`;
  const close = text.indexOf(')', text.indexOf('('));
  return short(text.slice(0, close + 1), 60);
}

/** The loops and conditions between `node` and `scope`, outermost first, and whether a callback is in between. */
function context(node: ts.Node, scope: ts.Node, sf: ts.SourceFile): { loops: ts.IterationStatement[]; conditions: string[]; callback: boolean } {
  const loops: ts.IterationStatement[] = [];
  const conditions: string[] = [];
  let callback = false;
  for (let child: ts.Node = node, parent = node.parent; parent && child !== scope; child = parent, parent = parent.parent) {
    if (parent === scope) break;
    if (isLoop(parent) && child !== (parent as ts.ForStatement).initializer) loops.unshift(parent);
    else if (ts.isIfStatement(parent) && child !== parent.expression) conditions.unshift(child === parent.thenStatement ? short(parent.expression.getText(sf), 50) : `not ${short(parent.expression.getText(sf), 46)}`);
    else if (ts.isConditionalExpression(parent) && child !== parent.condition) conditions.unshift(child === parent.whenTrue ? short(parent.condition.getText(sf), 50) : `not ${short(parent.condition.getText(sf), 46)}`);
    else if (ts.isCaseClause(parent)) conditions.unshift(`case ${short(parent.expression.getText(sf), 40)}`);
    else if (ts.isBinaryExpression(parent) && child === parent.right && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      conditions.unshift(parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? short(parent.left.getText(sf), 50) : `not ${short(parent.left.getText(sf), 46)}`);
    } else if (isFunction(parent)) callback = true;
  }
  return { loops, conditions, callback };
}

const lineOf = (node: ts.Node, sf: ts.SourceFile) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const statementOf = (node: ts.Node): ts.Node => {
  let n = node;
  while (n.parent && !ts.isBlock(n.parent) && !ts.isSourceFile(n.parent) && !ts.isCaseClause(n.parent) && !isFunction(n.parent)) n = n.parent;
  return n;
};

// ---------- Value timeline ----------

type ValueEventKind = 'start' | 'set' | 'change' | 'read';
interface ValueEvent {
  kind: ValueEventKind;
  label: string;
  node: ts.Node;
  /** For counters: the step one change makes, such as +1 or -2. */
  step?: number;
  loops: ts.IterationStatement[];
  conditions: string[];
  callback: boolean;
}

const mutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'set', 'delete', 'add', 'clear', 'copyWithin']);

export function valueTimelineReport(project: VirtualProject, fileName: string, offset: number): Report {
  const sf = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const identifier = identifierAt(sf, offset, 'Place the cursor on a variable or parameter.');
  const symbol = symbolAt(checker, identifier);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) || !ts.isIdentifier(declaration.name)) {
    throw new AnalysisError(`'${identifier.getText(sf)}' isn't a variable or parameter: Value timeline follows one name through a function.`);
  }
  if (declaration.getSourceFile() !== sf) throw new AnalysisError(`'${identifier.getText(sf)}' is declared in another file: open that file to follow it.`);
  const name = declaration.name.text;
  const scope: ts.Node = (ts.isParameter(declaration) ? declaration.parent : enclosingFunction(declaration)) ?? sf;
  const body: ts.Node = ts.isParameter(declaration) || !ts.isSourceFile(scope) ? ((scope as ts.FunctionLikeDeclaration).body ?? scope) : sf;
  const builder = new ReportBuilder('valueTimeline', `Value timeline of ${name}`);

  const events: ValueEvent[] = [];
  const add = (kind: ValueEventKind, label: string, node: ts.Node, step?: number) => events.push({ kind, label, node, step, ...context(node, body, sf) });
  // How it starts.
  if (ts.isParameter(declaration)) add('start', declaration.initializer ? `comes in as an argument, or ${short(declaration.initializer.getText(sf), 40)} when none is passed` : 'comes in as an argument', declaration);
  else add('start', declaration.initializer ? `starts as ${short(declaration.initializer.getText(sf), 60)}` : 'starts undefined', declaration);
  // A read on the right of its own assignment (total = total * 0.9) is shown by that change.
  const insideOwnChange = (node: ts.Node) => {
    for (let n = node.parent; n && n !== body; n = n.parent) {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left) && symbolAt(checker, n.left) === symbol) return true;
      if (ts.isStatement(n)) return false;
    }
    return false;
  };
  // A read in the condition of a loop or an if, not in its body: the header, such as "while (n > 0)".
  const headerHolding = (node: ts.Node) => {
    for (let child: ts.Node = node, n = node.parent; n && n !== body; child = n, n = n.parent) {
      if (isLoop(n)) return (ts.isForStatement(n) && child === n.statement) || ((ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && child === n.statement) ? undefined : loopHeader(n, sf);
      if (ts.isIfStatement(n)) return child === n.expression ? `if (${short(n.expression.getText(sf), 50)})` : undefined;
      if (ts.isStatement(n) || ts.isBlock(n)) return undefined;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === name && symbolAt(checker, node) === symbol) {
      const parent = node.parent;
      if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const op = parent.operatorToken.getText(sf);
        const right = parent.right.getText(sf);
        const literal = /^\d+(\.\d+)?$/.test(right) ? Number(right) : undefined;
        if (op === '=') add('set', `= ${short(right, 60)}`, parent);
        else add('change', `${op} ${short(right, 50)}`, parent, op === '+=' && literal !== undefined ? literal : op === '-=' && literal !== undefined ? -literal : undefined);
      } else if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
        add('change', parent.getText(sf), parent, parent.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1);
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && mutators.has(parent.name.text) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        add('change', short(parent.parent.getText(sf), 60), parent.parent);
      } else if (!insideOwnChange(node)) {
        const statement = statementOf(node);
        const header = headerHolding(node);
        add('read', header ? `checked in ${header}` : ts.isReturnStatement(statement) ? `returned: ${short(statement.getText(sf).replace(/^return\s*/, '').replace(/;$/, ''), 50)}` : `read in ${short(statement.getText(sf), 56)}`, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  events.sort((a, b) => a.node.getStart(sf) - b.node.getStart(sf));

  // Phases: runs of events in the same loop, in order.
  const loopKey = (e: ValueEvent) => e.loops.map((l) => l.pos).join('/');
  const phases: { loops: ts.IterationStatement[]; events: ValueEvent[] }[] = [];
  for (const e of events) {
    const last = phases[phases.length - 1];
    if (last && loopKey(last.events[0]) === loopKey(e)) last.events.push(e);
    else phases.push({ loops: e.loops, events: [e] });
  }
  const start = events.find((e) => e.kind === 'start');
  const startValue = start && /^starts as /.test(start.label) ? start.label.replace(/^starts as /, '') : ts.isParameter(declaration) ? `the argument` : 'undefined';
  let seenLoop = false;
  const icon: Record<ValueEventKind, string> = { start: 'debug-start', set: 'edit', change: 'diff-modified', read: 'eye' };
  const roots: ReportNode[] = phases.map((phase, i) => {
    const inLoop = phase.loops.length > 0;
    const header = inLoop ? loopHeader(phase.loops[phase.loops.length - 1], sf) : '';
    const label = inLoop ? `Every pass of ${header}` : i === 0 ? 'At the start' : seenLoop ? 'After the loop' : 'Then';
    if (inLoop) seenLoop = true;
    const rows: ReportNode[] = phase.events.map((e) => ({
      label: e.label,
      description: [`line ${lineOf(e.node, sf)}`, e.conditions.length ? `when ${e.conditions.join(' and ')}` : '', e.callback ? 'inside a callback: runs later' : ''].filter(Boolean).join(' · '),
      icon: icon[e.kind],
      tone: e.callback && e.kind !== 'read' ? ('info' as const) : undefined,
      location: builder.at(e.node),
    }));
    if (inLoop) {
      const writes = phase.events.filter((e) => e.kind === 'set' || e.kind === 'change');
      const reads = phase.events.some((e) => e.kind === 'read' || e.kind === 'change');
      const counter = writes.length === 1 && writes[0].step !== undefined && !writes[0].conditions.length ? writes[0].step : undefined;
      let note: string | undefined;
      if (counter !== undefined) {
        const term = (k: number) => (k === 0 ? startValue : `${startValue} ${counter * k < 0 ? '−' : '+'} ${Math.abs(counter * k)}`);
        note = `Pass by pass: ${term(0)}, then ${term(1)}, ${term(2)}, … one step of ${counter > 0 ? '+' : ''}${counter} each pass`;
      } else if (writes.length && reads) {
        note = `Each pass starts with what the pass before left; the first pass starts with ${short(startValue, 40)}`;
      } else if (writes.length) {
        note = 'Each pass replaces it: after the loop it holds what the last pass set';
      } else {
        note = 'Only read in the loop: the same value on every pass';
      }
      rows.unshift({ label: note, icon: 'sync', tone: 'info' });
    }
    return { label, description: plural(phase.events.filter((e) => e.kind !== 'read').length, 'change'), icon: inLoop ? 'sync' : i === 0 ? 'debug-start' : 'arrow-down', expanded: true, children: rows };
  });
  const changes = events.filter((e) => e.kind === 'set' || e.kind === 'change').length;
  if (!changes) roots.push({ label: `${name} never changes after it starts`, description: ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Let ? 'it could be const' : 'every read sees the same value', icon: 'pass', tone: 'ok' });
  const loopsCount = new Set(events.flatMap((e) => e.loops.map((l) => l.pos))).size;
  return builder.finish(roots, `${plural(changes, 'change')}${loopsCount ? ` in and around ${plural(loopsCount, 'loop')}` : ''}, ${plural(events.filter((e) => e.kind === 'read').length, 'read')}`);
}

// ---------- Async timeline ----------

type AsyncKind = 'wait' | 'together' | 'loopWait' | 'started' | 'notAwaited' | 'void' | 'returned' | 'chained';
interface AsyncEvent {
  kind: AsyncKind;
  label: string;
  note?: string;
  node: ts.Node;
  callback: boolean;
  /** The variable a started promise or an awaited value is kept in. */
  name?: string;
}

const together = new Set(['all', 'allSettled', 'race', 'any']);
const isPromiseCombinator = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText() === 'Promise' && together.has(e.expression.name.text);

export function asyncTimelineReport(project: VirtualProject, fileName: string, offset: number): Report {
  const sf = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const fn = functionAtOffset(sf, offset, checker);
  const fnName = (fn.name && ts.isIdentifier(fn.name) ? fn.name.text : undefined) ?? (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : 'this function');
  const builder = new ReportBuilder('asyncTimeline', `Async timeline of ${fnName}`);
  const body = fn.body!;
  const events: AsyncEvent[] = [];
  const thenable = (node: ts.Expression) => {
    try {
      return isThenable(checker, checker.getTypeAtLocation(node));
    } catch {
      return false;
    }
  };
  const inLoop = (node: ts.Node) => {
    for (let n = node.parent; n && n !== body; n = n.parent) {
      if (isFunction(n)) return false;
      if (isLoop(n)) return true;
    }
    return false;
  };
  const viaCallback = (node: ts.Node) => context(node, body, sf).callback;
  const keptIn = (node: ts.Node) => {
    let n = node.parent;
    while (n && (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isAsExpression(n))) n = n.parent;
    return n && ts.isVariableDeclaration(n) ? n.name.getText(sf) : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const operand = node.expression;
      const callback = viaCallback(node);
      if (isPromiseCombinator(operand) && ts.isCallExpression(operand)) {
        const items = operand.arguments[0] && ts.isArrayLiteralExpression(operand.arguments[0]) ? operand.arguments[0].elements.map((e) => short(e.getText(sf), 30)) : [short(operand.arguments.map((a) => a.getText(sf)).join(', '), 50)];
        const how = (operand.expression as ts.PropertyAccessExpression).name.text;
        events.push({ kind: 'together', label: `waits for ${plural(items.length, 'call')} at once: ${items.join(', ')}`, note: `Promise.${how}`, node, callback, name: keptIn(node) });
        // The calls inside are part of this step.
        return;
      }
      events.push({ kind: inLoop(node) ? 'loopWait' : 'wait', label: `waits for ${short(operand.getText(sf), 60)}`, node, callback, name: keptIn(node) });
    } else if (ts.isCallExpression(node) && !isPromiseCombinator(node) && thenable(node)) {
      let parent: ts.Node = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      const callback = viaCallback(node);
      const text = short(node.getText(sf), 60);
      if (ts.isExpressionStatement(parent)) events.push({ kind: 'notAwaited', label: `starts ${text} and never waits for it`, note: 'errors from it are lost', node, callback });
      else if (ts.isVoidExpression(parent)) events.push({ kind: 'void', label: `starts ${text} without waiting, on purpose (void)`, node, callback });
      else if (ts.isVariableDeclaration(parent) && parent.initializer === node) events.push({ kind: 'started', label: `starts ${text} and keeps it in ${parent.name.getText(sf)}`, note: 'it runs while the code below goes on', node, callback, name: parent.name.getText(sf) });
      else if (ts.isReturnStatement(parent)) events.push({ kind: 'returned', label: `hands ${text} to the caller to wait for`, node, callback });
      else if (ts.isPropertyAccessExpression(parent) && /^(then|catch|finally)$/.test(parent.name.text)) events.push({ kind: 'chained', label: `starts ${text} and continues with .${parent.name.text}()`, node, callback });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  events.sort((a, b) => a.node.getStart(sf) - b.node.getStart(sf));

  // A promise started early and waited for later: say where.
  for (const e of events) {
    if (e.kind !== 'started' || !e.name) continue;
    const waited = events.find((w) => (w.kind === 'wait' || w.kind === 'loopWait') && w.node.getStart(sf) > e.node.getStart(sf) && new RegExp(`\\b${e.name}\\b`).test((w.node as ts.AwaitExpression).expression.getText(sf)));
    e.note = waited ? `runs in the background until line ${lineOf(waited.node, sf)} waits for it` : 'nothing waits for it here';
  }
  // Two waits in a row where the second doesn't use the first's result could run together.
  const waits = events.filter((e) => e.kind === 'wait' && !e.callback);
  for (let i = 1; i < waits.length; i++) {
    const before = waits[i - 1];
    const now = waits[i];
    const operand = (now.node as ts.AwaitExpression).expression.getText(sf);
    if (before.name && !new RegExp(`\\b${before.name.replace(/[[\]{}\s]/g, '').split(',').filter(Boolean).join('\\b|\\b')}\\b`).test(operand) && now.name) {
      now.note = `doesn't use ${before.name} from line ${lineOf(before.node, sf)}: the two could run together with Promise.all`;
    }
  }

  const icons: Record<AsyncKind, string> = { wait: 'watch', together: 'layers', loopWait: 'sync', started: 'debug-start', notAwaited: 'warning', void: 'debug-step-over', returned: 'reply', chained: 'link' };
  const steps: ReportNode[] = events.map((e, i) => ({
    label: `${i + 1}. ${e.label}`,
    description: [`line ${lineOf(e.node, sf)}`, e.kind === 'loopWait' ? 'on every pass, one after another' : '', e.note ?? '', e.callback ? 'inside a callback: runs later, on its own' : ''].filter(Boolean).join(' · '),
    icon: icons[e.kind],
    tone: e.kind === 'notAwaited' ? 'warning' : e.kind === 'loopWait' ? 'warning' : e.kind === 'together' ? 'ok' : undefined,
    location: builder.at(e.node),
  }));
  const count = (k: AsyncKind) => events.filter((e) => e.kind === k).length;
  const roots: ReportNode[] = [];
  if (!events.length) {
    roots.push({ label: `${fnName} neither waits for nor starts anything async`, description: 'no await, and no call that returns a promise', icon: 'pass', tone: 'ok' });
  } else {
    roots.push({ label: 'In order', description: `${plural(events.length, 'step')}, as the code runs them`, icon: 'list-ordered', expanded: true, children: steps });
    const tips: ReportNode[] = [];
    if (count('loopWait')) tips.push({ label: 'Waits in a loop run one after another. When the passes don\'t depend on each other, start them all and wait once: await Promise.all(items.map((item) => save(item))).', icon: 'lightbulb' });
    if (count('notAwaited')) tips.push({ label: 'A promise nobody waits for loses its errors. Await it, end it with .catch(report), or mark it with void when that is on purpose.', icon: 'lightbulb' });
    if (waits.some((w) => w.note)) tips.push({ label: 'Waits that don\'t depend on each other can start together: const [a, b] = await Promise.all([first(), second()]).', icon: 'lightbulb' });
    if (tips.length) roots.push({ label: 'How to make it faster and safer', icon: 'lightbulb', expanded: true, children: tips });
  }
  const parts = [
    plural(count('wait') + count('loopWait') + count('together'), 'wait'),
    count('together') ? `${count('together')} started together` : '',
    count('loopWait') ? `${plural(count('loopWait'), 'wait')} in loops` : '',
    count('notAwaited') ? `${count('notAwaited')} not awaited` : '',
  ].filter(Boolean);
  return builder.finish(roots, parts.join(', '));
}
