import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { CallDirection, callGraphControls } from '../navigate/callGraph';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import { isTestPath } from '../structure/usageReport';
import { csharpFunctionAt, functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';
import { classifyCSharpUsage } from './usageKind';

/**
 * The chart analyses for C#, from the bundled parser: Data flow, Error paths, Task errors (Promise rejections),
 * Changes to this variable, Arguments passed in, Override reach, Who imports this, and Callers and calls and the
 * Family tree for when no language server answers. The parser sees syntax, not types, so names are matched as text
 * across the workspace's C# files; each report says so where it matters. The reports have the shapes of the
 * TypeScript ones, so the results view, the card and the charts draw them the same way.
 */

export interface CSharpSource {
  file: string;
  text: string;
}

interface Parsed {
  file: string;
  text: string;
  lines: string[];
  tree: Tree;
}

const typeDeclarations = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration']);
const memberDeclarations = new Set(['method_declaration', 'constructor_declaration', 'property_declaration', 'local_function_statement', 'event_declaration']);

/** Parses the files that mention the word (all of them without one), runs `work`, and frees the trees. */
async function withParsed<T>(sources: CSharpSource[], word: string | undefined, work: (files: Parsed[]) => T): Promise<T> {
  const pattern = word ? new RegExp(`(^|[^\\w@])@?${word.replace(/\W/g, '')}(?!\\w)`) : undefined;
  const files: Parsed[] = [];
  try {
    for (const s of sources) {
      if (pattern && !pattern.test(s.text)) continue;
      files.push({ file: s.file, text: s.text, lines: s.text.split(/\r?\n/), tree: await parseCSharp(s.text) });
    }
    return work(files);
  } finally {
    for (const f of files) f.tree.delete();
  }
}

const all = (root: SyntaxNode, type: string): SyntaxNode[] => root.descendantsOfType(type).filter((n): n is SyntaxNode => !!n);
const kids = (n: SyntaxNode): SyntaxNode[] => n.namedChildren.filter((c): c is SyntaxNode => !!c);
const where = (f: Parsed, n: SyntaxNode): ReportLocation => ({ file: f.file, line: n.startPosition.row, character: n.startPosition.column, endLine: n.endPosition.row, endCharacter: n.endPosition.column });
const lineOf = (f: Parsed, n: SyntaxNode) => {
  const t = (f.lines[n.startPosition.row] ?? '').trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
};
const oneLine = (text: string, max = 70) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const base = (file: string) => file.split(/[\\/]/).pop() ?? file;
const place = (f: Parsed, n: SyntaxNode) => `${base(f.file)}:${n.startPosition.row + 1}`;

/** The method, accessor, constructor or lambda around a node. */
function enclosingFunction(n: SyntaxNode): SyntaxNode | undefined {
  for (let p = n.parent; p; p = p.parent) if (functionTypes.has(p.type) || p.type === 'property_declaration') return p;
  return undefined;
}
const functionLabel = (n: SyntaxNode) => {
  const fn = enclosingFunction(n);
  return fn ? functionName(fn) : 'class level';
};
/** The type a node is in. */
function enclosingType(n: SyntaxNode): SyntaxNode | undefined {
  for (let p: SyntaxNode | null = n; p; p = p.parent) if (typeDeclarations.has(p.type)) return p;
  return undefined;
}

/** The identifier at an offset (or just after the cursor's word). */
function identifierAt(f: Parsed, offset: number): SyntaxNode {
  let n: SyntaxNode | null = f.tree.rootNode.descendantForIndex(offset);
  if (n && n.type !== 'identifier') n = f.tree.rootNode.descendantForIndex(Math.max(0, offset - 1));
  if (!n || n.type !== 'identifier') throw new AnalysisError('Put the cursor on a name: a variable, parameter, field, property, method or type.');
  return n;
}

/** The file being analysed, parsed with the rest. */
const here = (files: Parsed[], file: string) => {
  const f = files.find((x) => x.file === file);
  if (!f) throw new AnalysisError('Open a C# file and put the cursor in it.');
  return f;
};

/** Report frame shared by every chart. */
function report(kind: string, title: string, description: string, roots: ReportNode[], files: Parsed[], warnings: string[] = []): Report {
  const hashes: Record<string, string> = {};
  const used = new Set<string>();
  const visit = (rows: ReportNode[]) => rows.forEach((r) => { if (r.location) used.add(r.location.file); visit(r.children ?? []); });
  visit(roots);
  for (const f of files) if (used.has(f.file)) hashes[f.file] = hashText(f.text);
  return { kind, title, description, roots, warnings, fileHashes: hashes };
}

const byName = 'Matched by name (the bundled C# parser sees syntax, not types): other symbols with the same name are included.';

// ---------------------------------------------------------------- Data flow

/** Where a variable's values come from and where they go, in its method (or its class, for a field or property). */
export async function csharpDataFlow(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  const text = sources.find((s) => s.file === file)?.text ?? '';
  const probe = await withParsed([{ file, text }], undefined, (files) => identifierAt(here(files, file), offset).text);
  return withParsed(sources, probe, (files) => {
    const f = here(files, file);
    const id = identifierAt(f, offset);
    const name = id.text;
    const fn = enclosingFunction(id);
    // A local or a parameter lives in its method; anything else (field, property) in its class, by name in every file.
    const local = !!fn && [...all(fn, 'variable_declarator'), ...all(fn, 'parameter'), ...all(fn, 'foreach_statement'), ...all(fn, 'catch_declaration')].some((d) => (d.childForFieldName('name') ?? d.childForFieldName('left'))?.text === name);
    const scopes: { f: Parsed; root: SyntaxNode }[] = local ? [{ f, root: fn! }] : files.map((x) => ({ f: x, root: x.tree.rootNode }));
    const flowsIn: ReportNode[] = [];
    const flowsOut: ReportNode[] = [];
    const seenOut = new Set<string>();
    for (const { f: file, root } of scopes) {
      for (const n of all(root, 'identifier')) {
        if (n.text !== name) continue;
        const parent = n.parent!;
        const row = (label: string, description: string, role: ReportNode['role'], icon: string): ReportNode => ({
          label,
          description: `${description} · ${functionLabel(n)} · ${place(file, n)}`,
          role,
          icon,
          location: where(file, n),
          focus: file === f && n.startIndex <= offset && offset <= n.endIndex ? true : undefined,
        });
        const declared = parent.childForFieldName('name')?.id === n.id;
        if (declared && parent.type === 'variable_declarator') {
          const value = kids(parent).find((c) => c.id !== n.id);
          flowsIn.push(row(value ? `= ${oneLine(value.text)}` : `declared without a value`, 'declaration', 'definition', 'symbol-variable'));
          continue;
        }
        if (declared && parent.type === 'parameter') {
          flowsIn.push(row(`parameter ${oneLine(parent.text)}`, 'from each caller (Arguments passed in shows what they pass)', 'definition', 'symbol-parameter'));
          continue;
        }
        if (declared && (parent.type === 'property_declaration' || parent.type === 'field_declaration')) {
          flowsIn.push(row(oneLine(lineOf(file, n)), 'declaration', 'definition', 'symbol-field'));
          continue;
        }
        if (declared) continue;
        // Not the name of something else: obj.name is name only when obj is this.
        const member = parent.type === 'member_access_expression' && parent.childForFieldName('name')?.id === n.id;
        if (member && parent.childForFieldName('expression')?.type !== 'this_expression' && local) continue;
        const subject = member ? parent : n;
        const assignment = subject.parent?.type === 'assignment_expression' && subject.parent.childForFieldName('left')?.id === subject.id ? subject.parent : undefined;
        if (assignment) {
          const right = assignment.childForFieldName('right');
          const operator = assignment.text.slice(subject.endIndex - assignment.startIndex, (right?.startIndex ?? assignment.endIndex) - assignment.startIndex).trim();
          flowsIn.push(row(`${operator} ${oneLine(right?.text ?? '')}`, operator === '=' ? 'assigned' : 'updated', 'write', 'edit'));
          continue;
        }
        const usage = classifyCSharpUsage(file.lines[n.startPosition.row] ?? '', n.startPosition.column, n.endPosition.column);
        if (usage === 'write') {
          flowsIn.push(row(oneLine(lineOf(file, n)), 'changed', 'write', 'edit'));
          continue;
        }
        // Where the value goes: into a call, back to the caller, into another variable, or into a decision.
        let label = oneLine(lineOf(file, n));
        let what = 'read';
        let icon = 'eye';
        for (let p: SyntaxNode | null = subject.parent; p && !functionTypes.has(p.type); p = p.parent) {
          if (p.type === 'argument') {
            const call = p.parent?.parent;
            const callee = call?.type === 'invocation_expression' ? call.childForFieldName('function') : call?.type === 'object_creation_expression' ? call.childForFieldName('type') : undefined;
            label = `${oneLine(callee?.text ?? 'a call', 40)}(… ${name} …)`;
            what = 'passed to a call';
            icon = 'symbol-method';
            break;
          }
          if (p.type === 'return_statement' || p.type === 'arrow_expression_clause') {
            label = `return ${oneLine(kids(p)[0]?.text ?? name)}`;
            what = 'returned';
            icon = 'reply';
            break;
          }
          if (p.type === 'variable_declarator') {
            label = `${p.childForFieldName('name')?.text ?? '?'} = ${oneLine(kids(p).slice(1).map((c) => c.text).join(' '))}`;
            what = 'into another variable';
            icon = 'arrow-right';
            break;
          }
          if (p.type === 'assignment_expression') {
            label = oneLine(p.text);
            what = 'into an assignment';
            icon = 'arrow-right';
            break;
          }
          if (['if_statement', 'while_statement', 'do_statement', 'for_statement', 'switch_statement', 'conditional_expression'].includes(p.type)) {
            label = oneLine(p.childForFieldName('condition')?.text ?? p.childForFieldName('value')?.text ?? lineOf(file, n));
            what = 'decides a branch';
            icon = 'git-branch';
            break;
          }
          if (p.type.endsWith('_statement')) break;
        }
        // The name twice in one place (attempts == attempts) is one place the value goes.
        const key = `${label}|${what}|${place(file, n)}`;
        if (seenOut.has(key)) continue;
        seenOut.add(key);
        flowsOut.push(row(label, what, 'read', icon));
      }
    }
    if (!flowsIn.length && !flowsOut.length) throw new AnalysisError(`No ${name} found here.`);
    return report(
      'dataFlow',
      `Data flow of ${name}`,
      `${plural(flowsIn.length, 'source')} of the value, ${plural(flowsOut.length, 'place')} it goes${local ? ` in ${functionName(fn!)}` : ''}`,
      [
        { label: 'Flows in', description: `${plural(flowsIn.length, 'source')}`, icon: 'arrow-right', expanded: true, children: flowsIn },
        { label: 'Flows out', description: `${plural(flowsOut.length, 'place')}`, icon: 'arrow-right', expanded: true, children: flowsOut },
      ],
      files,
      local ? [] : [byName],
    );
  });
}

// ---------------------------------------------------------------- Changes to this variable

export async function csharpVariableChanges(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  const flow = await csharpDataFlow(sources, file, offset);
  const writes = flow.roots[0].children ?? [];
  // By method, as the TypeScript chart groups them.
  const byFunction = new Map<string, ReportNode[]>();
  for (const w of writes) {
    const fn = w.description?.split(' · ').slice(-2, -1)[0] ?? 'class level';
    byFunction.set(fn, [...(byFunction.get(fn) ?? []), w]);
  }
  const name = flow.title.replace(/^Data flow of /, '');
  return {
    ...flow,
    kind: 'variableMutations',
    title: `Mutations of ${name}`,
    description: `${plural(writes.length, 'change')} in ${plural(byFunction.size, 'function')}`,
    roots: [...byFunction].map(([fn, rows]) => ({ label: fn, description: plural(rows.length, 'change'), icon: 'symbol-method', expanded: true, children: rows })),
  };
}

// ---------------------------------------------------------------- Error paths

/** What the method at the cursor throws, what its calls throw, and where each is caught or escapes. */
export async function csharpErrorPaths(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  return withParsed(sources, undefined, (files) => {
    const f = here(files, file);
    const fn = csharpFunctionAt(f.tree.rootNode, offset);
    if (!fn) throw new AnalysisError('Put the cursor inside a C# method.');
    const name = functionName(fn);
    /** The catch clauses around a node, inside its own method, innermost first. */
    const catchesAround = (n: SyntaxNode): SyntaxNode[] => {
      const out: SyntaxNode[] = [];
      for (let p = n.parent; p && !functionTypes.has(p.type); p = p.parent) {
        // Only when the node is in the try block, not in a catch or finally.
        if (p.type === 'try_statement' && n.startIndex < (kids(p).find((c) => c.type === 'block')?.endIndex ?? 0)) out.push(...kids(p).filter((c) => c.type === 'catch_clause'));
      }
      return out;
    };
    const thrownType = (t: SyntaxNode) => {
      const value = kids(t)[0];
      if (!value) return 'the caught error, again';
      return value.type === 'object_creation_expression' ? (value.childForFieldName('type')?.text ?? oneLine(value.text)) : oneLine(value.text);
    };
    const fate = (n: SyntaxNode) => {
      const c = catchesAround(n)[0];
      return c ? `caught by ${oneLine(c.text.slice(0, (kids(c).find((k) => k.type === 'block')?.startIndex ?? c.endIndex) - c.startIndex))}` : 'escapes to the callers';
    };
    const throws = [...all(fn, 'throw_statement'), ...all(fn, 'throw_expression')].filter((t) => enclosingFunction(t)?.id === fn.id || enclosingFunction(t) === undefined);
    const thrownHere: ReportNode[] = throws.map((t) => ({ label: `throw ${thrownType(t)}`, description: `${fate(t)} · ${place(f, t)}`, icon: 'flame', tone: catchesAround(t).length ? undefined : 'warning', location: where(f, t) }));
    // Methods of the workspace that throw without catching, by name.
    const throwers = new Map<string, { f: Parsed; t: SyntaxNode }[]>();
    for (const x of files) {
      for (const m of [...all(x.tree.rootNode, 'method_declaration'), ...all(x.tree.rootNode, 'local_function_statement')]) {
        const escaping = [...all(m, 'throw_statement'), ...all(m, 'throw_expression')].filter((t) => !catchesAround(t).length && enclosingFunction(t)?.id === m.id);
        const key = m.childForFieldName('name')?.text;
        if (key && escaping.length) throwers.set(key, [...(throwers.get(key) ?? []), ...escaping.map((t) => ({ f: x, t }))]);
      }
    }
    const fromCalls: ReportNode[] = [];
    for (const call of all(fn, 'invocation_expression')) {
      const callee = call.childForFieldName('function');
      const calleeName = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.type === 'identifier' ? callee.text : undefined;
      const thrown = calleeName ? throwers.get(calleeName) : undefined;
      if (!thrown || calleeName === fn.childForFieldName('name')?.text) continue;
      fromCalls.push({
        label: `${calleeName}() can throw ${[...new Set(thrown.map(({ t }) => thrownType(t)))].join(', ')}`,
        description: `${fate(call)} · ${place(f, call)}`,
        icon: 'call-outgoing',
        tone: catchesAround(call).length ? undefined : 'warning',
        location: where(f, call),
        children: thrown.map(({ f: x, t }) => ({ label: `throw ${thrownType(t)}`, description: place(x, t), icon: 'flame', location: where(x, t) })),
      });
    }
    const catches = all(fn, 'catch_clause').filter((c) => enclosingFunction(c)?.id === fn.id);
    const handled: ReportNode[] = catches.map((c) => {
      const block = kids(c).find((k) => k.type === 'block');
      const head = oneLine(c.text.slice(0, (block?.startIndex ?? c.endIndex) - c.startIndex));
      const rethrows = block ? all(block, 'throw_statement').length > 0 : false;
      const empty = !!block && !kids(block).length;
      return { label: head, description: `${empty ? 'swallows the error' : rethrows ? 'handles, then throws again' : 'handles it'} · ${place(f, c)}`, icon: 'shield', tone: empty ? 'warning' : undefined, location: where(f, c) };
    });
    const uncaught = [...thrownHere, ...fromCalls].filter((r) => r.tone === 'warning');
    return report(
      'exceptions',
      `Exception flow of ${name}`,
      `${plural(thrownHere.length, 'throw')} here, ${plural(fromCalls.length, 'call')} that can throw, ${plural(uncaught.length, 'error')} escaping to callers`,
      [
        { label: 'Thrown here', description: plural(thrownHere.length, 'throw'), icon: 'flame', expanded: true, children: thrownHere },
        { label: 'Thrown by called functions', description: plural(fromCalls.length, 'call'), icon: 'call-outgoing', expanded: true, children: fromCalls },
        { label: 'Caught here', description: plural(handled.length, 'catch', 'catches'), icon: 'shield', expanded: true, children: handled },
      ].filter((r) => r.children.length),
      files,
      fromCalls.length ? [byName] : [],
    );
  });
}

// ---------------------------------------------------------------- Task errors (Promise rejections)

/** For an async method: its awaited and not awaited task calls, and where their errors go. */
export async function csharpTaskErrors(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  return withParsed(sources.filter((s) => s.file === file), undefined, (files) => {
    const f = here(files, file);
    const fn = csharpFunctionAt(f.tree.rootNode, offset);
    if (!fn) throw new AnalysisError('Put the cursor inside a C# method.');
    const name = functionName(fn);
    const asyncVoid = /\basync\s+void\b/.test(fn.text.slice(0, (fn.childForFieldName('body')?.startIndex ?? fn.endIndex) - fn.startIndex));
    const inTry = (n: SyntaxNode) => {
      for (let p = n.parent; p && p.id !== fn.id; p = p.parent) if (p.type === 'try_statement' && kids(p).some((c) => c.type === 'catch_clause')) return true;
      return false;
    };
    const awaited: ReportNode[] = [];
    const notAwaited: ReportNode[] = [];
    for (const call of all(fn, 'invocation_expression')) {
      if (enclosingFunction(call)?.id !== fn.id) continue;
      const callee = call.childForFieldName('function');
      const calleeName = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.text;
      const isAwaited = call.parent?.type === 'await_expression';
      if (!calleeName || (!/Async$/.test(calleeName) && !isAwaited && calleeName !== 'Run')) continue;
      const row: ReportNode = { label: `${isAwaited ? 'await ' : ''}${oneLine(call.text, 60)}`, description: place(f, call), icon: isAwaited ? 'debug-step-into' : 'debug-disconnect', location: where(f, call) };
      if (isAwaited) {
        row.description = `${inTry(call) ? 'an error is caught here' : 'an error goes to the caller'} · ${row.description}`;
        awaited.push(row);
      } else {
        const discarded = call.parent?.type === 'assignment_expression' && call.parent.childForFieldName('left')?.text === '_';
        row.description = `not awaited${discarded ? ' (discarded with _ =)' : ''}: its errors are lost · ${row.description}`;
        row.tone = 'warning';
        notAwaited.push(row);
      }
    }
    const roots: ReportNode[] = [
      { label: 'Rejection sources', description: plural(awaited.length, 'awaited task'), icon: 'debug-step-into', expanded: true, children: awaited },
      { label: 'Unhandled', description: plural(notAwaited.length + (asyncVoid ? 1 : 0), 'place'), icon: 'debug-disconnect', expanded: true, children: [
        ...(asyncVoid ? [{ label: `async void ${name}`, description: 'callers cannot await it; its errors crash the process', icon: 'warning', tone: 'warning' as const, location: where(f, fn.childForFieldName('name') ?? fn) }] : []),
        ...notAwaited,
      ] },
    ].filter((r) => r.children.length);
    if (!roots.length) throw new AnalysisError(`${name} starts no tasks: nothing awaited, nothing left running.`);
    return report('rejections', `Rejections of ${name}`, `${plural(awaited.length, 'awaited task')}, ${plural(notAwaited.length, 'task')} not awaited${asyncVoid ? ', async void' : ''}`, roots, files);
  });
}

// ---------------------------------------------------------------- Arguments passed in

/** The values each call passes to the parameter at the cursor (or to the parameter an argument at the cursor fills). */
export async function csharpArguments(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  const text = sources.find((s) => s.file === file)?.text ?? '';
  const target = await withParsed([{ file, text }], undefined, (files) => {
    const f = here(files, file);
    const id = identifierAt(f, offset);
    const parameter = id.parent?.type === 'parameter' ? id.parent : undefined;
    if (!parameter) throw new AnalysisError('Put the cursor on a parameter of a method or constructor.');
    const list = parameter.parent!;
    const index = kids(list).filter((c) => c.type === 'parameter').findIndex((p) => p.id === parameter.id);
    const method = list.parent!;
    const methodName = method.type === 'constructor_declaration' ? method.childForFieldName('name')?.text : method.childForFieldName('name')?.text;
    return { name: id.text, index, methodName: methodName ?? '', constructor: method.type === 'constructor_declaration', defaultValue: kids(parameter).find((c) => c.type === 'equals_value_clause')?.text };
  });
  return withParsed(sources, target.methodName, (files) => {
    const sites: ReportNode[] = [];
    const values = new Map<string, number>();
    for (const f of files) {
      const calls = target.constructor ? [...all(f.tree.rootNode, 'object_creation_expression'), ...all(f.tree.rootNode, 'implicit_object_creation_expression')] : all(f.tree.rootNode, 'invocation_expression');
      for (const call of calls) {
        const callee = target.constructor ? call.childForFieldName('type') : call.childForFieldName('function');
        const calleeName = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.type === 'generic_name' ? kids(callee)[0]?.text : callee?.text;
        if (calleeName !== target.methodName) continue;
        const args = kids(call.childForFieldName('arguments') ?? call).filter((c) => c.type === 'argument');
        // A named argument (name: value) wherever it is, else the one in position.
        const named = args.find((a) => a.childForFieldName('name')?.text === target.name || new RegExp(`^\\s*${target.name}\\s*:`).test(a.text));
        const arg = named ?? args.filter((a) => !/^\s*\w+\s*:/.test(a.text))[target.index];
        const value = arg ? oneLine(arg.text.replace(new RegExp(`^\\s*${target.name}\\s*:\\s*`), ''), 60) : target.defaultValue ? `${target.defaultValue.replace(/^=\s*/, '')} (the default)` : '(not passed)';
        values.set(value, (values.get(value) ?? 0) + 1);
        sites.push({ label: value, description: `${functionLabel(call)} · ${place(f, call)}${isTestPath(f.file) ? ' · test' : ''}`, icon: 'call-incoming', location: where(f, arg ?? call) });
      }
    }
    if (!sites.length) throw new AnalysisError(`No calls to ${target.methodName} found in the workspace's C# files.`);
    return report(
      'argumentFlow',
      `Propagation of ${target.name}`,
      `${plural(sites.length, 'call site')}, ${plural(values.size, 'distinct value')}`,
      [
        { label: 'Values that can arrive', description: plural(values.size, 'value'), icon: 'symbol-constant', expanded: true, children: [...values].map(([v, n]) => ({ label: v, description: n > 1 ? `${n} calls` : '1 call', icon: 'symbol-constant' })) },
        { label: 'Call sites', description: plural(sites.length, 'call'), icon: 'call-incoming', expanded: true, children: sites },
      ],
      files,
      [byName],
    );
  });
}

// ---------------------------------------------------------------- Types: family tree and override reach

interface TypeInfo {
  f: Parsed;
  node: SyntaxNode;
  name: string;
  bases: string[];
}

function typesOf(files: Parsed[]): TypeInfo[] {
  const out: TypeInfo[] = [];
  for (const f of files) {
    for (const type of [...typeDeclarations].flatMap((t) => all(f.tree.rootNode, t))) {
      const name = type.childForFieldName('name')?.text;
      if (!name) continue;
      const list = kids(type).find((c) => c.type === 'base_list');
      const bases = list ? kids(list).map((b) => (b.type === 'generic_name' ? kids(b)[0]?.text ?? b.text : b.text.split('.').pop() ?? b.text).replace(/<.*$/, '')) : [];
      out.push({ f, node: type, name, bases });
    }
  }
  return out;
}

const typeWord = (n: SyntaxNode) => n.type.replace('_declaration', '');

/** Family tree by name: what the type at the cursor extends and implements, what extends it, and its members. */
export async function csharpFamilyTree(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  return withParsed(sources, undefined, (files) => {
    const f = here(files, file);
    const at = f.tree.rootNode.descendantForIndex(offset);
    const target = at && (enclosingType(at) ?? undefined);
    if (!target) throw new AnalysisError('Put the cursor in a class, struct, record or interface.');
    const types = typesOf(files);
    const name = target.childForFieldName('name')!.text;
    const byName = new Map<string, TypeInfo[]>();
    for (const t of types) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
    const node = (t: TypeInfo, children: ReportNode[]): ReportNode => ({ label: t.name, description: `${typeWord(t.node)} · ${place(t.f, t.node)}`, icon: t.node.type === 'interface_declaration' ? 'symbol-interface' : 'symbol-class', location: where(t.f, t.node.childForFieldName('name') ?? t.node), expanded: true, children: children.length ? children : undefined });
    const up = (typeName: string, seen: Set<string>): ReportNode[] =>
      (byName.get(typeName)?.[0]?.bases ?? []).map((b) => {
        const known = byName.get(b)?.[0];
        if (!known) return { label: b, description: 'not in this workspace (a library type)', icon: 'library' };
        return node(known, seen.has(b) ? [] : up(b, new Set([...seen, b])));
      });
    const down = (typeName: string, seen: Set<string>): ReportNode[] => types.filter((t) => t.bases.includes(typeName) && !seen.has(t.name)).map((t) => node(t, down(t.name, new Set([...seen, t.name]))));
    const supers = up(name, new Set([name]));
    const subs = down(name, new Set([name]));
    const body = kids(target).find((c) => c.type === 'declaration_list');
    const members = (body ? kids(body) : []).filter((m) => memberDeclarations.has(m.type) || m.type === 'field_declaration').map((m) => {
      const id = m.childForFieldName('name') ?? all(m, 'variable_declarator')[0]?.childForFieldName('name');
      return { label: id?.text ?? oneLine(m.text, 40), description: m.type.replace(/_declaration$/, '').replace('_', ' '), icon: m.type === 'method_declaration' ? 'symbol-method' : m.type === 'property_declaration' ? 'symbol-property' : 'symbol-field', location: where(f, id ?? m) };
    });
    return report(
      'hierarchy',
      `Hierarchy of ${name}`,
      `${plural(supers.length, 'supertype')}, ${plural(subs.length, 'subtype')}, ${plural(members.length, 'member')}`,
      [
        { label: `${typeWord(target)} ${name}`, description: place(f, target), icon: target.type === 'interface_declaration' ? 'symbol-interface' : 'symbol-class', tone: 'ok', location: where(f, target.childForFieldName('name') ?? target) },
        { label: 'Supertypes', description: plural(supers.length, 'type'), icon: 'type-hierarchy-super', expanded: true, children: supers.length ? supers : [{ label: 'none', icon: 'dash' }] },
        { label: 'Subtypes and implementations', description: plural(subs.length, 'type'), icon: 'type-hierarchy-sub', expanded: true, children: subs.length ? subs : [{ label: 'none in this workspace', icon: 'dash' }] },
        { label: 'Members', description: plural(members.length, 'member'), icon: 'symbol-field', expanded: true, children: members },
      ],
      files,
      ['Found by name in the workspace’s C# files (the C# extension gives exact results).'],
    );
  });
}

/** Override reach: the method at the cursor, what it overrides, its overrides in subtypes, and its callers. */
export async function csharpOverrideReach(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  return withParsed(sources, undefined, (files) => {
    const f = here(files, file);
    const at = f.tree.rootNode.descendantForIndex(offset);
    let method: SyntaxNode | null = at;
    while (method && method.type !== 'method_declaration' && method.type !== 'property_declaration') method = method.parent;
    const owner = method && enclosingType(method);
    if (!method || !owner) throw new AnalysisError('Put the cursor on a method or property of a class or interface.');
    const name = method.childForFieldName('name')!.text;
    const ownerName = owner.childForFieldName('name')!.text;
    const types = typesOf(files);
    const memberIn = (t: TypeInfo) => {
      const body = kids(t.node).find((c) => c.type === 'declaration_list');
      return (body ? kids(body) : []).find((m) => (m.type === 'method_declaration' || m.type === 'property_declaration') && m.childForFieldName('name')?.text === name);
    };
    const row = (t: TypeInfo, m: SyntaxNode, how: string): ReportNode => ({ label: `${t.name}.${name}`, description: `${how} · ${place(t.f, m)}`, icon: 'symbol-method', location: where(t.f, m.childForFieldName('name') ?? m) });
    // Up: the declarations it overrides or implements. Down: every subtype that redeclares it.
    const above: ReportNode[] = [];
    const seen = new Set([ownerName]);
    const queue = [...(types.find((t) => t.name === ownerName)?.bases ?? [])];
    while (queue.length) {
      const b = queue.shift()!;
      if (seen.has(b)) continue;
      seen.add(b);
      const t = types.find((x) => x.name === b);
      if (!t) continue;
      const m = memberIn(t);
      if (m) above.push(row(t, m, t.node.type === 'interface_declaration' ? 'declared in the interface' : /\b(virtual|abstract)\b/.test(m.text.slice(0, 80)) ? 'overridden here' : 'hidden here'));
      queue.push(...t.bases);
    }
    const below: ReportNode[] = [];
    const down = [ownerName];
    const visited = new Set(down);
    while (down.length) {
      const name0 = down.shift()!;
      for (const t of types.filter((x) => x.bases.includes(name0) && !visited.has(x.name))) {
        visited.add(t.name);
        down.push(t.name);
        const m = memberIn(t);
        const how = (decl: SyntaxNode) => (/\boverride\b/.test(decl.text.slice(0, 80)) ? 'overrides it' : /\bnew\b/.test(decl.text.slice(0, 80)) ? 'hides it (new)' : 'implements it');
        below.push(m ? row(t, m, how(m)) : { label: `${t.name}`, description: `inherits it unchanged · ${place(t.f, t.node)}`, icon: 'symbol-class', location: where(t.f, t.node.childForFieldName('name') ?? t.node) });
      }
    }
    const callers: ReportNode[] = [];
    for (const x of files) {
      for (const call of all(x.tree.rootNode, 'invocation_expression')) {
        const callee = call.childForFieldName('function');
        const calleeName = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.text;
        if (calleeName === name) callers.push({ label: oneLine(call.text, 60), description: `${functionLabel(call)} · ${place(x, call)}`, icon: 'call-incoming', location: where(x, call) });
      }
    }
    return report(
      'overrideImpact',
      `Impact of changing ${ownerName}.${name}`,
      `${plural(above.length, 'base declaration')}, ${plural(below.length, 'subtype')}, ${plural(callers.length, 'call site')}`,
      [
        { label: 'Declared above', description: plural(above.length, 'declaration'), icon: 'type-hierarchy-super', expanded: true, children: above },
        { label: 'Overrides in subtypes', description: plural(below.length, 'subtype'), icon: 'type-hierarchy-sub', expanded: true, children: below },
        { label: 'Call sites', description: plural(callers.length, 'call'), icon: 'call-incoming', expanded: true, children: callers },
      ].filter((r) => r.children.length),
      files,
      [byName],
    );
  });
}

// ---------------------------------------------------------------- Who imports this

/** The files that use this file's namespace (a using directive, or the same namespace) and name its types. */
export async function csharpWhoImports(sources: CSharpSource[], file: string): Promise<Report> {
  return withParsed(sources, undefined, (files) => {
    const f = here(files, file);
    const namespaces = [...all(f.tree.rootNode, 'namespace_declaration'), ...all(f.tree.rootNode, 'file_scoped_namespace_declaration')].map((n) => n.childForFieldName('name')?.text).filter((n): n is string => !!n);
    const typeNames = typesOf([f]).map((t) => t.name);
    if (!typeNames.length) throw new AnalysisError('This file declares no types for other files to use.');
    const rows: ReportNode[] = [];
    for (const x of files) {
      if (x.file === f.file) continue;
      const usings = all(x.tree.rootNode, 'using_directive').filter((u) => namespaces.some((ns) => new RegExp(`\\b${ns.replace(/\./g, '\\.')}\\s*;`).test(u.text)));
      const sameNamespace = [...all(x.tree.rootNode, 'namespace_declaration'), ...all(x.tree.rootNode, 'file_scoped_namespace_declaration')].some((n) => namespaces.includes(n.childForFieldName('name')?.text ?? ''));
      const named = all(x.tree.rootNode, 'identifier').filter((i) => typeNames.includes(i.text) && !typeDeclarations.has(i.parent?.type ?? ''));
      if (!named.length || (!usings.length && !sameNamespace && namespaces.length)) continue;
      const types = [...new Set(named.map((i) => i.text))];
      rows.push({
        label: base(x.file),
        description: `${usings.length ? `using ${namespaces.join(', ')}` : sameNamespace ? 'same namespace' : 'no namespace'} · uses ${types.join(', ')}${isTestPath(x.file) ? ' · test' : ''}`,
        icon: 'file-code',
        location: where(x, usings[0] ?? named[0]),
        children: named.slice(0, 20).map((i) => ({ label: lineOf(x, i), description: `${functionLabel(i)} · line ${i.startPosition.row + 1}`, icon: 'symbol-class', location: where(x, i) })),
      });
    }
    return report(
      'dependents',
      `Importers of ${base(file)}`,
      rows.length ? `${plural(rows.length, 'file')} ${rows.length === 1 ? 'uses' : 'use'} ${typeNames.join(', ')}` : `nothing else in the workspace uses ${typeNames.join(', ')}`,
      [{ label: 'Used by', description: plural(rows.length, 'file'), icon: 'arrow-circle-up', expanded: true, children: rows.length ? rows : [{ label: 'no other file uses its types', icon: 'dash' }] }],
      files,
      [byName],
    );
  });
}

// ---------------------------------------------------------------- Callers and calls (by name)

/** Callers and calls by name, for when no C# language server answers. */
export async function csharpCallGraphByName(sources: CSharpSource[], file: string, offset: number, options: { depth: number; direction: CallDirection }): Promise<Report> {
  return withParsed(sources, undefined, (files) => {
    const f = here(files, file);
    const fn = csharpFunctionAt(f.tree.rootNode, offset);
    if (!fn) throw new AnalysisError('Put the cursor inside a C# method.');
    interface Fn { f: Parsed; node: SyntaxNode; key: string; label: string; calls: Map<string, number> }
    const fns: Fn[] = [];
    for (const x of files) {
      for (const m of [...all(x.tree.rootNode, 'method_declaration'), ...all(x.tree.rootNode, 'constructor_declaration'), ...all(x.tree.rootNode, 'local_function_statement')]) {
        const key = m.childForFieldName('name')?.text ?? '';
        const calls = new Map<string, number>();
        for (const call of all(m, 'invocation_expression')) {
          if (enclosingFunction(call)?.id !== m.id) continue;
          const callee = call.childForFieldName('function');
          const name = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.type === 'generic_name' ? kids(callee)[0]?.text : callee?.text;
          // nameof(…) and typeof(…) are operators, not calls.
          if (name && name !== 'nameof' && name !== 'typeof') calls.set(name, (calls.get(name) ?? 0) + 1);
        }
        fns.push({ f: x, node: m, key, label: functionName(m), calls });
      }
    }
    const root = fns.find((x) => x.f === f && x.node.id === fn.id) ?? { f, node: fn, key: fn.childForFieldName('name')?.text ?? '', label: functionName(fn), calls: new Map<string, number>() };
    const byKey = new Map<string, Fn[]>();
    // A class's method before an interface's declaration of the same name: that is the code that runs.
    const inInterface = (x: Fn) => enclosingType(x.node)?.type === 'interface_declaration';
    for (const x of [...fns].sort((a, b) => Number(inInterface(a)) - Number(inInterface(b)))) byKey.set(x.key, [...(byKey.get(x.key) ?? []), x]);
    const node = (x: Fn, count: number, children: ReportNode[] | undefined): ReportNode => ({ label: x.label, description: `${place(x.f, x.node)}${count > 1 ? ` · ${count} calls` : ''}${isTestPath(x.f.file) ? ' · test' : ''}`, icon: 'symbol-method', location: where(x.f, x.node.childForFieldName('name') ?? x.node), expanded: true, children });
    const walk = (x: Fn, level: number, seen: Set<SyntaxNode['id']>, incoming: boolean): ReportNode[] => {
      const next: { other?: Fn; count: number; name: string }[] = incoming
        ? fns.filter((c) => c.calls.has(x.key)).map((c) => ({ other: c, count: c.calls.get(x.key)!, name: c.key }))
        : [...x.calls].map(([name, count]) => ({ other: byKey.get(name)?.[0], count, name }));
      return next.slice(0, 25).map(({ other, count, name }) => {
        if (!other) return { label: `${name}()`, description: 'not in this workspace (a library method)', icon: 'library', tone: 'info' as const };
        const again = seen.has(other.node.id);
        const deeper = !again && level < options.depth ? walk(other, level + 1, new Set([...seen, other.node.id]), incoming) : undefined;
        const n = node(other, count, deeper?.length ? deeper : undefined);
        if (again) n.description += ' · shown above';
        return n;
      });
    };
    const start = new Set([root.node.id]);
    const roots: ReportNode[] = [];
    if (options.direction !== 'callees') {
      const callers = walk(root, 1, start, true);
      roots.push({ label: 'Called by', description: callers.length ? plural(callers.length, 'caller') : 'nothing in the workspace calls it', icon: 'call-incoming', expanded: true, children: callers });
    }
    if (options.direction !== 'callers') {
      const callees = walk(root, 1, start, false);
      roots.push({ label: 'Calls', description: plural(callees.length, 'function'), icon: 'call-outgoing', expanded: true, children: callees });
    }
    const r = report('callGraph', `Call graph of ${root.label}`, `${plural(options.depth, 'level')}, found by name`, roots, files, [byName]);
    r.subject = where(f, fn.childForFieldName('name') ?? fn);
    r.controls = callGraphControls(options.depth, options.direction);
    return r;
  });
}
