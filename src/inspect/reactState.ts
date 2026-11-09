import ts = require('typescript');
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportBuilder, ReportNode, lineSnippet, plural } from '../structure/report';
import { FunctionWithBody, enclosingFunction, forEachDescendant, functionAtOffset, functionLabel, functionNameNode, isFunctionWithBody } from '../structure/util';
import { ReportControl } from '../structure/graphOptions';
import { jsxComponent } from '../navigate/callGraph';

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

export interface ReactStateOptions {
  /** Levels of child components shown under Renders: 0 is none, 1 the components it renders, 2 theirs too… */
  levels?: number;
}

export const reactStateLimits = { minLevels: 0, maxLevels: 3 };

export function reactStateReport(project: VirtualProject, fileName: string, offset: number, options: ReactStateOptions = {}): Report {
  const levels = Math.max(reactStateLimits.minLevels, Math.min(reactStateLimits.maxLevels, options.levels ?? 1));
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
      if (value) bindings.push({ kind, name: value.text, declaration: value, setter: kind === 'state' ? setter : undefined, hook, call: node });
      else if (setter && kind === 'state') bindings.push({ kind, name: setter.text, declaration: setter, setter, hook, call: node });
      if (kind === 'custom') {
        declaration.name.elements.slice(1).forEach((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && bindings.push({ kind, name: e.name.text, declaration: e.name, hook }));
      }
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const e of declaration.name.elements) if (ts.isIdentifier(e.name)) bindings.push({ kind, name: e.name.text, declaration: e.name, hook, call: node });
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
  const where = (node: ts.Node): { label: string; kind: 'render' | 'effect' | 'handler' | 'deps' | 'pass'; effect?: Effect; owner?: ts.Node } => {
    const passed = passedAs(node);
    if (passed) return { label: `<${passed.component} ${passed.prop}> (line ${lineOf(node)})`, kind: 'pass' };
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

  const findings = { warnings: 0, notes: 0 };
  const note = (node: ReportNode, tone: 'warning' | 'info' | 'error'): ReportNode => {
    if (tone === 'info') findings.notes++;
    else findings.warnings++;
    return { ...node, tone, icon: tone === 'info' ? 'info' : tone === 'error' ? 'error' : 'warning' };
  };
  const bindingNode = (b: Binding): ReportNode => {
    const reads = (b.kind === 'prop' ? propUses(b) : uses(b.declaration)).filter((n) => !(b.setter && n === b.setter));
    const children: ReportNode[] = [];
    // State without a setter can't change after the first render.
    let neverUpdated = b.kind === 'state' && !b.setter;
    if (b.setter) {
      const sets = uses(b.setter).filter((n) => ts.isCallExpression(n.parent) && n.parent.expression === n);
      const passed = uses(b.setter).filter((n) => !(ts.isCallExpression(n.parent) && n.parent.expression === n));
      if (b.hook === 'useReducer') {
        // dispatch({ type: 'add' }): which actions, from where.
        const byAction = new Map<string, ts.Node[]>();
        for (const n of sets) {
          const action = actionType((n.parent as ts.CallExpression).arguments[0]);
          const key = `dispatches ${action ? `'${action}' ` : ''}in ${where(n).label}`;
          byAction.set(key, [...(byAction.get(key) ?? []), n]);
        }
        for (const [label, ns] of byAction) children.push(row(label, ns[0], 'edit'));
      } else {
        children.push(...usageRows(sets.filter((n) => where(n).kind !== 'render'), 'set in', 'edit'));
      }
      // Setting state while rendering renders again, which sets it again…
      for (const n of sets.filter((s) => where(s).kind === 'render' && !hasJsxAncestor(s))) {
        children.push(note(row(`set during render (line ${lineOf(n)}): renders again, possibly forever`, n, 'error'), 'error'));
      }
      if (passed.length) children.push(...usageRows(passed, `${b.setter.text} passed to`, 'arrow-right'));
      neverUpdated = !sets.length && !passed.length;
    }
    children.push(...usageRows(reads.filter((n) => where(n).kind === 'deps'), 'triggers', 'debug-rerun'));
    children.push(...usageRows(reads.filter((n) => where(n).kind === 'pass'), 'passed to', 'arrow-right'));
    children.push(...usageRows(reads.filter((n) => where(n).kind !== 'deps' && where(n).kind !== 'pass'), 'read in', 'eye'));
    if (neverUpdated) children.push(note({ label: `never updated: ${b.name} could be a constant`, location: builder.at(b.declaration) }, 'info'));
    // useState(compute()) computes the initial value on every render; useState(() => compute()) only once.
    const initial = b.kind === 'state' && b.hook === 'useState' ? b.call?.arguments[0] : undefined;
    if (initial && (ts.isCallExpression(initial) || ts.isNewExpression(initial)) && !/^(Symbol|BigInt)$/.test(initial.expression.getText())) {
      children.push(note({ label: `initial value computed on every render: useState(() => ${shortText(initial)}) computes it once`, location: builder.at(initial) }, 'info'));
    }
    // ref.current read while rendering: changing it later won't re-render.
    if (b.kind === 'ref') {
      for (const n of reads.filter((r) => ts.isPropertyAccessExpression(r.parent) && r.parent.name.text === 'current' && where(r).kind === 'render' && !isRefAttribute(r))) {
        children.push(note(row(`${b.name}.current read during render (line ${lineOf(n)}): changing it won't re-render`, n, 'info'), 'info'));
      }
    }
    if (b.deps) {
      const names = b.deps.elements.map((e) => e.getText());
      const verb = b.kind === 'callback' ? 'recreated' : 'recomputed';
      children.unshift({ label: names.length ? `${verb} ${changes(names)}` : b.kind === 'callback' ? 'created once' : 'computed once', icon: 'debug-rerun', location: builder.at(b.deps) });
      children.push(...dependencyFindings(b.deps, b.call?.arguments[0], `${b.hook} ${b.name}`));
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
      // An effect that only copies other values into state: the value could be computed while rendering.
      const statements = isFunctionWithBody(body) && body.body && ts.isBlock(body.body) ? body.body.statements : undefined;
      const setters = new Set(bindings.filter((b) => b.setter).map((b) => b.setter!.text));
      if (names?.length && statements?.length && statements.every((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && setters.has(s.expression.expression.getText()))) {
        children.push(note({ label: 'only sets state from other values: it could be computed while rendering (or with useMemo)', location: builder.at(effect.call) }, 'info'));
      }
      if (effect.deps) children.push(...dependencyFindings(effect.deps, body, `${effect.hook} (line ${lineOf(effect.call)})`));
    }
    return { label: `${effect.hook} (line ${lineOf(effect.call)})`, description: `runs ${when}`, icon: 'debug-rerun', location: builder.at(effect.call), expanded: true, children };
  };

  /** Dependencies listed but not read, and dependencies that are new on every render. */
  function dependencyFindings(deps: ts.ArrayLiteralExpression, body: ts.Node | undefined, owner: string): ReportNode[] {
    const out: ReportNode[] = [];
    for (const dep of deps.elements) {
      const text = dep.getText();
      if (ts.isObjectLiteralExpression(dep) || ts.isArrayLiteralExpression(dep) || isFunctionWithBody(dep)) {
        out.push(note(row(`${shortText(dep)} is new on every render, so ${owner} runs every time`, dep, 'warning'), 'warning'));
        continue;
      }
      if (ts.isIdentifier(dep) && localFunctions.has(dep.text)) {
        out.push(note(row(`${dep.text} is a new function on every render, so ${owner} runs every time: wrap it in useCallback`, dep, 'warning'), 'warning'));
      }
      const root = text.split(/[.?[]/)[0];
      if (body && ts.isIdentifier(dep) && !collect(body, (n) => ts.isIdentifier(n) && n.text === root).length) {
        out.push(note(row(`lists ${text} but doesn't read it`, dep, 'info'), 'info'));
      }
    }
    return out;
  }

  // Functions made fresh on every render: declared in the component without useCallback.
  const localFunctions = new Set<string>();
  for (const statement of fn.body && ts.isBlock(fn.body) ? fn.body.statements : []) {
    if (ts.isFunctionDeclaration(statement) && statement.name) localFunctions.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && isFunctionWithBody(d.initializer)) localFunctions.add(d.name.text);
    }
  }

  // Child components it renders, with the props it gives each, down to the chosen number of levels.
  const rendersOf = (component: FunctionWithBody, level: number, chain: FunctionWithBody[]): ReportNode[] => {
    const byChild = new Map<FunctionWithBody, (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[]>();
    forEachDescendant(component.body ?? component, (n) => {
      if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
      const child = jsxComponent(checker, n);
      if (child && child !== component) byChild.set(child, [...(byChild.get(child) ?? []), n]);
    });
    return [...byChild.entries()].map(([child, elements]) => {
      const attributes = elements.flatMap((e) => e.attributes.properties.filter(ts.isJsxAttribute));
      const props = [...new Set(attributes.map((a) => a.name.getText()))];
      const recursive = chain.includes(child);
      const node: ReportNode = {
        label: `<${functionLabel(child)}>`,
        description: [`${child.getSourceFile().fileName.split(/[\\/]/).pop()}:${lineOf(child)}`, props.length ? `gets ${props.join(', ')}` : 'no props', elements.length > 1 ? `${elements.length} times` : '', recursive ? 'recursive' : ''].filter(Boolean).join(' · '),
        icon: 'symbol-class',
        location: builder.at(functionNameNode(child) ?? child),
        expanded: level < 2,
        children: attributes.map((a) => ({
          label: `${a.name.getText()} ← ${a.initializer ? shortText(ts.isJsxExpression(a.initializer) && a.initializer.expression ? a.initializer.expression : a.initializer) : 'true'}`,
          icon: 'arrow-right',
          location: builder.at(a),
        })),
      };
      if (!recursive && level < levels) {
        const deeper = rendersOf(child, level + 1, [...chain, child]);
        if (deeper.length) node.children!.push({ label: 'Renders', description: plural(deeper.length, 'component'), icon: 'symbol-class', expanded: false, children: deeper });
      }
      return node;
    });
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
  if (levels > 0) {
    const renders = rendersOf(fn, 1, [fn]);
    if (renders.length) roots.push({ label: 'Renders', description: plural(renders.length, 'component'), icon: 'symbol-class', expanded: true, children: renders });
  }
  const count = (k: Kind) => bindings.filter((b) => b.kind === k).length;
  const found = [findings.warnings ? plural(findings.warnings, 'warning') : '', findings.notes ? plural(findings.notes, 'note') : ''].filter(Boolean);
  const report = builder.finish(roots, [plural(count('prop'), 'prop'), plural(count('state'), 'state value'), plural(effects.length, 'effect'), ...found].join(', '));
  report.subject = builder.at(functionNameNode(fn) ?? fn);
  report.controls = reactStateControls(levels);
  return report;
}

/** The chart's control for how many levels of child components it shows. */
export function reactStateControls(levels: number): ReportControl[] {
  return [
    { id: 'levels', label: 'Child levels', description: 'How many levels of child components to show under Renders: 0 is none', kind: 'levels', value: levels, min: reactStateLimits.minLevels, max: reactStateLimits.maxLevels },
  ];
}

/** The component and prop a value is passed to, when it sits in a JSX attribute of a component (capitalized). */
function passedAs(node: ts.Node): { component: string; prop: string } | undefined {
  for (let n: ts.Node | undefined = node.parent; n && !isFunctionWithBody(n); n = n.parent) {
    if (ts.isJsxAttribute(n)) {
      const element = n.parent.parent;
      const tag = element.tagName.getText();
      return /^[A-Z]/.test(tag) ? { component: tag, prop: n.name.getText() } : undefined;
    }
  }
  return undefined;
}

/** ref={timer}: handing the ref to an element isn't reading it. */
function isRefAttribute(node: ts.Node): boolean {
  return !!passedAs(node) || (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === 'ref');
}

/** The action type of dispatch({ type: 'add' }) or dispatch('add'). */
function actionType(arg: ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    const type = arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'type');
    if (type && ts.isStringLiteralLike(type.initializer)) return type.initializer.text;
  }
  return undefined;
}

function shortText(node: ts.Node, max = 40): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
