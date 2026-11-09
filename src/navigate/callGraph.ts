import ts = require('typescript');
import * as path from 'path';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';
import { FunctionWithBody, calledFunction, callSitesOf, enclosingFunction, forEachDescendant, functionAtOffset, functionLabel, functionNameNode, isFunctionWithBody } from '../structure/util';

/**
 * The call graph around a function, as a butterfly: who calls it (and who calls them) on one side, what it calls (and
 * what those call) on the other, a few levels deep. Calls are resolved with the type checker, so methods, imported
 * functions and functions passed through variables are followed; calls into libraries are counted, not followed.
 */
export interface CallGraphOptions {
  /** Levels of callers and callees, counting the direct ones as 1. */
  depth?: number;
  /** At most this many functions are listed at each step, the most called first. */
  maxPerLevel?: number;
}

interface Edge {
  fn: FunctionWithBody;
  /** The calls between the two functions, where they are written. */
  calls: ts.Node[];
  /** Calls made from inside a callback (an arrow function or function expression) rather than directly. */
  viaCallback: boolean;
}

const kindIcon = (fn: FunctionWithBody) => (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) || ts.isGetAccessor(fn) || ts.isSetAccessor(fn) ? 'symbol-method' : 'symbol-function');

/** The project functions a function calls, grouped by function, with the number of library calls. */
export function calleesOf(checker: ts.TypeChecker, fn: FunctionWithBody): { edges: Edge[]; library: Map<string, number> } {
  const byFn = new Map<FunctionWithBody, Edge>();
  const library = new Map<string, number>();
  if (!fn.body) return { edges: [], library };
  forEachDescendant(fn.body, (node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node) && !ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const target = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? jsxComponent(checker, node) : calledFunction(checker, node);
    const viaCallback = enclosingFunction(node) !== fn;
    if (!target) {
      // A call into a library or something that can't be resolved: counted by name.
      const callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : node.tagName;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
      if (name) library.set(name, (library.get(name) ?? 0) + 1);
      return;
    }
    const edge = byFn.get(target) ?? { fn: target, calls: [], viaCallback: true };
    edge.calls.push(node);
    edge.viaCallback &&= viaCallback;
    byFn.set(target, edge);
  });
  return { edges: [...byFn.values()], library };
}

/** The component a JSX element renders, when it is a function of the project. */
function jsxComponent(checker: ts.TypeChecker, element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): FunctionWithBody | undefined {
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
  const depth = Math.max(1, Math.min(5, options.depth ?? 3));
  const maxPerLevel = options.maxPerLevel ?? 25;
  const program = project.program();
  const checker = program.getTypeChecker();
  const root = functionAtOffset(project.sourceFile(fileName), offset, checker);
  const name = functionLabel(root);
  const builder = new ReportBuilder('callGraph', `Call graph of ${name}`);
  let shown = 0;
  let omitted = 0;
  const lines = (calls: ts.Node[]) => [...new Set(calls.map((c) => c.getSourceFile().getLineAndCharacterOfPosition(c.getStart()).line + 1))];
  const describe = (fn: FunctionWithBody, calls: ts.Node[], viaCallback: boolean) => {
    const where = `${path.basename(fn.getSourceFile().fileName)}:${fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1}`;
    return [where, calls.length > 1 ? `${calls.length} calls` : '', viaCallback ? 'in a callback' : ''].filter(Boolean).join(' · ');
  };
  const nodeFor = (fn: FunctionWithBody, edge: Edge, side: 'callers' | 'callees', level: number, chain: FunctionWithBody[]): ReportNode => {
    shown++;
    const callLines = lines(edge.calls);
    const recursive = chain.includes(fn);
    const node: ReportNode = {
      label: functionLabel(fn),
      description: describe(fn, edge.calls, edge.viaCallback) + (recursive ? ' · recursive' : ''),
      tooltip: `${side === 'callers' ? `Calls ${functionLabel(chain[chain.length - 1])}` : `Called by ${functionLabel(chain[chain.length - 1])}`} on line ${callLines.join(', ')}`,
      icon: recursive ? 'sync' : kindIcon(fn),
      location: builder.at(functionNameNode(fn) ?? fn),
      expanded: level < 2,
    };
    if (!recursive && level < depth) {
      const children = side === 'callers' ? callerNodes(fn, level + 1, [...chain, fn]) : calleeNodes(fn, level + 1, [...chain, fn]);
      if (children.length) node.children = children;
    }
    return node;
  };
  const limit = (edges: Edge[]) => {
    const sorted = [...edges].sort((a, b) => b.calls.length - a.calls.length || functionLabel(a.fn).localeCompare(functionLabel(b.fn)));
    omitted += Math.max(0, sorted.length - maxPerLevel);
    return sorted.slice(0, maxPerLevel);
  };
  function callerNodes(fn: FunctionWithBody, level: number, chain: FunctionWithBody[]): ReportNode[] {
    const { edges, modules } = callersOf(project.service, fn);
    const nodes = limit(edges).map((e) => nodeFor(e.fn, e, 'callers', level, chain));
    for (const [file, calls] of modules) {
      shown++;
      nodes.push({
        label: `${path.basename(file.fileName)} (module scope)`,
        description: `line ${lines(calls).join(', ')}`,
        icon: 'file-code',
        location: builder.at(calls[0]),
      });
    }
    return nodes;
  }
  function calleeNodes(fn: FunctionWithBody, level: number, chain: FunctionWithBody[]): ReportNode[] {
    const { edges, library } = calleesOf(checker, fn);
    const nodes = limit(edges).map((e) => nodeFor(e.fn, e, 'callees', level, chain));
    if (library.size && level === 1) {
      const names = [...library.entries()].sort((a, b) => b[1] - a[1]);
      const total = names.reduce((s, [, n]) => s + n, 0);
      nodes.push({
        label: plural(total, 'other call'),
        description: names.slice(0, 4).map(([n]) => n).join(', ') + (names.length > 4 ? '…' : ''),
        tooltip: `Calls into libraries, through interfaces or to values that can't be resolved:\n${names.map(([n, count]) => `${n}${count > 1 ? ` ×${count}` : ''}`).join('\n')}`,
        icon: 'library',
        tone: 'info',
      });
    }
    return nodes;
  }
  const callers = callerNodes(root, 1, [root]);
  const callees = calleeNodes(root, 1, [root]);
  if (omitted) builder.warnings.push(`${plural(omitted, 'function')} left out: only the ${maxPerLevel} most called are listed at each step.`);
  const directCallers = callers.length;
  const directCallees = callees.filter((n) => n.icon !== 'library').length;
  return builder.finish(
    [
      { label: 'Called by', description: directCallers ? plural(directCallers, 'caller') : 'nothing in the project calls it', icon: 'call-incoming', expanded: true, children: callers },
      { label: 'Calls', description: directCallees ? plural(directCallees, 'function') : 'no functions of the project', icon: 'call-outgoing', expanded: true, children: callees },
    ],
    `${plural(directCallers, 'caller')}, ${plural(directCallees, 'callee')}, ${depth} levels`,
  );
}
