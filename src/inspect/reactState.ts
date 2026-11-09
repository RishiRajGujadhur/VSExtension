import ts = require('typescript');
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportBuilder, ReportNode, lineSnippet, plural } from '../structure/report';
import { FunctionWithBody, enclosingFunction, forEachDescendant, functionAtOffset, functionLabel, functionNameNode, isFunctionWithBody } from '../structure/util';

/**
 * The state dependency graph of a React component or hook: its props and context on one side; its state, refs,
 * memoized values, callbacks, custom hooks and effects on the other, each with where it is set, read, rendered and
 * listed as a dependency. It answers "what re-runs or re-renders when this changes, and what changes it?"
 */
type Kind = 'prop' | 'context' | 'state' | 'ref' | 'memo' | 'callback' | 'custom';

interface Binding {
  kind: Kind;
  name: string;
  declaration: ts.Node;
  /** For state: the setter's name node. */
  setter?: ts.Identifier;
  /** For a memo or callback: its dependency array. */
  deps?: ts.ArrayLiteralExpression;
  /** The hook call that made it, and its name. */
  call?: ts.CallExpression;
  hook?: string;
}

interface Effect {
  call: ts.CallExpression;
  hook: string;
  body?: ts.Node;
  deps?: ts.ArrayLiteralExpression;
}

const hookName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name && /^use[A-Z0-9]/.test(name) ? name : undefined;
};

const kindOfHook: Record<string, Kind> = { useState: 'state', useReducer: 'state', useRef: 'ref', useMemo: 'memo', useCallback: 'callback', useContext: 'context' };
const effectHooks = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

const icons: Record<Kind, string> = {
  prop: 'symbol-property',
  context: 'symbol-namespace',
  state: 'symbol-variable',
  ref: 'symbol-reference',
  memo: 'symbol-constant',
  callback: 'symbol-method',
  custom: 'symbol-event',
};

export function reactStateReport(project: VirtualProject, fileName: string, offset: number): Report {
  const checker = project.program().getTypeChecker();
  const fn = functionAtOffset(project.sourceFile(fileName), offset, checker);
  const name = functionLabel(fn);
  const bindings: Binding[] = [];
  const effects: Effect[] = [];
  let returnsJsx = false;

  // Hooks are called at the top level of the component; JSX shows it is one.
  forEachDescendant(fn.body ?? fn, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) returnsJsx = true;
    if (!ts.isCallExpression(node) || enclosingFunction(node) !== fn) return;
    const hook = hookName(node);
    if (!hook) return;
    if (effectHooks.has(hook)) {
      const [body, deps] = node.arguments;
      effects.push({ call: node, hook, body, deps: deps && ts.isArrayLiteralExpression(deps) ? deps : undefined });
      return;
    }
    const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
    if (!declaration) return;
    const kind = kindOfHook[hook] ?? 'custom';
    const deps = (kind === 'memo' || kind === 'callback') && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) ? node.arguments[1] : undefined;
    if (ts.isArrayBindingPattern(declaration.name)) {
      // const [value, setValue] = useState(…)
      const [value, setter] = declaration.name.elements.map((e) => (ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name : undefined));
      if (value) bindings.push({ kind, name: value.text, declaration: value, setter: kind === 'state' ? setter : undefined, hook });
      else if (setter && kind === 'state') bindings.push({ kind, name: setter.text, declaration: setter, setter, hook });
      if (kind === 'custom') {
        declaration.name.elements.slice(1).forEach((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && bindings.push({ kind, name: e.name.text, declaration: e.name, hook }));
      }
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const e of declaration.name.elements) if (ts.isIdentifier(e.name)) bindings.push({ kind, name: e.name.text, declaration: e.name, hook });
    } else if (ts.isIdentifier(declaration.name)) {
      bindings.push({ kind, name: declaration.name.text, declaration: declaration.name, deps, hook, call: node });
    }
  });

  // Props: a destructured first parameter, or the names read from `props.x`.
  const props = fn.parameters[0];
  const propBindings: Binding[] = [];
  if (props) {
    if (ts.isObjectBindingPattern(props.name)) {
      for (const e of props.name.elements) if (ts.isIdentifier(e.name)) propBindings.push({ kind: 'prop', name: e.name.text, declaration: e.name });
    } else if (ts.isIdentifier(props.name) && /^[A-Z]/.test(name)) {
      const seen = new Set<string>();
      forEachDescendant(fn.body ?? fn, (node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === (props.name as ts.Identifier).text && !seen.has(node.name.text)) {
          seen.add(node.name.text);
          propBindings.push({ kind: 'prop', name: node.name.text, declaration: node.name });
        }
      });
    }
  }

  bindings.unshift(...propBindings);
  if (!bindings.length && !effects.length) {
    throw new AnalysisError(
      returnsJsx
        ? `${name} uses no props, state or hooks, so there are no state dependencies to show.`
        : 'Place the cursor in a React component or hook: a function that uses useState, useEffect or other hooks, or returns JSX.',
    );
  }

  const builder = new ReportBuilder('reactState', `React state of ${name}`);
  const symbolOf = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const where = (node: ts.Node): { label: string; kind: 'render' | 'effect' | 'handler' | 'deps'; effect?: Effect; owner?: ts.Node } => {
    for (const effect of effects) {
      if (effect.deps && node.pos >= effect.deps.pos && node.end <= effect.deps.end) return { label: `${effect.hook} (line ${lineOf(effect.call)})`, kind: 'deps', effect };
      if (effect.body && node.pos >= effect.body.pos && node.end <= effect.body.end) return { label: `${effect.hook} (line ${lineOf(effect.call)})`, kind: 'effect', effect };
    }
    for (const b of bindings) {
      if (b.deps && node.pos >= b.deps.pos && node.end <= b.deps.end) return { label: `${b.hook} ${b.name}`, kind: 'deps', owner: b.declaration };
      // Inside the function a useMemo or useCallback computes or keeps.
      const computed = b.call?.arguments[0];
      if (computed && node.pos >= computed.pos && node.end <= computed.end) return { label: `${b.hook} ${b.name}`, kind: 'handler' };
    }
    // Inside a handler or callback of the component: named by the function it is in.
    let inner = enclosingFunction(node);
    while (inner && inner !== fn && enclosingFunction(inner) !== fn) inner = enclosingFunction(inner);
    if (inner && inner !== fn) {
      const handler = functionNameNode(inner);
      const holder = ts.isVariableDeclaration(inner.parent) ? inner.parent.name : undefined;
      const inJsx = !handler && !holder && hasJsxAncestor(inner);
      return { label: inJsx ? `inline handler (line ${lineOf(inner)})` : `${(handler ?? holder)?.getText() ?? 'callback'} (line ${lineOf(inner)})`, kind: 'handler' };
    }
    return { label: hasJsxAncestor(node) ? `rendered (line ${lineOf(node)})` : `render body (line ${lineOf(node)})`, kind: 'render' };
  };

  // Every reference to each binding (and each setter) inside the component.
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  forEachDescendant(fn, (node) => {
    if (!ts.isIdentifier(node)) return;
    const symbol = symbolOf(node);
    if (symbol) references.set(symbol, [...(references.get(symbol) ?? []), node]);
  });
  const uses = (decl: ts.Node) => {
    const symbol = symbolOf(decl);
    return (symbol ? (references.get(symbol) ?? []) : []).filter((n) => n !== decl);
  };
  const propUses = (b: Binding) =>
    b.kind === 'prop' && ts.isPropertyAccessExpression(b.declaration.parent)
      ? collect(fn, (n) => ts.isPropertyAccessExpression(n) && n.name.text === b.name && ts.isIdentifier(n.expression) && !!props && n.expression.text === props.name.getText()).map((n) => (n as ts.PropertyAccessExpression).name)
      : uses(b.declaration);

  const row = (label: string, node: ts.Node, icon: string, description?: string): ReportNode => ({ label, description: description ?? lineSnippet(node, 60), icon, location: builder.at(node) });
  const usageRows = (nodes: ts.Node[], verb: string, icon: string): ReportNode[] => {
    const grouped = new Map<string, ts.Node[]>();
    for (const n of nodes) {
      const w = where(n).label;
      grouped.set(w, [...(grouped.get(w) ?? []), n]);
    }
    return [...grouped.entries()].map(([w, ns]) => row(`${verb} ${w}`, ns[0], icon, ns.length > 1 ? `${ns.length} times · ${lineSnippet(ns[0], 50)}` : undefined));
  };

  const bindingNode = (b: Binding): ReportNode => {
    const reads = (b.kind === 'prop' ? propUses(b) : uses(b.declaration)).filter((n) => !(b.setter && n === b.setter));
    const children: ReportNode[] = [];
    if (b.setter) {
      const sets = uses(b.setter).filter((n) => ts.isCallExpression(n.parent) && n.parent.expression === n);
      const passed = uses(b.setter).filter((n) => !(ts.isCallExpression(n.parent) && n.parent.expression === n));
      children.push(...usageRows(sets, 'set in', 'edit'));
      if (passed.length) children.push(...usageRows(passed, `${b.setter.text} passed in`, 'arrow-right'));
    }
    children.push(...usageRows(reads.filter((n) => where(n).kind === 'deps'), 'triggers', 'debug-rerun'));
    children.push(...usageRows(reads.filter((n) => where(n).kind !== 'deps'), 'read in', 'eye'));
    if (b.deps) {
      const names = b.deps.elements.map((e) => e.getText());
      const verb = b.kind === 'callback' ? 'recreated' : 'recomputed';
      children.unshift({ label: names.length ? `${verb} ${changes(names)}` : b.kind === 'callback' ? 'created once' : 'computed once', icon: 'debug-rerun', location: builder.at(b.deps) });
    }
    const describe: Record<Kind, string> = { prop: 'prop', context: 'context', state: b.hook ?? 'state', ref: 'useRef', memo: 'useMemo', callback: 'useCallback', custom: `${b.hook}()` };
    const unused = !reads.length && !children.length;
    return {
      label: b.name,
      description: `${describe[b.kind]}${b.setter && b.setter.text !== b.name ? ` · set with ${b.setter.text}` : ''}${unused ? ' · unused' : ''}`,
      icon: icons[b.kind],
      tone: unused ? 'warning' : undefined,
      location: builder.at(b.declaration),
      expanded: children.length <= 4,
      children,
    };
  };

  const effectNode = (effect: Effect): ReportNode => {
    const names = effect.deps?.elements.map((e) => e.getText());
    const when = !effect.deps ? 'after every render' : names!.length ? changes(names!) : 'once, after the first render';
    const children: ReportNode[] = [];
    const body = effect.body;
    if (body) {
      const reads = new Map<string, { node: ts.Node; binding: Binding }>();
      const sets = new Map<string, ts.Node>();
      for (const b of bindings) {
        for (const n of uses(b.declaration)) if (n.pos >= body.pos && n.end <= body.end && !reads.has(b.name)) reads.set(b.name, { node: n, binding: b });
        if (b.setter) for (const n of uses(b.setter)) if (n.pos >= body.pos && n.end <= body.end && !sets.has(b.name)) sets.set(b.name, n);
      }
      for (const [n, node] of sets) children.push(row(`sets ${n}`, node, 'edit'));
      // A value the effect reads but doesn't list as a dependency runs with a stale copy of it (refs excepted).
      const listed = new Set(names ?? []);
      for (const [n, { node, binding }] of reads) {
        const missing = !!names && !listed.has(n) && binding.kind !== 'ref';
        children.push(missing ? { ...row(`reads ${n}, missing from the dependencies`, node, 'warning'), tone: 'warning' } : row(`reads ${n}`, node, 'eye'));
      }
      const cleanup = isFunctionWithBody(body) && body.body && collect(body.body, (n) => ts.isReturnStatement(n) && !!n.expression && enclosingFunction(n) === body).length > 0;
      if (cleanup) children.push({ label: names && !names.length ? 'cleans up when the component unmounts' : 'cleans up before re-running and on unmount', icon: 'trash' });
    }
    return { label: `${effect.hook} (line ${lineOf(effect.call)})`, description: `runs ${when}`, icon: 'debug-rerun', location: builder.at(effect.call), expanded: true, children };
  };

  const group = (label: string, kinds: Kind[], icon: string): ReportNode | undefined => {
    const members = bindings.filter((b) => kinds.includes(b.kind));
    return members.length ? { label, description: plural(members.length, 'value'), icon, expanded: true, children: members.map(bindingNode) } : undefined;
  };
  const roots = [
    group('Props', ['prop'], 'symbol-property'),
    group('Context', ['context'], 'symbol-namespace'),
    group('State', ['state'], 'symbol-variable'),
    group('Refs', ['ref'], 'symbol-reference'),
    group('Memoized', ['memo', 'callback'], 'symbol-constant'),
    group('Custom hooks', ['custom'], 'symbol-event'),
    effects.length ? { label: 'Effects', description: plural(effects.length, 'effect'), icon: 'debug-rerun', expanded: true, children: effects.map(effectNode) } : undefined,
  ].filter((r): r is ReportNode => !!r);
  const count = (k: Kind) => bindings.filter((b) => b.kind === k).length;
  return builder.finish(roots, [plural(count('prop'), 'prop'), plural(count('state'), 'state value'), plural(effects.length, 'effect')].join(', '));
}

/** "when a changes", "when a, b change". */
function changes(names: string[]): string {
  return `when ${names.join(', ')} ${names.length === 1 ? 'changes' : 'change'}`;
}

function hasJsxAncestor(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ts.isJsxExpression(n)) return true;
    if (isFunctionWithBody(n)) return false;
  }
  return false;
}

function collect(root: ts.Node, test: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  forEachDescendant(root, (n) => test(n) && found.push(n));
  return found;
}

export type { FunctionWithBody };
