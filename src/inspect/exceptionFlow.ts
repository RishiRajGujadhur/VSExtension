import * as ts from 'typescript';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, Tone, nodeSnippet, plural } from '../structure/report';
import { FunctionWithBody, callSitesOf, calledFunction, enclosingFunction, forEachInFunction, functionAtOffset, functionLabel, nodeText } from '../structure/util';
import { isAsync } from './missingAwait';
import { RejectionTracer, classifyCatch, enclosingCatch, worst } from './rejections';

/** Library calls that throw on bad input. */
const throwingCalls: Record<string, string> = {
  'JSON.parse': 'SyntaxError on invalid JSON',
  decodeURIComponent: 'URIError on malformed input',
  decodeURI: 'URIError on malformed input',
  encodeURIComponent: 'URIError on lone surrogates',
  atob: 'DOMException on invalid base64',
  structuredClone: 'DataCloneError on uncloneable values',
  BigInt: 'SyntaxError or RangeError on invalid input',
  'new URL': 'TypeError on an invalid URL',
  'new RegExp': 'SyntaxError on an invalid pattern',
  'JSON.stringify': 'TypeError on circular structures or BigInt values',
  'new Array': 'RangeError on an invalid length',
  'new Intl.NumberFormat': 'RangeError on an invalid locale or option',
  'new Intl.DateTimeFormat': 'RangeError on an invalid locale or option',
  'String.fromCodePoint': 'RangeError on an invalid code point',
  execSync: 'Error when the command exits with a failure',
  execFileSync: 'Error when the command exits with a failure',
};

/** Node's synchronous file system calls throw when a path is missing or inaccessible. */
const fsSyncCalls = ['readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync', 'statSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'openSync'];
for (const call of fsSyncCalls) {
  throwingCalls[call] = throwingCalls[`fs.${call}`] = 'Error when the path is missing or not accessible';
}
for (const call of ['execSync', 'execFileSync']) {
  throwingCalls[`child_process.${call}`] = throwingCalls[call];
}

/** An error that can leave a function: thrown inside it or in a function it calls. */
export interface ThrowPath {
  /** The throw statement or library call that raises the error. */
  origin: ts.Node;
  description: string;
  /** Calls from the analyzed function down to the origin. */
  chain: (ts.CallExpression | ts.NewExpression)[];
}

/** Computes which errors escape each function, following synchronous calls. */
export class ThrowAnalyzer {
  private readonly cache = new Map<FunctionWithBody, ThrowPath[]>();
  private readonly active = new Set<FunctionWithBody>();

  constructor(private readonly checker: ts.TypeChecker) {}

  /** Errors that can escape the function to its caller. */
  escaping(fn: FunctionWithBody): ThrowPath[] {
    // enclosingCatch stops at the function boundary, so any catch it finds is this function's own.
    return this.raised(fn).filter((p) => !enclosingCatch(p.chain[0] ?? p.origin));
  }

  /** Every error raised in the function's own code or its synchronous callees, caught or not. */
  raised(fn: FunctionWithBody): ThrowPath[] {
    const cached = this.cache.get(fn);
    if (cached) {
      return cached;
    }
    if (this.active.has(fn)) {
      return [];
    }
    this.active.add(fn);
    const paths: ThrowPath[] = [];
    forEachInFunction(fn.body!, (node) => {
      if (ts.isThrowStatement(node)) {
        paths.push({ origin: node, description: `throw ${nodeText(node.expression ?? node)}`, chain: [] });
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = `${ts.isNewExpression(node) ? 'new ' : ''}${node.expression.getText()}`;
        if (throwingCalls[name]) {
          paths.push({ origin: node, description: `${name}(): ${throwingCalls[name]}`, chain: [] });
          return;
        }
        const callee = calledFunction(this.checker, node);
        // An async callee's errors become rejections: they only rethrow where they are awaited.
        if (!callee || callee === fn || (isAsync(callee) && !ts.isAwaitExpression(node.parent))) {
          return;
        }
        for (const inner of this.escaping(callee)) {
          paths.push({ origin: inner.origin, description: inner.description, chain: [node, ...inner.chain] });
        }
      }
    });
    this.active.delete(fn);
    const unique = paths.filter((p, i) => paths.findIndex((q) => q.origin === p.origin && q.chain[0] === p.chain[0]) === i).slice(0, 200);
    this.cache.set(fn, unique);
    return unique;
  }
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

const maxCallerDepth = 5;

/** Exception Flow Visualizer: where errors are thrown, caught, transformed or swallowed around a function. */
export function exceptionFlowReport(project: VirtualProject, fileName: string, offset: number): Report {
  const program = project.program();
  const checker = program.getTypeChecker();
  const fn = functionAtOffset(project.sourceFile(fileName), offset, checker);
  const builder = new ReportBuilder('exceptions', `Exception flow of ${functionLabel(fn)}`);
  const analyzer = new ThrowAnalyzer(checker);
  const raised = analyzer.raised(fn);

  const pathRow = (p: ThrowPath): ReportNode => {
    const catcher = enclosingCatch(p.chain[0] ?? p.origin);
    const caught = catcher && isInside(catcher, fn) ? classifyCatch(catcher) : undefined;
    const tone: Tone = !caught ? 'error' : caught.behavior === 'swallows' || caught.behavior === 'logs' ? 'warning' : 'ok';
    return {
      label: p.chain.length ? `${calleeText(p.chain[0])}() → ${p.description}` : p.description,
      description: caught ? `caught: ${caught.detail}` : isAsync(fn) ? 'escapes as a rejection' : 'escapes to the caller',
      icon: p.chain.length ? 'call-outgoing' : 'zap',
      tone,
      location: builder.at(p.chain[0] ?? p.origin),
      children: p.chain.length
        ? [
            ...p.chain.slice(1).map((c) => ({ label: `calls ${calleeText(c)}()`, icon: 'arrow-small-right', location: builder.at(c) })),
            { label: p.description, icon: 'zap', tone: 'error' as const, location: builder.at(p.origin) },
          ]
        : undefined,
    };
  };

  const own = raised.filter((p) => p.chain.length === 0);
  const fromCalls = raised.filter((p) => p.chain.length > 0);
  const catches: ReportNode[] = [];
  forEachInFunction(fn.body!, (node) => {
    if (ts.isCatchClause(node)) {
      const { behavior, detail } = classifyCatch(node);
      catches.push({
        label: `catch${node.variableDeclaration ? ` (${node.variableDeclaration.getText()})` : ''}: ${detail}`,
        icon: behavior === 'swallows' ? 'mute' : 'shield',
        tone: behavior === 'swallows' || behavior === 'logs' ? 'warning' : behavior === 'transforms' || behavior === 'rethrows' ? 'info' : 'ok',
        location: builder.at(node),
      });
    } else if (ts.isTryStatement(node) && node.finallyBlock) {
      catches.push({ label: 'finally block runs on every exit', icon: 'debug-step-out', location: builder.at(node.finallyBlock) });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch' && node.arguments[0]) {
      const handler = node.arguments[0];
      const empty = (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && ts.isBlock(handler.body) && handler.body.statements.length === 0;
      catches.push({ label: `.catch(${nodeSnippet(handler, 30)})`, description: empty ? 'swallows the rejection' : 'handles the rejection', icon: empty ? 'mute' : 'shield', tone: empty ? 'warning' : 'ok', location: builder.at(node) });
    }
  });

  const escaping = analyzer.escaping(fn);
  const roots: ReportNode[] = [
    { label: 'Thrown here', description: plural(own.length, 'error'), icon: 'zap', expanded: true, children: own.length ? own.map(pathRow) : [{ label: 'nothing thrown directly', icon: 'pass', tone: 'ok' }] },
    { label: 'Thrown by called functions', description: plural(fromCalls.length, 'error'), icon: 'call-outgoing', expanded: true, children: fromCalls.length ? fromCalls.map(pathRow) : [{ label: 'no called function throws', icon: 'pass', tone: 'ok' }] },
  ];
  if (catches.length) {
    roots.push({ label: 'Catch and finally blocks', description: plural(catches.length, 'handler'), icon: 'shield', expanded: true, children: catches });
  }
  if (escaping.length > 0) {
    const callers = isAsync(fn)
      ? new RejectionTracer(project, builder).propagate(fn, `${functionLabel(fn)} rejects`, fn, 0)
      : callerHandling(project, analyzer, fn, builder, 0, new Set());
    roots.push({ ...callers, label: `Escaping errors (${escaping.length}) reach callers`, icon: 'call-incoming', expanded: true });
  }
  return builder.finish(roots, `${plural(raised.length, 'error source')}, ${escaping.length} escaping`);
}

/** How each caller treats errors escaping a synchronous function. */
function callerHandling(project: VirtualProject, analyzer: ThrowAnalyzer, fn: FunctionWithBody, builder: ReportBuilder, depth: number, seen: Set<FunctionWithBody>): ReportNode {
  if (depth >= maxCallerDepth || seen.has(fn)) {
    return { label: `${functionLabel(fn)} (stopped)`, icon: 'ellipsis', tone: 'warning', location: builder.at(fn) };
  }
  // `seen` holds the functions on the current path, so a caller reached by two routes is followed both times.
  seen.add(fn);
  const { calls, escapes } = callSitesOf(project.service, fn);
  const children: ReportNode[] = calls.map(({ call }) => {
    const caller = enclosingFunction(call);
    const catcher = enclosingCatch(call);
    if (catcher) {
      const { behavior, detail } = classifyCatch(catcher);
      return { label: `caught in ${functionLabel(caller)}`, description: detail, icon: behavior === 'swallows' ? 'mute' : 'shield', tone: behavior === 'swallows' || behavior === 'logs' ? 'warning' : 'ok', location: builder.at(call) };
    }
    if (!caller) {
      return { label: 'called at module level: an error fails the module load', icon: 'error', tone: 'error', location: builder.at(call) };
    }
    if (isAsync(caller)) {
      // From here the error travels as a rejection of the caller's promise.
      const rejection = new RejectionTracer(project, builder).propagate(caller, `${functionLabel(caller)} rejects`, call, 0);
      return {
        label: `propagates into async ${functionLabel(caller)}, becoming a rejection`,
        icon: 'debug-step-out',
        tone: rejection.tone ?? 'warning',
        location: builder.at(call),
        expanded: true,
        children: rejection.children ?? [rejection],
      };
    }
    const next = callerHandling(project, analyzer, caller, builder, depth + 1, seen);
    return {
      label: `propagates through ${functionLabel(caller)}`,
      icon: 'debug-step-out',
      tone: next.tone,
      location: builder.at(call),
      expanded: true,
      children: next.children ?? [next],
    };
  });
  seen.delete(fn);
  children.push(...escapes.map((e) => ({ label: `passed as a value: ${nodeSnippet(e.parent, 40)}`, icon: 'question', tone: 'warning' as const, location: builder.at(e) })));
  if (children.length === 0) {
    return { label: `${functionLabel(fn)} has no callers: errors are uncaught`, icon: 'error', tone: 'error', location: builder.at(fn) };
  }
  return { label: functionLabel(fn), icon: 'call-incoming', tone: worst(children), children, expanded: true, location: builder.at(fn) };
}

function calleeText(call: ts.CallExpression | ts.NewExpression): string {
  return `${ts.isNewExpression(call) ? 'new ' : ''}${nodeText(call.expression)}`;
}
