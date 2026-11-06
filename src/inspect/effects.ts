import * as ts from 'typescript';
import { ReportBuilder, ReportNode, Report, nodeSnippet, plural } from '../structure/report';
import {
  FunctionWithBody,
  calledFunction,
  enclosingFunction,
  forEachDescendant,
  functionAtOffset,
  functionLabel,
  isFunctionWithBody,
  nodeText,
  skipOuterExpressions,
  sourceFileOf,
  symbolAt,
  writeOf,
} from '../structure/util';
import { resolveAlias } from '../analysis/referenceIndex';
import { findIdentifier } from '../analysis/impact';

export type EffectKind =
  | 'mutates-parameter'
  | 'mutates-this'
  | 'mutates-module'
  | 'mutates-import'
  | 'mutates-captured'
  | 'writes-global'
  | 'global'
  | 'io'
  | 'timer'
  | 'nondeterministic'
  /** A call the analysis cannot follow, such as a callback parameter, which could do anything. */
  | 'unknown';

export interface Effect {
  kind: EffectKind;
  /** What is affected, such as `items`, `this.count` or `console`. */
  target: string;
  description: string;
  /** Where the effect happens: in this function, or the call that leads to it. */
  node: ts.Node;
  /** For effects of called functions: the effect inside the callee. */
  via?: { fn: FunctionWithBody; effect: Effect };
  /** For parameter mutations: which parameter, so callers can map it to their argument. */
  parameterIndex?: number;
  /** The state's declaration, for grouping mutations by what they change. */
  declaration?: ts.Node;
}

export const mutationKinds: ReadonlySet<EffectKind> = new Set(['mutates-parameter', 'mutates-this', 'mutates-module', 'mutates-import', 'mutates-captured', 'writes-global']);

const mutatingMethods: Record<string, readonly string[]> = {
  Array: ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'],
  Map: ['set', 'delete', 'clear'],
  Set: ['add', 'delete', 'clear'],
  WeakMap: ['set', 'delete'],
  WeakSet: ['add', 'delete'],
};

const effectfulGlobals: Record<string, { kind: EffectKind; note: string }> = {
  console: { kind: 'io', note: 'writes to the console' },
  fetch: { kind: 'io', note: 'makes a network request' },
  XMLHttpRequest: { kind: 'io', note: 'makes a network request' },
  WebSocket: { kind: 'io', note: 'opens a network connection' },
  EventSource: { kind: 'io', note: 'opens a network connection' },
  localStorage: { kind: 'io', note: 'uses browser storage' },
  sessionStorage: { kind: 'io', note: 'uses browser storage' },
  indexedDB: { kind: 'io', note: 'uses browser storage' },
  alert: { kind: 'io', note: 'shows a dialog' },
  confirm: { kind: 'io', note: 'shows a dialog' },
  prompt: { kind: 'io', note: 'shows a dialog' },
  BroadcastChannel: { kind: 'io', note: 'sends messages to other tabs' },
  postMessage: { kind: 'io', note: 'sends a message to another window' },
  Notification: { kind: 'io', note: 'shows a system notification' },
  caches: { kind: 'io', note: 'uses the Cache Storage' },
  cookieStore: { kind: 'io', note: 'uses cookies' },
  Worker: { kind: 'io', note: 'starts a background worker' },
  SharedWorker: { kind: 'io', note: 'connects to a shared worker' },
  requestIdleCallback: { kind: 'timer', note: 'schedules work for when the browser is idle' },
  FileReader: { kind: 'io', note: 'reads a file' },
  document: { kind: 'global', note: 'uses the DOM' },
  window: { kind: 'global', note: 'uses the window object' },
  globalThis: { kind: 'global', note: 'uses the global object' },
  navigator: { kind: 'global', note: 'reads browser state' },
  location: { kind: 'global', note: 'uses the page location' },
  history: { kind: 'global', note: 'uses browser history' },
  process: { kind: 'global', note: 'uses process state' },
  setTimeout: { kind: 'timer', note: 'schedules a timer' },
  setInterval: { kind: 'timer', note: 'schedules a repeating timer' },
  setImmediate: { kind: 'timer', note: 'schedules a callback' },
  requestAnimationFrame: { kind: 'timer', note: 'schedules a frame callback' },
  queueMicrotask: { kind: 'timer', note: 'schedules a microtask' },
};

const nondeterministicMembers: Record<string, readonly string[]> = {
  Math: ['random'],
  Date: ['now'],
  performance: ['now'],
  crypto: ['randomUUID', 'getRandomValues'],
};

const ioModules = new Set(['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'readline', 'cluster', 'worker_threads', 'tls', 'os', 'dns', 'dns/promises', 'v8', 'inspector']);

/** Computes the side effects of functions, following calls into other project functions. */
export class EffectAnalyzer {
  private readonly cache = new Map<FunctionWithBody, Effect[]>();
  private readonly active = new Set<FunctionWithBody>();

  constructor(private readonly checker: ts.TypeChecker) {}

  effectsOf(fn: FunctionWithBody): Effect[] {
    const cached = this.cache.get(fn);
    if (cached) {
      return cached;
    }
    if (this.active.has(fn)) {
      // Recursion: the effects are being collected further up the stack.
      return [];
    }
    this.active.add(fn);
    const effects: Effect[] = [];
    forEachDescendant(fn.body!, (node) => this.visit(fn, node, effects));
    this.active.delete(fn);
    const unique = dedupe(effects);
    this.cache.set(fn, unique);
    return unique;
  }

  private visit(fn: FunctionWithBody, node: ts.Node, effects: Effect[]): void {
    const write = writeTarget(node);
    if (write) {
      const effect = this.classifyWrite(fn, write.target, write.how, node);
      if (effect) {
        effects.push(effect);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      this.visitCall(fn, node, effects);
    }
    if (ts.isIdentifier(node)) {
      const effect = this.globalEffect(node);
      if (effect) {
        effects.push(effect);
      }
    }
  }

  private visitCall(fn: FunctionWithBody, call: ts.CallExpression | ts.NewExpression, effects: Effect[]): void {
    const callee = skipOuterExpressions(call.expression);
    // Mutating methods on arrays, maps and sets: `items.push(x)`.
    if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(call)) {
      const owner = this.collectionKind(callee.expression);
      if (owner && mutatingMethods[owner].includes(callee.name.text)) {
        const effect = this.classifyWrite(fn, callee.expression, `.${callee.name.text}()`, call);
        if (effect) {
          effects.push(effect);
        }
      }
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(callee.name.text) && call.arguments[0]) {
        const effect = this.classifyWrite(fn, call.arguments[0], `Object.${callee.name.text}()`, call);
        if (effect) {
          effects.push(effect);
        }
      }
    }
    // `Date()` without new returns the current time as a string.
    if (ts.isCallExpression(call) && ts.isIdentifier(callee) && callee.text === 'Date' && this.isLibrary(callee)) {
      effects.push({ kind: 'nondeterministic', target: 'Date()', description: 'reads the current time', node: call });
    }
    if (ts.isNewExpression(call) && ts.isIdentifier(callee) && callee.text === 'Date' && !call.arguments?.length && this.isLibrary(callee)) {
      effects.push({ kind: 'nondeterministic', target: 'new Date()', description: 'reads the current time', node: call });
    }
    const target = calledFunction(this.checker, call);
    if (!target) {
      const unknown = this.unfollowedCall(call);
      if (unknown) {
        effects.push(unknown);
      }
      return;
    }
    if (target === fn) {
      return;
    }
    for (const inner of this.effectsOf(target)) {
      if (inner.kind === 'mutates-parameter' && inner.parameterIndex !== undefined) {
        // The callee changes an argument; whether that matters depends on what this call passes.
        const argument = call.arguments?.[inner.parameterIndex];
        const mapped = argument && !ts.isSpreadElement(argument) ? this.classifyWrite(fn, argument, `via ${functionLabel(target)}()`, call) : undefined;
        if (mapped) {
          effects.push({ ...mapped, via: { fn: target, effect: inner } });
        }
        continue;
      }
      if (inner.kind === 'mutates-this') {
        // Only visible to this function when it calls a method on its own instance.
        if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && !ts.isConstructorDeclaration(fn)) {
          effects.push({ ...inner, node: call, via: { fn: target, effect: inner } });
        }
        continue;
      }
      if (inner.kind === 'mutates-captured' && inner.declaration && isInside(inner.declaration, fn)) {
        // State local to this function: not visible to its callers.
        continue;
      }
      effects.push({ ...inner, node: call, via: { fn: target, effect: inner } });
    }
  }

  /** A call to a function value the project doesn't define: a callback parameter, a function-typed property or variable. */
  private unfollowedCall(call: ts.CallExpression | ts.NewExpression): Effect | undefined {
    const callee = skipOuterExpressions(call.expression);
    const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
    const symbol = name && this.checker.getSymbolAtLocation(name);
    const declaration = symbol && resolveAlias(this.checker, symbol).valueDeclaration;
    if (!declaration || declaration.getSourceFile().isDeclarationFile) {
      // Library functions are known by name above, or assumed to have no effects.
      return undefined;
    }
    const kind = ts.isParameter(declaration) || ts.isBindingElement(declaration)
      ? 'a parameter'
      : ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) || ts.isMethodSignature(declaration)
        ? 'a property'
        : ts.isVariableDeclaration(declaration) && !declaration.initializer
          ? 'a variable'
          : undefined;
    return kind ? { kind: 'unknown', target: name.text, description: `calls ${nodeText(callee)}(), ${kind} holding any function`, node: call } : undefined;
  }

  /** Classifies a write through an expression by where its root value lives. */
  private classifyWrite(fn: FunctionWithBody, target: ts.Node, how: string, at: ts.Node, depth = 0): Effect | undefined {
    const { root, path } = rootOf(target);
    const access = `${root.getText()}${path}`;
    if (root.kind === ts.SyntaxKind.ThisKeyword) {
      if (ts.isConstructorDeclaration(fn) || !path || isArrowInsideConstructor(root)) {
        return undefined;
      }
      return { kind: 'mutates-this', target: access, description: `changes ${access}${suffix(how)}`, node: at };
    }
    if (!ts.isIdentifier(root)) {
      return undefined;
    }
    const raw = this.checker.getSymbolAtLocation(root);
    const symbol = raw ? resolveAlias(this.checker, raw) : undefined;
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) {
      return undefined;
    }
    if (declaration.getSourceFile().isDeclarationFile) {
      return { kind: 'writes-global', target: access, description: `writes global ${access}${suffix(how)}`, node: at, declaration };
    }
    const owner = ts.isParameter(declaration) || ts.isBindingElement(declaration) ? ownerFunction(declaration) : enclosingFunction(declaration);
    const rebinding = !path && !how.startsWith('.') && !how.startsWith('Object.') && !how.startsWith('via ');
    if (owner === fn) {
      const parameter = parameterOf(declaration, fn);
      if (parameter) {
        if (rebinding) {
          return undefined;
        }
        return {
          kind: 'mutates-parameter',
          target: access,
          description: `mutates parameter ${access}${suffix(how)}`,
          node: at,
          parameterIndex: fn.parameters.indexOf(parameter),
          declaration,
        };
      }
      // A local alias of shared state: `const list = this.items; list.push(x)`.
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && depth < 3 && !rebinding && isPlainReference(declaration.initializer)) {
        const aliased = this.classifyWrite(fn, declaration.initializer, how, at, depth + 1);
        return aliased && { ...aliased, description: `${aliased.description} (through ${root.text})` };
      }
      return undefined;
    }
    if (owner && isInside(fn, owner)) {
      return { kind: 'mutates-captured', target: access, description: `${rebinding ? 'reassigns' : 'changes'} captured ${access} of ${functionLabel(owner)}${suffix(how)}`, node: at, declaration };
    }
    if (owner) {
      return undefined;
    }
    const imported = !!raw && raw !== symbol;
    if (imported || declaration.getSourceFile() !== fn.getSourceFile()) {
      return { kind: 'mutates-import', target: access, description: `changes imported ${access}${suffix(how)}`, node: at, declaration };
    }
    return { kind: 'mutates-module', target: access, description: `${rebinding ? 'reassigns module variable' : 'changes module state'} ${access}${suffix(how)}`, node: at, declaration };
  }

  private globalEffect(identifier: ts.Identifier): Effect | undefined {
    const parent = identifier.parent;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === identifier) || (parent as ts.NamedDeclaration).name === identifier || ts.isTypeReferenceNode(parent)) {
      return undefined;
    }
    const known = effectfulGlobals[identifier.text];
    if (known && this.isLibrary(identifier)) {
      let top: ts.Node = identifier;
      while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top) {
        top = top.parent;
      }
      if (writeOf(top)) {
        // Reported as a global write.
        return undefined;
      }
      const member = ts.isPropertyAccessExpression(parent) && parent.expression === identifier ? `.${parent.name.text}` : '';
      return { kind: known.kind, target: `${identifier.text}${member}`, description: known.note, node: identifier };
    }
    const members = nondeterministicMembers[identifier.text];
    if (members && ts.isPropertyAccessExpression(parent) && members.includes(parent.name.text) && this.isLibrary(identifier)) {
      return { kind: 'nondeterministic', target: `${identifier.text}.${parent.name.text}`, description: identifier.text === 'Math' || identifier.text === 'crypto' ? 'produces random values' : 'reads the current time', node: parent };
    }
    const moduleName = this.importedModule(identifier);
    if (moduleName && ioModules.has(moduleName.replace(/^node:/, '')) && ts.isCallExpression(skipCallee(identifier).parent)) {
      return { kind: 'io', target: `${moduleName} ${identifier.text}`, description: `uses ${moduleName}`, node: identifier };
    }
    return undefined;
  }

  private isLibrary(identifier: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    return !!symbol?.declarations?.length && symbol.declarations.every((d) => d.getSourceFile().isDeclarationFile);
  }

  private importedModule(identifier: ts.Identifier): string | undefined {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    if (!declaration || !(symbol!.flags & ts.SymbolFlags.Alias)) {
      return undefined;
    }
    for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
      if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
        return current.moduleSpecifier.text;
      }
    }
    return undefined;
  }

  private collectionKind(expression: ts.Expression): string | undefined {
    const type = this.checker.getTypeAtLocation(expression);
    if (this.checker.isArrayType(type)) {
      return 'Array';
    }
    const name = (type.aliasSymbol ?? type.getSymbol())?.getName();
    return name && name in mutatingMethods ? name : undefined;
  }
}

function writeTarget(node: ts.Node): { target: ts.Node; how: string } | undefined {
  if (ts.isBinaryExpression(node) && writeOf(node.left) === node) {
    return { target: node.left, how: node.operatorToken.getText() };
  }
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && writeOf(node.operand) === node) {
    return { target: node.operand, how: node.operator === ts.SyntaxKind.PlusPlusToken ? '++' : '--' };
  }
  if (ts.isDeleteExpression(node)) {
    return { target: node.expression, how: 'delete' };
  }
  return undefined;
}

function rootOf(target: ts.Node): { root: ts.Node; path: string } {
  let current = target;
  const parts: string[] = [];
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(`.${current.name.text}`);
      current = current.expression;
    } else if (ts.isElementAccessExpression(current)) {
      parts.unshift(`[${nodeSnippet(current.argumentExpression, 20)}]`);
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return { root: current, path: parts.join('') };
    }
  }
}

function isPlainReference(node: ts.Expression): boolean {
  const { root } = rootOf(node);
  return ts.isIdentifier(root) || root.kind === ts.SyntaxKind.ThisKeyword;
}

function parameterOf(declaration: ts.Node, fn: FunctionWithBody): ts.ParameterDeclaration | undefined {
  let current: ts.Node = declaration;
  while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) {
    current = current.parent;
  }
  return ts.isParameter(current) && current.parent === fn ? current : undefined;
}

function ownerFunction(declaration: ts.Node): FunctionWithBody | undefined {
  let current: ts.Node = declaration;
  while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) {
    current = current.parent;
  }
  if (ts.isParameter(current) && isFunctionWithBody(current.parent)) {
    return current.parent;
  }
  return enclosingFunction(current);
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function isArrowInsideConstructor(node: ts.Node): boolean {
  for (let current = enclosingFunction(node); current; current = enclosingFunction(current)) {
    if (ts.isConstructorDeclaration(current)) {
      return true;
    }
    if (!ts.isArrowFunction(current)) {
      return false;
    }
  }
  return false;
}

function skipCallee(identifier: ts.Identifier): ts.Node {
  const parent = identifier.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === identifier ? parent : identifier;
}

function suffix(how: string): string {
  return how === '=' ? '' : ` (${how})`;
}

function dedupe(effects: Effect[]): Effect[] {
  const seen = new Set<string>();
  return effects.filter((e) => {
    const key = `${e.kind}|${e.target}|${e.node.pos}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function functionsIn(sourceFile: ts.SourceFile): FunctionWithBody[] {
  const functions: FunctionWithBody[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (isFunctionWithBody(node)) {
      functions.push(node);
    }
  });
  return functions;
}

/** The chain of calls from the analyzed function to the code that performs the effect. */
export function effectChain(effect: Effect): Effect[] {
  const chain = [effect];
  for (let current = effect.via; current; current = current.effect.via) {
    chain.push(current.effect);
  }
  return chain;
}

const kindLabels: Record<EffectKind, string> = {
  'mutates-parameter': 'Mutates arguments',
  'mutates-this': 'Mutates the instance',
  'mutates-module': 'Mutates module state',
  'mutates-import': 'Mutates imported state',
  'mutates-captured': 'Mutates captured variables',
  'writes-global': 'Writes globals',
  global: 'Uses global state',
  io: 'Input/output',
  timer: 'Schedules work',
  nondeterministic: 'Nondeterministic',
  unknown: 'Calls it could not follow',
};

const kindIcons: Record<EffectKind, string> = {
  'mutates-parameter': 'symbol-parameter',
  'mutates-this': 'symbol-field',
  'mutates-module': 'symbol-variable',
  'mutates-import': 'package',
  'mutates-captured': 'symbol-variable',
  'writes-global': 'globe',
  global: 'globe',
  io: 'plug',
  timer: 'watch',
  nondeterministic: 'question',
  unknown: 'debug-disconnect',
};

/** What a mutation of each kind changes, for short summaries. */
const mutatedThing: Partial<Record<EffectKind, string>> = {
  'mutates-parameter': 'arguments',
  'mutates-this': 'the instance',
  'mutates-module': 'module state',
  'mutates-import': 'imported state',
  'mutates-captured': 'captured variables',
  'writes-global': 'globals',
};

/** What each kind of mutation means, for the hover of a function's row. */
const mutationHelp: Partial<Record<EffectKind, string>> = {
  'mutates-parameter': '**Arguments**: changes an object a caller passed in, so the caller sees the change.',
  'mutates-this': '**The instance**: changes a field of this, which every user of the object sees.',
  'mutates-module': '**Module state**: changes a variable at the top of its module, shared by every function there.',
  'mutates-import': '**Imported state**: changes an object another module exports, so every importer sees it.',
  'mutates-captured': '**Captured variables**: changes a variable of an enclosing function from a closure.',
  'writes-global': '**Globals**: writes to window, globalThis or another global, visible to all code.',
};

function effectNode(effect: Effect, builder: ReportBuilder): ReportNode {
  const chain = effectChain(effect);
  const origin = chain[chain.length - 1];
  const steps = chain.slice(1).map((e, i) => ({
    label: i === chain.length - 2 ? `${e.description}` : `calls ${functionLabel(chain[i].via!.fn)}`,
    description: functionLabel(chain[i].via!.fn),
    icon: i === chain.length - 2 ? kindIcons[e.kind] : 'arrow-small-right',
    location: builder.at(e.node),
  }));
  return {
    label: effect.via ? `${origin.description}` : effect.description,
    description: effect.via ? `via ${chain.slice(0, -1).map((e) => `${functionLabel(e.via!.fn)}()`).join(' → ')}` : nodeSnippet(effect.node, 40),
    icon: kindIcons[effect.kind],
    tone: mutationKinds.has(effect.kind) ? 'warning' : 'info',
    location: builder.at(effect.node),
    role: mutationKinds.has(effect.kind) ? 'write' : 'read',
    children: steps.length ? steps : undefined,
    // An inherited effect opens the side effects of the function it comes from.
    action: effect.via ? { kind: 'showSideEffects', command: 'tsStructure.sideEffects', file: effect.via.fn.getSourceFile().fileName, offset: functionNameOrSelf(effect.via.fn).getStart() } : undefined,
  };
}

/** Side-Effect Analyzer: everything a function does besides computing its return value. */
export function sideEffectReport(program: ts.Program, fileName: string, offset: number): Report {
  const checker = program.getTypeChecker();
  const fn = functionAtOffset(sourceFileOf(program, fileName), offset, checker);
  const effects = new EffectAnalyzer(checker).effectsOf(fn);
  const builder = new ReportBuilder('sideEffects', `Side effects of ${functionLabel(fn)}`);
  const roots: ReportNode[] = [];
  for (const kind of Object.keys(kindLabels) as EffectKind[]) {
    const ofKind = effects.filter((e) => e.kind === kind);
    if (ofKind.length > 0) {
      roots.push({
        label: kindLabels[kind],
        description: `${ofKind.filter((e) => !e.via).length} direct, ${ofKind.filter((e) => e.via).length} through calls`,
        icon: kindIcons[kind],
        tone: mutationKinds.has(kind) ? 'warning' : 'info',
        expanded: true,
        children: ofKind.map((e) => effectNode(e, builder)),
      });
    }
  }
  // The same effects by the call that brings them in, to see which call to change or isolate.
  const byCall = new Map<ts.Node, Effect[]>();
  for (const effect of effects.filter((e) => e.via)) {
    byCall.set(effect.node, [...(byCall.get(effect.node) ?? []), effect]);
  }
  if (byCall.size > 0) {
    roots.push({
      label: 'By call',
      description: plural(byCall.size, 'call'),
      icon: 'call-outgoing',
      children: [...byCall].map(([call, inherited]) => {
        const callee = inherited[0].via!.fn;
        return {
          label: `${functionLabel(callee)}()`,
          description: [...new Set(inherited.map((e) => kindLabels[e.kind].toLowerCase()))].join(', '),
          icon: 'symbol-function',
          tone: inherited.some((e) => mutationKinds.has(e.kind)) ? ('warning' as const) : ('info' as const),
          location: builder.at(call),
          action: { kind: 'showSideEffects', command: 'tsStructure.sideEffects', file: callee.getSourceFile().fileName, offset: functionNameOrSelf(callee).getStart() },
        };
      }),
    });
  }
  if (roots.length === 0) {
    roots.push({ label: `${functionLabel(fn)} has no detected side effects`, description: 'pure', icon: 'pass', tone: 'ok', location: builder.at(fn) });
  }
  const known = effects.filter((e) => e.kind !== 'unknown').length;
  const unfollowed = effects.length - known;
  return builder.finish(roots, [known ? plural(known, 'side effect') : unfollowed ? 'no known side effects' : 'pure', unfollowed ? plural(unfollowed, 'call') + ' not followed' : ''].filter(Boolean).join(', '));
}

/** The declaration of the state named at the offset (for `cart.items`, of `cart`), if the cursor is on a name. */
function stateAt(checker: ts.TypeChecker, sourceFile: ts.SourceFile, offset: number | undefined): ts.Node | undefined {
  if (offset === undefined) {
    return undefined;
  }
  let node: ts.Node | undefined = findIdentifier(sourceFile, offset);
  while (node && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    node = skipOuterExpressions(node.parent.expression);
  }
  if (!node || !ts.isIdentifier(node)) {
    return undefined;
  }
  const symbol = symbolAt(checker, node);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/**
 * Mutation Tracking: which functions change state they do not own, grouped both ways. Covers the file, or every
 * file in `project` when given. With an offset on a state's name, that state is selected.
 */
export function mutationReport(program: ts.Program, fileName: string, offset?: number, project?: readonly ts.SourceFile[]): Report {
  const checker = program.getTypeChecker();
  const sourceFile = sourceFileOf(program, fileName);
  const atCursor = stateAt(checker, sourceFile, offset);
  // Unless the cursor is on state the report lists, the function around it is the one selected.
  const fnAtCursor = offset === undefined ? undefined : functionsIn(sourceFile).filter((fn) => fn.getStart(sourceFile) <= offset && offset <= fn.end).at(-1);
  let cursorRow: ReportNode | undefined;
  const analyzer = new EffectAnalyzer(checker);
  const builder = new ReportBuilder('mutations', `Mutations in ${project ? 'the project' : baseName(sourceFile.fileName)}`);
  const byFunction: ReportNode[] = [];
  const byState = new Map<string, { label: string; kind: EffectKind; declaration?: ts.Node; entries: ReportNode[] }>();
  let total = 0;
  for (const fn of (project ?? [sourceFile]).flatMap(functionsIn)) {
    const mutations = analyzer.effectsOf(fn).filter((e) => mutationKinds.has(e.kind));
    if (mutations.length === 0) {
      continue;
    }
    total += mutations.length;
    byFunction.push({
      label: functionLabel(fn),
      description: [
        project ? baseName(fn.getSourceFile().fileName) : undefined,
        `${plural(mutations.length, 'mutation')}: ${[...new Set(mutations.map((e) => mutatedThing[e.kind]))].join(', ')}`,
      ]
        .filter(Boolean)
        .join(' · '),
      icon: 'symbol-function',
      tooltip: [...new Set(mutations.map((e) => mutationHelp[e.kind]).filter(Boolean))].join('\n\n'),
      location: builder.at(functionNameOrSelf(fn)),
      action: { kind: 'showSideEffects', command: 'tsStructure.sideEffects', file: fn.getSourceFile().fileName, offset: functionNameOrSelf(fn).getStart() },
      children: mutations.map((e) => effectNode(e, builder)),
    });
    if (fn === fnAtCursor) {
      cursorRow = byFunction[byFunction.length - 1];
    }
    for (const effect of mutations) {
      const origin = effectChain(effect).at(-1)!;
      if (effect.kind === 'mutates-parameter') {
        continue;
      }
      // `this` is a different object in each class, so instance state is grouped per class.
      const owner = effect.kind === 'mutates-this' ? ts.findAncestor(origin.node, ts.isClassLike) : undefined;
      const stateName = owner ? `this (${owner.name?.text ?? 'class'})` : effect.target.replace(/[.[].*$/, '');
      const key = origin.declaration
        ? `${origin.declaration.getSourceFile().fileName}:${origin.declaration.pos}`
        : owner
          ? `this:${owner.getSourceFile().fileName}:${owner.pos}`
          : `${effect.kind}:${stateName}`;
      const state = byState.get(key) ?? { label: stateName, kind: effect.kind, declaration: origin.declaration ?? owner, entries: [] };
      state.entries.push({ ...effectNode(effect, builder), label: `${functionLabel(fn)}: ${effect.via ? origin.description : effect.description}` });
      byState.set(key, state);
    }
  }
  if (cursorRow && ![...byState.values()].some((s) => atCursor && s.declaration === atCursor)) {
    cursorRow.expanded = cursorRow.focus = true;
  }
  // A first row that explains the term, for readers new to it.
  const roots: ReportNode[] = [
    {
      label: 'What is a mutation?',
      description: 'a change to state that outlives the call',
      icon: 'info',
      tooltip: 'Changing a module variable, an import, a global, a field of this or an argument. Click for more.',
      action: { kind: 'explain' },
    },
  ];
  if (byFunction.length > 0) {
    roots.push({ label: 'Functions that mutate state', description: plural(byFunction.length, 'function'), icon: 'symbol-function', expanded: true, children: byFunction });
  }
  if (byState.size > 0) {
    roots.push({
      label: 'Shared state and who changes it',
      icon: 'database',
      expanded: true,
      // Most-written state first; state declared in another file names it.
      children: [...byState.values()]
        .sort((a, b) => b.entries.length - a.entries.length)
        .map((s) => {
          const home = s.declaration?.getSourceFile();
          return {
            label: s.label,
            description: [kindLabels[s.kind].replace(/^Mutates /, ''), plural(s.entries.length, 'write'), home && (project || home !== sourceFile) ? baseName(home.fileName) : undefined]
              .filter(Boolean)
              .join(' · '),
            icon: kindIcons[s.kind],
            tone: 'warning' as const,
            location: s.declaration ? builder.at(s.declaration) : undefined,
            // Every read and write of the state, not only the writes listed here.
            action: s.kind !== 'mutates-this' && stateName(s.declaration) ? { kind: 'findUsages', command: 'tsStructure.semanticUsages', file: s.declaration!.getSourceFile().fileName, offset: stateName(s.declaration)!.getStart() } : undefined,
            children: s.entries,
            expanded: (atCursor && s.declaration === atCursor) || undefined,
            focus: (atCursor && s.declaration === atCursor) || undefined,
          };
        }),
    });
  }
  return builder.finish(roots, total ? plural(total, 'mutation') : 'no mutations of shared state');
}

/**
 * Named functions worth a side-effect lens: declarations, methods, `const f = () => …`, class fields such as
 * `handle = () => …` and object properties such as `{ onClick: () => … }`.
 */
export function lensTargets(sourceFile: ts.SourceFile): { fn: FunctionWithBody; anchor: ts.Node }[] {
  const targets: { fn: FunctionWithBody; anchor: ts.Node }[] = [];
  const isFunctionValue = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && node.name) {
      targets.push({ fn: node, anchor: node.name });
    } else if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && isFunctionValue(node.initializer) && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
      targets.push({ fn: node.initializer, anchor: node.name });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

/** The name of a state's declaration, where Find Usages can start; none for `this` of a class without a name. */
function stateName(declaration: ts.Node | undefined): ts.Node | undefined {
  const name = declaration && (declaration as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name : undefined;
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '');
}

function functionNameOrSelf(fn: FunctionWithBody): ts.Node {
  return (fn as ts.FunctionDeclaration).name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : fn);
}
