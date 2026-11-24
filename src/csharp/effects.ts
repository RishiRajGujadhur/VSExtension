import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import type { CSharpSource } from './charts';
import { CSharpEffect, CSharpEffectKind, bodyOf, csharpEffects, rootName } from './explainTarget';
import { csharpFunctionAt, functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';

/**
 * Side effects in C#, from the bundled parser: what a method changes outside itself and what it reaches beyond the
 * program, in its own code and through the methods it calls, followed by name across the workspace's C# files.
 * The rules are the ones Explain this code uses (`csharpEffects` in explainTarget.ts); the report has the shape of
 * the TypeScript one (`sideEffectReport` in src/inspect/effects.ts), so the results view, card and chart draw it the
 * same way.
 */

const kindLabels: Record<CSharpEffectKind | 'unknown', string> = {
  'mutates-parameter': 'Mutates arguments',
  'mutates-this': 'Mutates the instance',
  'mutates-other': 'Mutates other state',
  io: 'Input/output',
  timer: 'Waits',
  nondeterministic: 'Nondeterministic',
  global: 'Uses global state',
  unknown: 'Calls it could not follow',
};

const kindIcons: Record<CSharpEffectKind | 'unknown', string> = {
  'mutates-parameter': 'symbol-parameter',
  'mutates-this': 'symbol-field',
  'mutates-other': 'symbol-variable',
  io: 'plug',
  timer: 'watch',
  nondeterministic: 'question',
  global: 'globe',
  unknown: 'debug-disconnect',
};

const isMutation = (kind: string) => kind.startsWith('mutates-');

interface Parsed {
  file: string;
  text: string;
  tree: Tree;
}

/** An effect of the method, maybe from a method it calls: `node` is where it happens in the method itself. */
interface Found {
  kind: CSharpEffectKind | 'unknown';
  text: string;
  node: SyntaxNode;
  file: Parsed;
  /** The chain of calls that leads to it, outermost first: "SaveAsync" → "Log". */
  via: string[];
  /** Where it happens in the last method called. */
  origin?: { file: Parsed; node: SyntaxNode };
  /** For a call through which effects come: where the method called is declared. */
  callee?: { file: Parsed; node: SyntaxNode; name: string };
}

const where = (f: Parsed, n: SyntaxNode): ReportLocation => ({ file: f.file, line: n.startPosition.row, character: n.startPosition.column, endLine: n.endPosition.row, endCharacter: n.endPosition.column });
const oneLine = (text: string, max = 40) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const base = (file: string) => file.split(/[\\/]/).pop() ?? file;
const classOf = (n: SyntaxNode | null) => {
  for (let p = n; p; p = p.parent) if (/^(class|struct|record|interface)_declaration$/.test(p.type)) return p;
  return undefined;
};

/** How deep calls are followed. */
const DEPTH = 4;

export async function csharpSideEffects(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  const parsed = new Map<string, Parsed>();
  const parse = async (s: CSharpSource) => {
    let p = parsed.get(s.file);
    if (!p) parsed.set(s.file, (p = { file: s.file, text: s.text, tree: await parseCSharp(s.text) }));
    return p;
  };
  try {
    const source = sources.find((s) => s.file === file);
    if (!source) throw new AnalysisError('Open a C# file and put the cursor in it.');
    const home = await parse(source);
    const fn = csharpFunctionAt(home.tree.rootNode, offset);
    if (!fn || !bodyOf(fn)) throw new AnalysisError('Put the cursor in a method, constructor, property or lambda.');

    /** The method a call names, by name: in the caller's class first for an unqualified or `this.` call, then anywhere. */
    const declarationOf = async (name: string, near: SyntaxNode, qualified: boolean): Promise<{ file: Parsed; node: SyntaxNode } | undefined> => {
      const pattern = new RegExp(`\\b${name.replace(/\W/g, '')}\\s*[(<]`);
      const found: { file: Parsed; node: SyntaxNode }[] = [];
      for (const s of sources) {
        if (!pattern.test(s.text)) continue;
        const p = await parse(s);
        for (const m of p.tree.rootNode.descendantsOfType(['method_declaration', 'local_function_statement'])) {
          if (m && m.childForFieldName('name')?.text === name && bodyOf(m)) found.push({ file: p, node: m });
        }
      }
      const own = classOf(near);
      return (!qualified && found.find((d) => d.file.file === home.file && classOf(d.node)?.id === own?.id)) || found[0];
    };

    const effectsIn = async (method: SyntaxNode, f: Parsed, via: string[], seen: Set<string>): Promise<Found[]> => {
      const { effects, calls, parameters, locals } = csharpEffects(method);
      const out: Found[] = effects.map((e: CSharpEffect) => ({ kind: e.kind, text: e.text, node: e.node, file: f, via: [] }));
      if (via.length >= DEPTH) return out;
      for (const call of calls) {
        const receiver = call.receiver;
        const unqualified = !receiver || receiver.type === 'this_expression' || receiver.text === 'this' || receiver.text === 'base';
        const target = await declarationOf(call.method, call.node, !unqualified);
        const key = target ? `${target.file.file}:${target.node.startIndex}` : '';
        if (!target || seen.has(key)) {
          if (!target && call.forEffect) out.push({ kind: 'unknown', text: `${oneLine(call.text)}() may change things`, node: call.node, file: f, via: [] });
          continue;
        }
        const name = functionName(target.node).replace(/^.*\./, '');
        const inner = await effectsIn(target.node, target.file, [...via, name], new Set([...seen, key]));
        const calleeParameters = csharpEffects(target.node).parameters;
        const args = call.node.childForFieldName('arguments')?.namedChildren.filter((a): a is SyntaxNode => a?.type === 'argument') ?? [];
        for (const e of inner) {
          if (e.kind === 'unknown') continue;
          let kind = e.kind;
          let text = e.text;
          // What the callee changes on itself, it changes on what it is called on.
          if (kind === 'mutates-this' && !unqualified) {
            const owner = rootName(receiver!);
            if (locals.has(owner)) continue; // an object the caller made: its own business
            kind = parameters.includes(owner) ? 'mutates-parameter' : /^[A-Z]/.test(owner) ? 'mutates-other' : 'mutates-this';
            text = text.replace(/^changes (?:this\.)?/, `changes ${oneLine(receiver!.text, 30)}.`);
          }
          // What it changes on an argument, it changes on what is passed.
          if (kind === 'mutates-parameter') {
            const index = calleeParameters.findIndex((p) => new RegExp(`^changes ${p}\\b`).test(e.text));
            const arg = index >= 0 ? args[index]?.namedChildren.at(-1) : undefined;
            if (!arg || arg.type !== 'identifier' && arg.type !== 'member_access_expression' && arg.text !== 'this') continue;
            const owner = rootName(arg);
            if (locals.has(owner)) continue;
            kind = parameters.includes(owner) ? 'mutates-parameter' : /^[A-Z]/.test(owner) ? 'mutates-other' : 'mutates-this';
            text = text.replace(new RegExp(`^changes ${calleeParameters[index]}`), `changes ${oneLine(arg.text, 30)}`).replace(/ \(an argument\)$/, kind === 'mutates-parameter' ? ' (an argument)' : '');
          }
          out.push({ kind, text, node: call.node, file: f, via: [name, ...e.via], origin: e.origin ?? { file: e.file, node: e.node }, callee: { file: target.file, node: target.node, name } });
        }
      }
      return out;
    };

    // In the order they happen in the method; the same effect reached twice through one call is one effect.
    const reached = (await effectsIn(fn, home, [], new Set([`${home.file}:${fn.startIndex}`]))).sort((a, b) => a.node.startIndex - b.node.startIndex);
    const effects = reached.filter((e, i) => reached.findIndex((x) => x.kind === e.kind && x.text === e.text && x.node.id === e.node.id) === i);
    const label = functionName(fn);
    const nameNode = fn.childForFieldName('name') ?? fn;

    // Where an effect happens matters: after an await other code may have run; in a loop it repeats.
    const awaits = fn.descendantsOfType('await_expression').filter((a): a is SyntaxNode => !!a).map((a) => a.endIndex);
    const inLoop = (node: SyntaxNode) => {
      for (let n = node.parent; n && n.id !== fn.id; n = n.parent) {
        if (/^(for|for_each|foreach|while|do)_statement$/.test(n.type)) return true;
        if (functionTypes.has(n.type)) return false;
      }
      return false;
    };
    const notes = (e: Found) => [awaits.some((end) => end <= e.node.startIndex) ? 'after await' : '', inLoop(e.node) ? 'in a loop' : ''].filter(Boolean);
    const row = (e: Found): ReportNode => {
      const description = e.via.length ? `via ${e.via.map((v) => `${v}()`).join(' → ')}` : oneLine(e.node.text);
      const children: ReportNode[] | undefined = e.origin ? [{ label: oneLine(e.origin.node.text, 60), description: `in ${e.via[e.via.length - 1]}() · ${base(e.origin.file.file)}:${e.origin.node.startPosition.row + 1}`, icon: kindIcons[e.kind], location: where(e.origin.file, e.origin.node) }] : undefined;
      return {
        label: e.text,
        description: [description, ...notes(e)].join(' · '),
        icon: kindIcons[e.kind],
        tone: isMutation(e.kind) ? 'warning' : 'info',
        location: where(e.file, e.node),
        ...(children ? { children } : {}),
      };
    };

    const roots: ReportNode[] = [];
    for (const kind of Object.keys(kindLabels) as (CSharpEffectKind | 'unknown')[]) {
      const ofKind = effects.filter((e) => e.kind === kind);
      if (!ofKind.length) continue;
      roots.push({
        label: kindLabels[kind],
        description: `${ofKind.filter((e) => !e.via.length).length} direct, ${ofKind.filter((e) => e.via.length).length} through calls`,
        icon: kindIcons[kind],
        tone: isMutation(kind) ? 'warning' : 'info',
        expanded: true,
        children: ofKind.map(row),
      });
    }
    // The same effects by the call that brings them in, to see which call to change or isolate.
    const byCall = new Map<string, Found[]>();
    for (const e of effects.filter((x) => x.callee)) {
      const key = `${e.callee!.file.file}:${e.callee!.node.startIndex}`;
      byCall.set(key, [...(byCall.get(key) ?? []), e]);
    }
    if (byCall.size) {
      roots.push({
        label: 'By call',
        description: plural(byCall.size, 'method'),
        icon: 'call-outgoing',
        // The methods that bring in the most effects first.
        children: [...byCall.values()].sort((a, b) => b.length - a.length).map((inherited) => {
          const callee = inherited[0].callee!;
          const sites = new Set(inherited.map((e) => e.node.id)).size;
          return {
            label: `${callee.name}()`,
            description: [[...new Set(inherited.map((e) => kindLabels[e.kind].toLowerCase()))].join(', '), ...(sites > 1 ? [`called ${sites} times`] : [])].join(' · '),
            icon: 'symbol-method',
            tone: inherited.some((e) => isMutation(e.kind)) ? ('warning' as const) : ('info' as const),
            location: where(inherited[0].file, inherited[0].node),
            action: { kind: 'showSideEffects', command: 'tsStructure.sideEffects', file: callee.file.file, offset: (callee.node.childForFieldName('name') ?? callee.node).startIndex },
          };
        }),
      });
    }
    const known = effects.filter((e) => e.kind !== 'unknown');
    const unfollowed = effects.length - known.length;
    if (!roots.length) roots.push({ label: `${label} has no detected side effects`, description: 'pure', icon: 'pass', tone: 'ok', location: where(home, nameNode) });
    const kinds = (Object.keys(kindLabels) as (CSharpEffectKind | 'unknown')[]).filter((k) => known.some((e) => e.kind === k)).map((k) => kindLabels[k].toLowerCase());
    // The verdict first: what the effects mean for testing and reuse.
    if (known.length) {
      roots.unshift({
        label: `Not pure: ${kinds.join(', ')}`,
        description: 'test it with fakes or mocks; calling it twice or caching its result changes what happens',
        icon: 'info',
        tone: 'info',
        location: where(home, nameNode),
      });
    }
    const inherited = known.filter((e) => e.via.length).length;
    const description = [known.length ? `${plural(known.length, 'side effect')} (${kinds.join(', ')})` : unfollowed ? 'no known side effects' : 'pure', inherited ? `${inherited} through calls` : '', unfollowed ? `${plural(unfollowed, 'call')} not followed` : ''].filter(Boolean).join(', ');
    const fileHashes: Record<string, string> = {};
    const used = new Set<string>();
    const visit = (rows: ReportNode[]) => rows.forEach((r) => { if (r.location) used.add(r.location.file); visit(r.children ?? []); });
    visit(roots);
    for (const p of parsed.values()) if (used.has(p.file)) fileHashes[p.file] = hashText(p.text);
    return {
      kind: 'sideEffects',
      title: `Side effects of ${label}`,
      description,
      roots,
      warnings: ['Calls are followed by name (the bundled C# parser sees syntax, not types): a method with the same name in another class may be the one followed.'],
      fileHashes,
    };
  } finally {
    for (const p of parsed.values()) p.tree.delete();
  }
}
