import ts = require('typescript');
import * as path from 'path';
import { normalizePath } from '../analysis/paths';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportControl } from '../structure/graphOptions';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';
import { FunctionWithBody, calledFunction, callSitesOf, enclosingFunction, forEachDescendant, functionAtOffset, functionLabel, functionNameNode, functionOfDeclaration, isFunctionWithBody } from '../structure/util';

/**
 * The call graph around a function, as a butterfly: who calls it (and who calls them) on one side, what it calls (and
 * what those call) on the other, as many levels deep as asked. Calls are resolved with the type checker, so methods,
 * imported functions, JSX components and functions passed through variables are followed; a call through an
 * interface or abstract method leads to its implementations; calls into libraries are counted, not followed.
 */
export type CallDirection = 'both' | 'callers' | 'callees';

export interface CallGraphOptions {
  /** Levels of callers and callees, counting the direct ones as 1. */
  depth?: number;
  /** Which side to draw. */
  direction?: CallDirection;
  /** At most this many functions are listed at each step, the most called first. */
  maxPerLevel?: number;
}

export const callGraphLimits = { minDepth: 1, maxDepth: 5 };

interface Edge {
  fn: FunctionWithBody;
  /** The calls between the two functions, where they are written. */
  calls: ts.Node[];
  /** Calls made from inside a callback (an arrow function or function expression) rather than directly. */
  viaCallback: boolean;
  /** Reached through an interface or abstract method: one of the implementations that may run. */
  viaInterface?: boolean;
}

const kindIcon = (fn: FunctionWithBody) => (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) || ts.isGetAccessor(fn) || ts.isSetAccessor(fn) ? 'symbol-method' : 'symbol-function');
const isTestFile = (file: string) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]/.test(file);
const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** Whether a function is exported from its module (directly, or as a member of an exported class). */
function isExported(fn: FunctionWithBody): boolean {
  const declaration = ts.isVariableDeclaration(fn.parent) ? fn.parent.parent.parent : ts.isClassLike(fn.parent) ? fn.parent : fn;
  return !!(ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Export) || ts.isExportAssignment(fn.parent);
}

/** async, generator: what kind of function it is, in a word or two. */
function traits(fn: FunctionWithBody): string[] {
  const out: string[] = [];
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) out.push('async');
  if ('asteriskToken' in fn && fn.asteriskToken) out.push('generator');
  return out;
}

/** The callee's symbol declares it only in declaration files: a library call, settled without resolving overloads. */
function isLibraryCall(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): boolean {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
  if (!name) return false;
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return !!symbol?.declarations?.length && symbol.declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/** The implementations a call through an interface or abstract method may run. */
function implementationsOf(service: ts.LanguageService, checker: ts.TypeChecker, call: ts.CallExpression): FunctionWithBody[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const name = call.expression.name;
  const symbol = checker.getSymbolAtLocation(name);
  const abstract = symbol?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile && (ts.isMethodSignature(d) || ts.isPropertySignature(d) || (ts.isMethodDeclaration(d) && !d.body)));
  if (!abstract) return [];
  const file = name.getSourceFile();
  const found: FunctionWithBody[] = [];
  for (const impl of service.getImplementationAtPosition(file.fileName, name.getStart()) ?? []) {
    const program = service.getProgram();
    const sf = program?.getSourceFile(impl.fileName);
    if (!sf || sf.isDeclarationFile) continue;
    let node: ts.Node | undefined = findInnermost(sf, impl.textSpan.start);
    while (node && !isFunctionWithBody(node) && !ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node)) node = node.parent;
    const fn = node && (isFunctionWithBody(node) ? node : functionOfDeclaration(node));
    if (fn && fn.body && !found.includes(fn)) found.push(fn);
  }
  return found;
}

function findInnermost(sf: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (position >= node.getStart(sf) && position < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return found;
}

/** The project functions a function calls, grouped by function in the order they are first called, with the other calls counted by name. */
export function calleesOf(checker: ts.TypeChecker, fn: FunctionWithBody, service?: ts.LanguageService): { edges: Edge[]; library: Map<string, number> } {
  const byFn = new Map<FunctionWithBody, Edge>();
  const library = new Map<string, number>();
  if (!fn.body) return { edges: [], library };
  const add = (target: FunctionWithBody, node: ts.Node, viaCallback: boolean, viaInterface = false) => {
    const edge = byFn.get(target) ?? { fn: target, calls: [], viaCallback: true, viaInterface };
    edge.calls.push(node);
    edge.viaCallback &&= viaCallback;
    byFn.set(target, edge);
  };
  forEachDescendant(fn.body, (node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node) && !ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const viaCallback = enclosingFunction(node) !== fn;
    const isJsx = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
    const target = isJsx ? jsxComponent(checker, node) : isLibraryCall(checker, node) ? undefined : calledFunction(checker, node);
    if (target) return add(target, node, viaCallback);
    // Through an interface or abstract method: each implementation may run.
    const impls = service && ts.isCallExpression(node) ? implementationsOf(service, checker, node) : [];
    if (impls.length) return impls.forEach((impl) => add(impl, node, viaCallback, true));
    if (isJsx) return;
    const callee = node.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    if (name) library.set(name, (library.get(name) ?? 0) + 1);
  });
  return { edges: [...byFn.values()], library };
}

/** The component a JSX element renders, when it is a function of the project. */
export function jsxComponent(checker: ts.TypeChecker, element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): FunctionWithBody | undefined {
  if (!ts.isIdentifier(element.tagName) || !/^[A-Z]/.test(element.tagName.text)) return undefined;
  let symbol = checker.getSymbolAtLocation(element.tagName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const d of symbol?.declarations ?? []) {
    if (d.getSourceFile().isDeclarationFile) continue;
    if (isFunctionWithBody(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer && isFunctionWithBody(d.initializer)) return d.initializer;
  }
  return undefined;
}

/** The functions (or modules, for top-level code) that call a function, grouped by caller. */
export function callersOf(service: ts.LanguageService, fn: FunctionWithBody): { edges: Edge[]; modules: Map<ts.SourceFile, ts.Node[]> } {
  const byFn = new Map<FunctionWithBody, Edge>();
  const modules = new Map<ts.SourceFile, ts.Node[]>();
  for (const { call } of callSitesOf(service, fn).calls) {
    let caller = enclosingFunction(call);
    let viaCallback = false;
    // A call inside a callback belongs to the function that set the callback up.
    while (caller && !functionNameNode(caller) && (ts.isArrowFunction(caller) || ts.isFunctionExpression(caller)) && enclosingFunction(caller)) {
      caller = enclosingFunction(caller);
      viaCallback = true;
    }
    if (!caller) {
      const file = call.getSourceFile();
      modules.set(file, [...(modules.get(file) ?? []), call]);
      continue;
    }
    const edge = byFn.get(caller) ?? { fn: caller, calls: [], viaCallback: true };
    edge.calls.push(call);
    edge.viaCallback &&= viaCallback;
    byFn.set(caller, edge);
  }
  return { edges: [...byFn.values()], modules };
}

export function callGraphReport(project: VirtualProject, fileName: string, offset: number, options: CallGraphOptions = {}): Report {
  const depth = Math.max(callGraphLimits.minDepth, Math.min(callGraphLimits.maxDepth, options.depth ?? 3));
  const direction = options.direction ?? 'both';
  const maxPerLevel = options.maxPerLevel ?? 25;
  const program = project.program();
  const checker = program.getTypeChecker();
  const service = project.service;
  const root = functionAtOffset(project.sourceFile(fileName), offset, checker);
  const name = functionLabel(root);
  const builder = new ReportBuilder('callGraph', `Call graph of ${name}`);
  let omitted = 0;
  // Each function's callers and callees are looked up once, however often it appears.
  const callerCache = new Map<FunctionWithBody, ReturnType<typeof callersOf>>();
  const calleeCache = new Map<FunctionWithBody, ReturnType<typeof calleesOf>>();
  const callersCached = (fn: FunctionWithBody) => callerCache.get(fn) ?? callerCache.set(fn, callersOf(service, fn)).get(fn)!;
  const calleesCached = (fn: FunctionWithBody) => calleeCache.get(fn) ?? calleeCache.set(fn, calleesOf(checker, fn, service)).get(fn)!;
  // A function already drawn on this side isn't drawn again below it: it says "shown above".
  const drawn = { callers: new Set<FunctionWithBody>([root]), callees: new Set<FunctionWithBody>([root]) };
  const tests = new Set<string>();
  const files = { callers: new Set<string>(), callees: new Set<string>() };

  const lines = (calls: ts.Node[]) => [...new Set(calls.map(lineOf))];
  const nodeFor = (edge: Edge, side: 'callers' | 'callees', level: number, chain: FunctionWithBody[]): ReportNode => {
    const fn = edge.fn;
    const file = fn.getSourceFile().fileName;
    files[side].add(normalizePath(file));
    const recursive = chain.includes(fn);
    const repeated = !recursive && drawn[side].has(fn);
    drawn[side].add(fn);
    const test = side === 'callers' && isTestFile(file);
    if (test) tests.add(functionLabel(fn));
    const callLines = lines(edge.calls);
    // Where the call is written: in the caller's file for callers, in the function above for callees.
    const at = `${side === 'callers' ? 'calls at' : 'called at'} line ${callLines.slice(0, 3).join(', ')}${callLines.length > 3 ? '…' : ''}`;
    const description = [
      `${path.basename(file)}:${lineOf(fn)}`,
      at,
      edge.calls.length > 1 ? `${edge.calls.length} calls` : '',
      edge.viaCallback ? 'in a callback' : '',
      edge.viaInterface ? 'implementation' : '',
      ...traits(fn),
      test ? 'test' : '',
      recursive ? 'recursive' : repeated ? 'shown above' : '',
    ].filter(Boolean);
    const node: ReportNode = {
      label: functionLabel(fn),
      description: description.join(' · '),
      tooltip: `${side === 'callers' ? `Calls ${functionLabel(chain[chain.length - 1])}` : `Called by ${functionLabel(chain[chain.length - 1])}`} on line ${callLines.join(', ')}${edge.viaInterface ? '\nReached through an interface or abstract method: this implementation may run.' : ''}`,
      icon: recursive ? 'sync' : test ? 'beaker' : edge.viaInterface ? 'symbol-interface' : kindIcon(fn),
      location: builder.at(functionNameNode(fn) ?? fn),
      expanded: level < 2,
    };
    if (!recursive && !repeated && level < depth) {
      const children = side === 'callers' ? callerNodes(fn, level + 1, [...chain, fn]) : calleeNodes(fn, level + 1, [...chain, fn]);
      if (children.length) node.children = children;
      else if (side === 'callers') {
        // The top of a chain: nothing in the project calls it.
        node.description += isExported(fn) ? ' · entry point (exported)' : ' · entry point';
      }
    }
    return node;
  };
  const limit = (edges: Edge[], order: 'calls' | 'source') => {
    const sorted = order === 'source' ? [...edges].sort((a, b) => a.calls[0].getStart() - b.calls[0].getStart()) : [...edges].sort((a, b) => b.calls.length - a.calls.length || functionLabel(a.fn).localeCompare(functionLabel(b.fn)));
    omitted += Math.max(0, sorted.length - maxPerLevel);
    return sorted.slice(0, maxPerLevel);
  };
  function callerNodes(fn: FunctionWithBody, level: number, chain: FunctionWithBody[]): ReportNode[] {
    const { edges, modules } = callersCached(fn);
    const nodes = limit(edges, 'calls').map((e) => nodeFor(e, 'callers', level, chain));
    for (const [file, calls] of modules) {
      files.callers.add(normalizePath(file.fileName));
      nodes.push({
        label: `${path.basename(file.fileName)} (module scope)`,
        description: `top-level code · line ${lines(calls).join(', ')}${isTestFile(file.fileName) ? ' · test' : ''}`,
        icon: isTestFile(file.fileName) ? 'beaker' : 'file-code',
        location: builder.at(calls[0]),
      });
    }
    return nodes;
  }
  function calleeNodes(fn: FunctionWithBody, level: number, chain: FunctionWithBody[]): ReportNode[] {
    const { edges, library } = calleesCached(fn);
    // In the order they are called: reading the callees reads the function.
    const nodes = limit(edges, 'source').map((e) => nodeFor(e, 'callees', level, chain));
    if (library.size && level === 1) {
      const names = [...library.entries()].sort((a, b) => b[1] - a[1]);
      const total = names.reduce((s, [, n]) => s + n, 0);
      nodes.push({
        label: plural(total, 'other call'),
        description: names.slice(0, 4).map(([n]) => n).join(', ') + (names.length > 4 ? '…' : ''),
        tooltip: `Calls into libraries, through interfaces without implementations here, or to values that can't be resolved:\n${names.map(([n, count]) => `${n}${count > 1 ? ` ×${count}` : ''}`).join('\n')}`,
        icon: 'library',
        tone: 'info',
      });
    }
    return nodes;
  }

  const roots: ReportNode[] = [];
  let summary: string[] = [];
  if (direction !== 'callees') {
    const callers = callerNodes(root, 1, [root]);
    const direct = callers.length;
    const nobody = direct === 0;
    const testNote = tests.size ? `, ${plural(tests.size, 'test')}` : '';
    roots.push({
      label: 'Called by',
      description: nobody ? (isExported(root) ? 'nothing in the project calls it; it is exported, so it may be called from outside' : 'nothing in the project calls it') : `${plural(direct, 'caller')} in ${plural(files.callers.size, 'file')}${testNote}`,
      icon: 'call-incoming',
      tone: nobody && !isExported(root) ? 'warning' : undefined,
      expanded: true,
      children: callers,
    });
    summary.push(plural(direct, 'caller'));
  }
  if (direction !== 'callers') {
    const callees = calleeNodes(root, 1, [root]);
    const direct = callees.filter((n) => n.icon !== 'library').length;
    roots.push({ label: 'Calls', description: direct ? `${plural(direct, 'function')} in ${plural(files.callees.size, 'file')}` : 'no functions of the project', icon: 'call-outgoing', expanded: true, children: callees });
    summary.push(plural(direct, 'callee'));
  }
  if (omitted) builder.warnings.push(`${plural(omitted, 'function')} left out: only the ${maxPerLevel} most called are listed at each step.`);
  summary = [...summary, plural(depth, 'level')];
  const report = builder.finish(roots, summary.join(', '));
  report.subject = builder.at(functionNameNode(root) ?? root);
  report.controls = callGraphControls(depth, direction);
  return report;
}

/** The chart's Levels and Show controls for a call graph. */
export function callGraphControls(depth: number, direction: CallDirection): ReportControl[] {
  return [
    { id: 'levels', label: 'Levels', description: 'How many levels of callers and callees: 1 is only the direct ones', kind: 'levels', value: depth, min: callGraphLimits.minDepth, max: callGraphLimits.maxDepth },
    {
      id: 'direction',
      label: 'Show',
      description: 'Callers, callees or both',
      kind: 'choice',
      value: direction,
      choices: [
        { id: 'callers', label: 'Callers' },
        { id: 'both', label: 'Both' },
        { id: 'callees', label: 'Callees' },
      ],
    },
  ];
}
