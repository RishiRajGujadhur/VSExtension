import ts = require('typescript');
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, Tone, nodeSnippet, plural, withPlace } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import {
  FunctionWithBody,
  callSitesOf,
  calledFunction,
  enclosingFunction,
  forEachInFunction,
  functionAtOffset,
  functionLabel,
  isThenable,
  nodeText,
  referencesAt,
  skipOuterExpressions,
} from '../structure/util';
import { calleeName, isAsync } from './missingAwait';
import { findIdentifier } from '../analysis/impact';

export type CatchBehavior = 'swallows' | 'logs' | 'rethrows' | 'transforms' | 'recovers' | 'handles';

/** What a catch block does with the error it receives. */
export function classifyCatch(clause: ts.CatchClause): { behavior: CatchBehavior; detail: string } {
  const statements = clause.block.statements;
  const name = clause.variableDeclaration && ts.isIdentifier(clause.variableDeclaration.name) ? clause.variableDeclaration.name.text : undefined;
  let rethrow: ts.ThrowStatement | undefined;
  let transform: ts.ThrowStatement | undefined;
  let returns = false;
  let onlyLogging = true;
  forEachInFunction(clause.block, (node) => {
    if (ts.isThrowStatement(node)) {
      const thrown = node.expression && skipOuterExpressions(node.expression);
      if (thrown && ts.isIdentifier(thrown) && thrown.text === name) {
        rethrow ??= node;
      } else {
        transform ??= node;
      }
    }
    if (ts.isReturnStatement(node)) {
      returns = true;
    }
  });
  for (const statement of statements) {
    const expression = ts.isExpressionStatement(statement) ? skipOuterExpressions(statement.expression) : undefined;
    const logging = expression && ts.isCallExpression(expression) && /^console\.|^(logger|log)\b/.test(expression.expression.getText());
    if (!logging) {
      onlyLogging = false;
    }
  }
  if (rethrow) {
    return { behavior: 'rethrows', detail: `rethrows ${name}` };
  }
  if (transform) {
    return { behavior: 'transforms', detail: `throws ${nodeText(transform.expression ?? transform)} instead` };
  }
  if (statements.length === 0) {
    return { behavior: 'swallows', detail: 'empty catch block swallows the error' };
  }
  if (onlyLogging) {
    return { behavior: 'logs', detail: 'logs the error and continues' };
  }
  if (returns) {
    return { behavior: 'recovers', detail: 'recovers by returning a value' };
  }
  return { behavior: 'handles', detail: 'handles the error' };
}

/** The catch clause that receives errors thrown at the node, within the same function. */
export function enclosingCatch(node: ts.Node): ts.CatchClause | undefined {
  let current = node;
  for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) {
      return parent.catchClause;
    }
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) {
      return undefined;
    }
  }
  return undefined;
}

const maxDepth = 6;

/** Promise Rejection Analyzer: where a function's rejections come from and where each one ends up. */
export class RejectionTracer {
  private readonly checker: ts.TypeChecker;
  private readonly active = new Set<ts.Node>();

  constructor(
    private readonly project: VirtualProject,
    private readonly builder: ReportBuilder,
  ) {
    this.checker = project.program().getTypeChecker();
  }

  /** Throws, awaits and explicit rejections inside the function that are not caught there. */
  sources(fn: FunctionWithBody): ReportNode[] {
    const nodes: ReportNode[] = [];
    forEachInFunction(fn.body!, (node) => {
      if (enclosingCatch(node)) {
        return;
      }
      if (ts.isThrowStatement(node) && isAsync(fn)) {
        nodes.push(this.row(`throws ${nodeText(node.expression ?? node)}`, node, 'error', 'zap'));
      } else if (ts.isAwaitExpression(node)) {
        const operand = skipOuterExpressions(node.expression);
        const callee = ts.isCallExpression(operand) ? calledFunction(this.checker, operand) : undefined;
        nodes.push(this.row(`awaits ${nodeText(operand)}`, node, 'warning', 'debug-step-into', callee ? `rejects if ${functionLabel(callee)} rejects` : 'rejects if it rejects'));
      } else if (ts.isCallExpression(node) && /^Promise\.reject$/.test(node.expression.getText())) {
        nodes.push(this.row('Promise.reject(…)', node, 'error', 'zap'));
      } else if (ts.isNewExpression(node) && node.expression.getText() === 'Promise') {
        const executor = node.arguments?.[0];
        const reject = executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) ? executor.parameters[1] : undefined;
        if (reject) {
          nodes.push(this.row(`new Promise rejects through ${reject.name.getText()}()`, reject, 'error', 'zap'));
        }
      }
    });
    return nodes;
  }

  /** Follows the promise produced at `expression` until something handles it or nothing can. */
  follow(expression: ts.Node, depth: number): ReportNode {
    let current = expression;
    for (;;) {
      let parent = current.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) {
        current = parent;
        parent = parent.parent;
      }
      if (ts.isAwaitExpression(parent)) {
        const clause = enclosingCatch(parent);
        if (clause) {
          return this.caught(clause, parent);
        }
        const fn = enclosingFunction(parent);
        return fn ? this.propagate(fn, `awaited in ${functionLabel(fn)}`, parent, depth) : this.row('top-level await: an unhandled rejection fails the module', parent, 'error', 'error');
      }
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) {
        const fn = ts.isArrowFunction(parent) ? parent : enclosingFunction(parent);
        return fn ? this.propagate(fn, `returned from ${functionLabel(fn)}`, parent, depth) : this.row('returned at module level', parent, 'warning', 'question');
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === current && ts.isCallExpression(parent.parent)) {
        const call = parent.parent;
        const method = parent.name.text;
        if (method === 'catch' || (method === 'then' && call.arguments.length >= 2)) {
          return this.row(`handled by .${method}(${call.arguments.length >= 2 ? '…, onRejected' : '…'})`, call, 'ok', 'pass');
        }
        if (method === 'then' || method === 'finally') {
          current = call;
          continue;
        }
      }
      if ((ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) || (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent))) {
        const call = (ts.isArrayLiteralExpression(parent) ? parent.parent : parent) as ts.CallExpression;
        const name = call.expression.getText();
        if (name === 'Promise.allSettled') {
          return this.row('collected by Promise.allSettled, which never rejects', call, 'ok', 'pass');
        }
        if (/^Promise\.(all|race|any)$/.test(name)) {
          current = call;
          continue;
        }
        const callee = calledFunction(this.checker, call);
        return this.row(`passed to ${calleeName(call)}()`, call, 'warning', 'question', callee ? 'handled only if it awaits the argument' : 'outside the project; cannot follow');
      }
      if (ts.isExpressionStatement(parent)) {
        return { ...this.row('not awaited: the rejection is unhandled', parent, 'error', 'error', nodeSnippet(parent, 40)), action: { kind: 'quickFix' } };
      }
      if (ts.isVoidExpression(parent)) {
        return { ...this.row('discarded with void: the rejection is unhandled', parent, 'error', 'error'), action: { kind: 'quickFix' } };
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
        const uses = referencesAt(this.project.service, parent.getSourceFile().fileName, parent.name.getStart()).filter((r) => r !== parent.name);
        if (uses.length === 0) {
          return this.row(`stored in ${parent.name.text} and never used`, parent, 'error', 'error');
        }
        return this.group(`stored in ${parent.name.text}`, parent, uses.map((u) => this.follow(u, depth)), 'symbol-variable');
      }
      if (ts.isJsxExpression(parent)) {
        return this.row('used in JSX', parent, 'warning', 'question');
      }
      return this.row(`used in ${nodeSnippet(parent, 40)}`, parent, 'warning', 'question', 'cannot follow');
    }
  }

  /** Rejections that leave a function go to whatever its callers do with the returned promise. */
  propagate(fn: FunctionWithBody, label: string, at: ts.Node, depth: number): ReportNode {
    if (!isAsync(fn) && !returnsThenable(this.checker, fn)) {
      return this.row(`${label}, which is not async`, at, 'warning', 'question');
    }
    if (depth >= maxDepth) {
      return this.row(`${label} (stopped: call chain too deep)`, at, 'warning', 'ellipsis');
    }
    if (this.active.has(fn)) {
      return this.row(`${label} (recursive)`, at, 'warning', 'sync');
    }
    // Callbacks: what the receiving API does with the returned promise.
    const callbackOf = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? skipToCall(fn) : undefined;
    if (callbackOf) {
      return this.callbackHandling(fn, callbackOf, label, at, depth);
    }
    if (ts.isJsxExpression(fn.parent)) {
      return this.row(`${label}, used as a JSX event handler: React ignores returned promises`, fn, 'error', 'error');
    }
    this.active.add(fn);
    const { calls, escapes } = callSitesOf(this.project.service, fn);
    const children = [
      ...calls.map(({ call }) => (ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call) ? this.row('rendered as a JSX component', call, 'warning', 'question') : this.follow(call, depth + 1))),
      ...escapes.map((e) => this.row(`passed around as a value: ${nodeSnippet(e.parent, 40)}`, e, 'warning', 'question')),
    ];
    this.active.delete(fn);
    if (children.length === 0) {
      return this.row(`${label}, which has no callers in the project`, at, 'warning', 'question', 'an entry point: its caller must handle the rejection');
    }
    return this.group(label, at, children, 'call-incoming');
  }

  private callbackHandling(fn: FunctionWithBody, call: ts.CallExpression | ts.NewExpression, label: string, at: ts.Node, depth: number): ReportNode {
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText();
    if (ts.isPropertyAccessExpression(call.expression) && ['then', 'catch', 'finally'].includes(callee)) {
      return this.group(`${label}, a .${callee}() callback`, at, [this.follow(call, depth + 1)], 'debug-step-out');
    }
    if (ts.isPropertyAccessExpression(call.expression) && ['map', 'flatMap'].includes(callee)) {
      return this.group(`${label}, a .${callee}() callback producing an array of promises`, at, [this.follow(call, depth + 1)], 'debug-step-out');
    }
    const target = calledFunction(this.checker, call);
    if (!target) {
      return this.row(`${label}, a callback passed to ${calleeName(call)}(), which ignores returned promises`, fn, 'error', 'error');
    }
    return this.row(`${label}, a callback passed to ${functionLabel(target)}()`, fn, 'warning', 'question', 'handled only if it awaits the callback');
  }

  private caught(clause: ts.CatchClause, at: ts.Node): ReportNode {
    const { behavior, detail } = classifyCatch(clause);
    const tone: Tone = behavior === 'swallows' || behavior === 'logs' ? 'warning' : behavior === 'rethrows' || behavior === 'transforms' ? 'info' : 'ok';
    return {
      label: `caught in ${functionLabel(enclosingFunction(clause))}`,
      description: detail,
      icon: behavior === 'swallows' ? 'mute' : 'shield',
      tone,
      location: this.builder.at(at),
      children: [{ label: `catch block: ${detail}`, icon: 'symbol-event', tone, location: this.builder.at(clause) }],
    };
  }

  row(label: string, node: ts.Node, tone: Tone, icon: string, description?: string): ReportNode {
    return { label, description: withPlace(node, description), tone, icon, location: this.builder.at(node) };
  }

  private group(label: string, node: ts.Node, children: ReportNode[], icon: string): ReportNode {
    const tone = worst(children);
    // Branches that end handled stay collapsed, so the paths that need attention stand out.
    return { label, icon, tone, location: this.builder.at(node), children, expanded: tone === 'error' || tone === 'warning' };
  }
}

function skipToCall(fn: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let current = fn;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(current as ts.Expression) ? parent : undefined;
}

const toneRank: Record<Tone, number> = { error: 3, warning: 2, info: 1, ok: 0 };

export function worst(nodes: readonly ReportNode[]): Tone {
  return nodes.reduce<Tone>((w, n) => (toneRank[n.tone ?? 'ok'] > toneRank[w] ? (n.tone as Tone) : w), 'ok');
}

function leaves(node: ReportNode): ReportNode[] {
  return node.children?.length ? node.children.flatMap(leaves) : [node];
}

/** Every unhandled end of the tree, flattened, with the steps that lead to it, so deep paths are not missed. */
export function unhandledPaths(root: ReportNode): ReportNode[] {
  const result: ReportNode[] = [];
  const visit = (node: ReportNode, trail: string[]) => {
    if (!node.children?.length) {
      if (node.tone === 'error') {
        result.push({ ...node, description: trail.length ? `via ${trail.join(' → ')}` : node.description });
      }
      return;
    }
    for (const child of node.children) {
      visit(child, node === root ? trail : [...trail, node.label.replace(/^((awaited|returned) (in|from)|propagates (through|into async)) /, '').replace(/,.*$/, '')]);
    }
  };
  visit(root, []);
  return result;
}

export function rejectionReport(project: VirtualProject, fileName: string, offset: number): Report {
  const program = project.program();
  const fn = functionAtOffset(project.sourceFile(fileName), offset, program.getTypeChecker());
  const builder = new ReportBuilder('rejections', `Rejections of ${functionLabel(fn)}`);
  const tracer = new RejectionTracer(project, builder);
  if (!isAsync(fn) && !returnsThenable(program.getTypeChecker(), fn)) {
    builder.warnings.push(`${functionLabel(fn)} is not async and does not return a promise.`);
  }
  const awaited: ts.Node[] = [];
  const chains: ts.CallExpression[] = [];
  forEachInFunction(fn.body ?? fn, (n) => {
    if (ts.isAwaitExpression(n)) awaited.push(n);
    // x.then(…) whose chain never reaches .catch and isn't awaited or returned: a rejection goes nowhere.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then') {
      let top: ts.Node = n;
      const names = ['then'];
      while (ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent)) {
        names.push(top.parent.name.text);
        top = top.parent.parent;
      }
      const handled = names.includes('catch') || n.arguments.length > 1;
      const passedOn = ts.isAwaitExpression(top.parent) || ts.isReturnStatement(top.parent) || (ts.isArrowFunction(top.parent) && top.parent.body === top);
      if (!handled && !passedOn) chains.push(n);
    }
  });
  if (isAsync(fn) && awaited.length === 0) builder.warnings.push(`${functionLabel(fn)} is async but never awaits: it could return a value, and any error it throws becomes a rejection.`);
  const sources = tracer.sources(fn);
  const destination = tracer.propagate(fn, `${functionLabel(fn)} rejects`, (fn as ts.FunctionDeclaration).name ?? fn, 0);
  const results = leaves(destination);
  const count = (tone: Tone) => results.filter((r) => r.tone === tone).length;
  const roots: ReportNode[] = [
    { label: 'Rejection sources', description: plural(sources.length, 'source'), icon: 'zap', expanded: true, children: sources.length ? sources : [{ label: 'no throws or awaits outside try/catch', icon: 'pass', tone: 'ok' }] },
    { ...destination, label: 'Where rejections go', description: `${count('ok') + count('info')} handled, ${count('error')} unhandled, ${count('warning')} swallowed or unknown` },
  ];
  if (chains.length) {
    roots.push({
      label: 'Promise chains without .catch',
      description: plural(chains.length, 'chain'),
      icon: 'warning',
      tone: 'warning',
      expanded: true,
      children: chains.map((c) => ({ label: nodeSnippet(c, 50), description: 'not awaited, returned or caught', icon: 'warning', tone: 'warning' as const, location: builder.at(c) })),
    });
  }
  const unhandled = unhandledPaths(destination);
  if (unhandled.length > 0) {
    roots.unshift({ label: 'Unhandled', description: plural(unhandled.length, 'path'), icon: 'error', tone: 'error', expanded: true, children: unhandled });
  }
  // On a call, where that call's promise goes comes first.
  const call = callAt(project.sourceFile(fileName), offset);
  if (call && calledFunction(program.getTypeChecker(), call) === fn) {
    const here = tracer.follow(call, 0);
    roots.unshift({ label: `This call: ${nodeSnippet(call, 40)}`, icon: 'debug-step-into', tone: worst([here]), location: builder.at(call), focus: true, expanded: true, children: [here] });
  }
  if (count('error') > 0) {
    roots.push(
      howToFix([
        'await the call inside try { … } catch (e) { … } where the error can be shown or recovered from.',
        'When the call is not awaited on purpose (fire and forget), end it with .catch((e) => report(e)).',
        'In event handlers and useEffect, wrap the async work so the handler itself catches: onClick={() => void save().catch(showError)}.',
      ]),
    );
  }
  return builder.finish(roots, plural(count('error'), 'unhandled path'));
}

/** The call whose callee name is at the offset, such as `save(…)` or `this.store.save(…)`. */
function callAt(sourceFile: ts.SourceFile, offset: number): ts.CallExpression | undefined {
  const identifier = findIdentifier(sourceFile, offset);
  let callee: ts.Node | undefined = identifier;
  if (callee && ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee) {
    callee = callee.parent;
  }
  const parent = callee?.parent;
  return parent && ts.isCallExpression(parent) && parent.expression === callee ? parent : undefined;
}

function returnsThenable(checker: ts.TypeChecker, fn: FunctionWithBody): boolean {
  const signature = checker.getSignatureFromDeclaration(fn);
  return !!signature && isThenable(checker, signature.getReturnType());
}
