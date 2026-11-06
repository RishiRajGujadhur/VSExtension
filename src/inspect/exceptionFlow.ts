import * as ts from 'typescript';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, Tone, nodeSnippet, plural } from '../structure/report';
import { FunctionWithBody, callSitesOf, calledFunction, enclosingFunction, forEachInFunction, functionAtOffset, functionLabel, nodeText } from '../structure/util';
import { isAsync } from './missingAwait';
import { RejectionTracer, classifyCatch, enclosingCatch, unhandledPaths, worst } from './rejections';

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

throwingCalls['new Intl.Collator'] = 'RangeError on an invalid locale or option';
throwingCalls['new Intl.PluralRules'] = 'RangeError on an invalid locale or option';
throwingCalls['new Intl.RelativeTimeFormat'] = 'RangeError on an invalid locale or option';
throwingCalls['new Intl.ListFormat'] = 'RangeError on an invalid locale or option';
throwingCalls['new Intl.Segmenter'] = 'RangeError on an invalid locale or option';
throwingCalls['new Intl.DisplayNames'] = 'RangeError on an invalid locale or option';

throwingCalls['new Function'] = 'SyntaxError on invalid code';
throwingCalls['eval'] = 'SyntaxError on invalid code, or whatever the code throws';

throwingCalls['new WebSocket'] = 'SyntaxError on an invalid URL';
throwingCalls['new Worker'] = 'SyntaxError on an invalid script URL';

throwingCalls['new ArrayBuffer'] = 'RangeError on an invalid length';
throwingCalls['new SharedArrayBuffer'] = 'RangeError on an invalid length';
throwingCalls['Buffer.alloc'] = 'RangeError on an invalid size';

throwingCalls['require'] = 'Error when the module can\'t be found';
throwingCalls['process.chdir'] = 'Error when the folder does not exist';

throwingCalls['assert'] = 'AssertionError when the check fails';
throwingCalls['assert.ok'] = 'AssertionError when the check fails';
throwingCalls['assert.equal'] = 'AssertionError when the check fails';
throwingCalls['assert.strictEqual'] = 'AssertionError when the check fails';
throwingCalls['assert.deepEqual'] = 'AssertionError when the check fails';
throwingCalls['assert.deepStrictEqual'] = 'AssertionError when the check fails';
throwingCalls['assert.match'] = 'AssertionError when the check fails';

throwingCalls['yaml.parse'] = 'YAMLParseError on invalid YAML';
throwingCalls['YAML.parse'] = 'YAMLParseError on invalid YAML';
throwingCalls['yaml.load'] = 'YAMLException on invalid YAML';
throwingCalls['jsyaml.load'] = 'YAMLException on invalid YAML';
throwingCalls['toml.parse'] = 'Error on invalid TOML';
throwingCalls['JSON5.parse'] = 'SyntaxError on invalid JSON5';

throwingCalls['new Intl.Locale'] = 'RangeError on an invalid language tag';

/** Node's synchronous file system calls throw when a path is missing or inaccessible. */
const fsSyncCalls = ['readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync', 'statSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'openSync'];
for (const call of fsSyncCalls) {
  throwingCalls[call] = throwingCalls[`fs.${call}`] = 'Error when the path is missing or not accessible';
}
for (const call of ['execSync', 'execFileSync']) {
  throwingCalls[`child_process.${call}`] = throwingCalls[call];
}

/**
 * Methods that throw on bad input, recognized by the receiver's type: `Array` (arrays), `string`,
 * `number`, or the name of a library type such as `Date` or `Storage`.
 */
const throwingMethods: { receiver: string | RegExp; method: string | RegExp; note: string; when?: (call: ts.CallExpression) => boolean }[] = [];

/** The receiver type of a method call, in the terms throwingMethods uses. */
function receiverKinds(checker: ts.TypeChecker, receiver: ts.Expression): string[] {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  const kinds = [checker.isArrayType(type) || checker.isTupleType(type) ? 'Array' : '', type.flags & ts.TypeFlags.StringLike ? 'string' : '', type.flags & ts.TypeFlags.NumberLike ? 'number' : ''];
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol) kinds.push(symbol.getName());
  for (const base of type.getBaseTypes?.() ?? []) kinds.push(base.getSymbol()?.getName() ?? '');
  return kinds.filter(Boolean);
}

/** The note for a method call that can throw, or undefined. */
function throwingMethod(checker: ts.TypeChecker, call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const name = call.expression.name.text;
  const candidates = throwingMethods.filter((m) => (typeof m.method === 'string' ? m.method === name : m.method.test(name)) && (!m.when || m.when(call)));
  if (candidates.length === 0) return undefined;
  const kinds = receiverKinds(checker, call.expression.expression);
  const found = candidates.find((m) => kinds.some((k) => (typeof m.receiver === 'string' ? m.receiver === k : m.receiver.test(k))));
  return found && `${call.expression.expression.getText()}.${name}(): ${found.note}`;
}

throwingMethods.push({ receiver: 'Array', method: 'reduce', note: 'TypeError on an empty array without an initial value', when: (c) => c.arguments.length === 1 });
throwingMethods.push({ receiver: 'Array', method: 'reduceRight', note: 'TypeError on an empty array without an initial value', when: (c) => c.arguments.length === 1 });

throwingMethods.push({ receiver: 'Date', method: 'toISOString', note: 'RangeError on an invalid date' });
throwingMethods.push({ receiver: 'Date', method: 'toJSON', note: 'RangeError on an invalid date' });

throwingMethods.push({ receiver: 'number', method: /^(toFixed|toPrecision|toExponential)$/, note: 'RangeError when the digits are out of range', when: (c) => c.arguments.length > 0 });
throwingMethods.push({ receiver: 'number', method: 'toString', note: 'RangeError when the radix is not 2 to 36', when: (c) => c.arguments.length > 0 });

throwingMethods.push({ receiver: 'string', method: 'repeat', note: 'RangeError on a negative or infinite count' });
throwingMethods.push({ receiver: 'string', method: 'normalize', note: 'RangeError on an unknown form', when: (c) => c.arguments.length > 0 });

throwingMethods.push({ receiver: /^(Document|Element|HTMLElement|DocumentFragment|ParentNode|ShadowRoot)$/, method: /^(querySelector|querySelectorAll|matches|closest)$/, note: 'SyntaxError on an invalid selector' });

throwingMethods.push({ receiver: 'Storage', method: 'setItem', note: 'QuotaExceededError when storage is full' });

throwingMethods.push({ receiver: /^(Zod\w*|ObjectSchema|Schema|StringSchema|NumberSchema)$/, method: /^(parse|validateSync)$/, note: 'a validation error when the value does not match the schema' });

throwingMethods.push({ receiver: 'TextDecoder', method: 'decode', note: 'TypeError on invalid bytes when fatal is set' });

throwingMethods.push({ receiver: /^(Response|Request|Body)$/, method: /^(json|text|arrayBuffer|blob|formData)$/, note: 'TypeError when the body was already read; rejects on invalid JSON' });

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
        const method = ts.isCallExpression(node) ? throwingMethod(this.checker, node) : undefined;
        if (method) {
          paths.push({ origin: node, description: method, chain: [] });
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
      action: p.chain.length ? followCallee(checker, p.chain[0]) : undefined,
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
  const types = new Map<string, ThrowPath[]>();
  for (const p of raised) {
    const type = errorType(checker, p);
    types.set(type, [...(types.get(type) ?? []), p]);
  }
  if (types.size > 0) {
    roots.push({
      label: 'Error types',
      description: [...types.keys()].join(', '),
      icon: 'symbol-class',
      children: [...types].map(([type, paths]) => ({ label: type, description: plural(paths.length, 'source'), icon: 'symbol-class', location: builder.at(paths[0].origin) })),
    });
  }
  if (catches.length) {
    roots.push({ label: 'Catch and finally blocks', description: plural(catches.length, 'handler'), icon: 'shield', expanded: true, children: catches });
  }
  if (escaping.length > 0) {
    const callers = isAsync(fn)
      ? new RejectionTracer(project, builder).propagate(fn, `${functionLabel(fn)} rejects`, fn, 0)
      : callerHandling(project, analyzer, fn, builder, 0, new Set());
    roots.push({ ...callers, label: `Escaping errors (${escaping.length}) reach callers`, icon: 'call-incoming', expanded: true });
    const uncaught = unhandledPaths(callers);
    if (uncaught.length > 0) {
      roots.unshift({ label: 'Uncaught', description: plural(uncaught.length, 'path'), icon: 'error', tone: 'error', expanded: true, children: uncaught });
    }
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

/** The class of error a path raises: `ConfigError` for `throw new ConfigError(…)`, `SyntaxError` for JSON.parse. */
function errorType(checker: ts.TypeChecker, path: ThrowPath): string {
  const origin = path.origin;
  if (ts.isThrowStatement(origin)) {
    const thrown = origin.expression;
    if (thrown && ts.isNewExpression(thrown)) {
      return nodeText(thrown.expression);
    }
    return thrown ? checker.typeToString(checker.getTypeAtLocation(thrown)) : 'unknown';
  }
  return /\(\): (\w+)/.exec(path.description)?.[1] ?? 'Error';
}

/** Opens the exception flow of the function a call goes into. */
function followCallee(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): ReportNode['action'] {
  const callee = calledFunction(checker, call);
  const name = callee && ((callee as ts.FunctionDeclaration).name ?? callee);
  return name ? { kind: 'follow', command: 'tsStructure.exceptionFlow', file: callee.getSourceFile().fileName, offset: name.getStart() } : undefined;
}

function calleeText(call: ts.CallExpression | ts.NewExpression): string {
  return `${ts.isNewExpression(call) ? 'new ' : ''}${nodeText(call.expression)}`;
}
