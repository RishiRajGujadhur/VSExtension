import ts = require('typescript');
import { EffectAnalyzer } from '../inspect/effects';
import type { FunctionWithBody } from '../structure/util';

/** A parameter, as "Explain this code" lists it. */
export interface FunctionInput {
  /** `id`, or the pattern as written for a destructured one: `{ id, name }`. */
  name: string;
  /** The declared type, when there is one. */
  type?: string;
  /** The default value as written: `10`. */
  defaultValue?: string;
  optional: boolean;
  /** `...items`: any number of them. */
  rest: boolean;
}

/** What a function gives back. */
export interface FunctionOutput {
  /** The declared return type, without `Promise<…>` for an async function. */
  type?: string;
  /** True when the result comes later (an async function, or one declared to return a Promise). */
  later: boolean;
  /** What its return statements give back, as written, up to four: `total`, `undefined`. */
  values: string[];
  /** It gives nothing back: no return with a value, or a `void` type. */
  nothing: boolean;
}

/** The inputs, output and effects of a function, read from its code. */
export interface FunctionFacts {
  inputs: FunctionInput[];
  output: FunctionOutput;
  /** What it changes or reaches outside itself: "changes this.items", "uses fs", "reads the current time". */
  effects: string[];
}

const squeeze = (code: string, max = 60) => {
  const line = code.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function functionFacts(fn: ts.FunctionLikeDeclaration, source: ts.SourceFile, checker?: ts.TypeChecker): FunctionFacts {
  const inputs = fn.parameters
    .filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
    .map((p) => ({
      name: squeeze(p.name.getText(source), 40),
      ...(p.type ? { type: squeeze(p.type.getText(source)) } : {}),
      ...(p.initializer ? { defaultValue: squeeze(p.initializer.getText(source), 30) } : {}),
      optional: !!p.questionToken || !!p.initializer,
      rest: !!p.dotDotDotToken,
    }));
  return { inputs, output: outputOf(fn, source), effects: checker ? effectsOf(fn, checker) : [] };
}

function outputOf(fn: ts.FunctionLikeDeclaration, source: ts.SourceFile): FunctionOutput {
  const isAsync = !!ts.getModifiers(fn as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  let type = fn.type?.getText(source);
  const promised = type ? /^Promise<([\s\S]+)>$/.exec(type) : null;
  if (promised) type = promised[1];
  const values: string[] = [];
  let bare = false;
  if (fn.body && !ts.isBlock(fn.body)) values.push(squeeze(fn.body.getText(source)));
  else if (fn.body) {
    const visit = (node: ts.Node): void => {
      // Returns of functions inside it are theirs, not its.
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression) values.push(squeeze(node.expression.getText(source)));
        else bare = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  }
  const distinct = [...new Set(values)];
  // A constructor makes the object; it returns nothing of its own.
  const nothing = ts.isConstructorDeclaration(fn) || type === 'void' || type === 'never' || (!type && distinct.length === 0);
  if (bare && distinct.length && !distinct.includes('undefined')) distinct.push('undefined');
  return { ...(type ? { type } : {}), later: isAsync || !!promised, values: nothing ? [] : distinct.slice(0, 4), nothing };
}

function effectsOf(fn: ts.FunctionLikeDeclaration, checker: ts.TypeChecker): string[] {
  if (!fn.body) return [];
  let found: string[] = [];
  try {
    found = new EffectAnalyzer(checker).effectsOf(fn as FunctionWithBody).map((e) => {
      // An effect inside a function it calls says which: "changes this.items (in add())".
      const callee = e.via?.fn;
      const name = callee && 'name' in callee && callee.name && ts.isIdentifier(callee.name) ? callee.name.text : undefined;
      return e.via ? `${e.via.effect.description}${name ? ` (in ${name}())` : ' (in a function it calls)'}` : e.description;
    });
  } catch {
    // The analysis failed: what the code shows on its face below.
  }
  const seen = [...new Set([...found.map(plainModule), ...outsideCalls(fn, checker, found)])];
  const unfollowed = callsForEffect(fn, seen);
  return [...seen.slice(0, unfollowed ? 7 : 8), ...(unfollowed ? [unfollowed] : [])];
}

/** Node's modules by what they reach: "uses node:fs" → "uses the file system (node:fs)". */
const MODULES: Record<string, string> = {
  fs: 'the file system',
  'fs/promises': 'the file system',
  path: 'file paths',
  os: 'the operating system',
  child_process: 'other programs',
  http: 'the network',
  https: 'the network',
  net: 'the network',
  crypto: 'cryptography',
  electron: 'Electron',
  vscode: 'the VS Code API',
};
function plainModule(description: string): string {
  const m = /^uses (node:)?([\w/]+)$/.exec(description);
  const what = m && MODULES[m[2]];
  return what ? `uses ${what} (${m[1] ?? ''}${m[2]})` : description;
}

/**
 * Calls made only for what they do, their result unused (`await saveOrder(id)`, `notifyCustomer(id)`), into code the
 * analysis could not follow: "calls saveOrder() and notifyCustomer(), which may change things".
 */
function callsForEffect(fn: ts.FunctionLikeDeclaration, known: string[]): string | undefined {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isExpressionStatement(node)) {
      let call: ts.Expression = node.expression;
      if (ts.isAwaitExpression(call) || ts.isVoidExpression(call)) call = call.expression;
      if (ts.isCallExpression(call)) {
        const callee = call.expression;
        let root: ts.Expression = callee;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        const name = callee.getText().replace(/\s+/g, '');
        const builtIn = ts.isIdentifier(root) && (root.text in builtIns || root.text === 'Math' || root.text === 'JSON' || root.text === 'Object');
        const changing = ts.isPropertyAccessExpression(callee) && changingMethods.has(callee.name.text);
        if (!builtIn && !changing && name.length <= 40 && !known.some((k) => k.includes(`${name.split('.').pop()}()`)) && !names.includes(`${name}()`)) names.push(`${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body && ts.isBlock(fn.body)) visit(fn.body);
  if (!names.length) return undefined;
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return `calls ${list} for what ${names.length > 1 ? 'they do' : 'it does'}, which may change things`;
}

/** Methods that change the object they are called on, whatever its type: `items.push(x)`, `cache.set(k, v)`. */
const changingMethods = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'set', 'delete', 'add', 'clear', 'append', 'remove']);

const builtIns: Record<string, string> = {
  console: 'writes to the console',
  fetch: 'makes a network request (fetch)',
  localStorage: 'uses localStorage',
  sessionStorage: 'uses sessionStorage',
  document: 'changes or reads the page (document)',
  window: 'uses window',
  process: 'uses the Node process',
  setTimeout: 'starts a timer',
  setInterval: 'starts a repeating timer',
  alert: 'shows an alert',
};

/**
 * Calls of changing methods on what the function does not own (this, a parameter, a module variable), for what the
 * analysis cannot type: one file on its own has no standard library to say that `items` is an array.
 */
function outsideCalls(fn: ts.FunctionLikeDeclaration, checker: ts.TypeChecker, known: string[]): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && changingMethods.has(node.expression.name.text)) {
      const receiver = node.expression.expression;
      let root: ts.Expression = receiver;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
      const target = receiver.getText().replace(/\s+/g, '');
      let outside = root.kind === ts.SyntaxKind.ThisKeyword;
      if (ts.isIdentifier(root)) {
        try {
          const declaration = checker.getSymbolAtLocation(root)?.declarations?.[0];
          // Declared outside the function (a module variable, a captured one) or one of its parameters.
          outside = !!declaration && (ts.isParameter(declaration) ? declaration.parent === fn : declaration.pos < fn.pos || declaration.end > fn.end);
        } catch {
          outside = false;
        }
      }
      const what = `changes ${target} (${node.expression.name.text})`;
      if (outside && !known.some((k) => k.includes(target)) && !out.includes(what)) out.push(what);
    }
    // The browser's and Node's own objects, which one file on its own cannot resolve.
    if (ts.isCallExpression(node)) {
      let root: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      const global = ts.isIdentifier(root) ? builtIns[root.text] : undefined;
      if (global && ts.isIdentifier(root) && !checker.getSymbolAtLocation(root)?.declarations?.length && !known.some((k) => k.includes(root.getText())) && !out.includes(global)) out.push(global);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** "the id (a string)", "the limit (a number, 10 when left out)", "any number of items". */
export function inputPhrase(input: FunctionInput): string {
  const details = [input.type ? typePhrase(input.type) : undefined, input.defaultValue ? `${input.defaultValue} when left out` : input.optional ? 'can be left out' : undefined].filter(Boolean);
  const named = input.rest ? `any number of ${input.name.replace(/^\.\.\./, '')}` : /^[{[]/.test(input.name) ? input.name : `the ${input.name}`;
  return details.length ? `${named} (${details.join(', ')})` : named;
}

/** "a Config", "string", "Item[]". */
export function typePhrase(type: string): string {
  return /^[A-Z]\w*$/.test(type) ? `${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}` : type;
}

/** "Gives back a Config, once it finishes: config or undefined." */
export function outputSentence(output: FunctionOutput): string {
  if (output.nothing) return output.later ? 'Gives back nothing; it can be awaited until it finishes.' : 'Gives back nothing.';
  const what = output.type ? typePhrase(output.type) : output.values.length === 1 ? output.values[0] : 'a value';
  const values = output.values.length > 1 || (output.type && output.values.length === 1) ? `: ${output.values.join(' or ')}` : '';
  return `Gives back ${what}${output.later ? ', once it finishes' : ''}${values}.`;
}
