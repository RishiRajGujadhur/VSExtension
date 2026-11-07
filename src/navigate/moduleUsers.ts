import * as path from 'path';
import * as ts from 'typescript';
import { ModuleGraph, programGraph } from './moduleGraph';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';
import { howToFix } from '../structure/howToFix';

const relative = (file: string, root?: string) => (root ? path.relative(root, file) : path.basename(file)).replace(/\\/g, '/');
const fileLocation = (file: string) => ({ file, line: 0, character: 0, endLine: 0, endCharacter: 0 });

/** Groups of modules that import each other at run time, directly or through others: each a cycle. */
export function importCycles(graph: ModuleGraph, includeTypeOnly = false): string[][] {
  const next = (file: string) => (graph.edges.get(file) ?? []).filter((e) => includeTypeOnly || !e.typeOnly).map((e) => e.to);
  // Tarjan's strongly connected components, iteratively so deep graphs don't overflow the stack.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  for (const start of graph.files) {
    if (index.has(start)) continue;
    const work: { file: string; children: string[]; i: number }[] = [];
    const enter = (file: string) => {
      index.set(file, counter);
      low.set(file, counter++);
      stack.push(file);
      onStack.add(file);
      work.push({ file, children: next(file), i: 0 });
    };
    enter(start);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.children.length) {
        const child = frame.children[frame.i++];
        if (!index.has(child)) {
          enter(child);
        } else if (onStack.has(child)) {
          low.set(frame.file, Math.min(low.get(frame.file)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.file, Math.min(low.get(parent.file)!, low.get(frame.file)!));
      if (low.get(frame.file) === index.get(frame.file)) {
        const group: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          group.push(member);
        } while (member !== frame.file);
        if (group.length > 1 || next(group[0]).includes(group[0])) groups.push(group.reverse());
      }
    }
  }
  return groups.sort((a, b) => b.length - a.length);
}

/** Find Import Cycles: every group of modules that import each other at run time. */
export function cyclesReport(program: ts.Program, root?: string, inside: (file: string) => boolean = () => true): Report {
  const graph = programGraph(program);
  const builder = new ReportBuilder('cycles', 'Import cycles');
  // Cycles with at least one module in the scope.
  const cycles = importCycles(graph).filter((group) => group.some(inside));
  const roots: ReportNode[] = cycles.map((group) => ({
    label: group.map((f) => path.basename(f)).join(' ⇄ '),
    description: plural(group.length, 'module'),
    icon: 'sync',
    tone: 'warning' as const,
    expanded: cycles.length <= 5,
    children: group.flatMap((file) =>
      (graph.edges.get(file) ?? [])
        .filter((e) => !e.typeOnly && group.includes(e.to))
        .map((e) => ({ label: `${path.basename(e.from)} imports ${path.basename(e.to)}`, description: `${relative(e.from, root)}:${e.line + 1}`, icon: 'arrow-right', location: { file: e.from, line: e.line, character: 0, endLine: e.line, endCharacter: 0 } })),
    ),
  }));
  if (roots.length === 0) builder.warnings.push('No modules import each other at run time.');
  else
    roots.push(
      howToFix([
        'Move the code both modules need into a third module that imports neither.',
        'Import only types with import type, which disappears at run time and cannot cause a cycle.',
        'Pass the dependency in as a parameter instead of importing it (dependency injection).',
        'Avoid importing from a barrel (index.ts) inside the folder it re-exports.',
      ]),
    );
  return builder.finish(roots, `${plural(cycles.length, 'cycle')} in ${plural(graph.files.size, 'module')}`);
}

/** The modules that import `file`, by how many imports away they are: 1 imports it directly. */
export function dependents(graph: ModuleGraph, file: string): Map<string, number> {
  const importers = new Map<string, string[]>();
  for (const [from, edges] of graph.edges) {
    for (const e of edges) importers.set(e.to, [...(importers.get(e.to) ?? []), from]);
  }
  const distance = new Map<string, number>();
  let frontier = [file];
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of importers.get(f) ?? []) {
        if (importer !== file && !distance.has(importer)) {
          distance.set(importer, d);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/** Who Imports This File: the modules a change to the file can reach, nearest first. */
export function dependentsReport(program: ts.Program, file: string, root?: string): Report {
  const graph = programGraph(program);
  const builder = new ReportBuilder('dependents', `Importers of ${path.basename(file)}`);
  const distance = dependents(graph, file.replace(/\\/g, '/'));
  const byDistance = new Map<number, string[]>();
  for (const [f, d] of distance) byDistance.set(d, [...(byDistance.get(d) ?? []), f]);
  const roots: ReportNode[] = [...byDistance]
    .sort(([a], [b]) => a - b)
    .map(([d, files]) => ({
      label: d === 1 ? 'Import it directly' : `Through ${plural(d - 1, 'other module')}`,
      description: plural(files.length, 'module'),
      icon: d === 1 ? 'arrow-circle-up' : 'arrow-up',
      expanded: d <= 2,
      children: files.sort().map((f) => ({ label: path.basename(f), description: relative(path.dirname(f), root) || '.', icon: 'file-code', location: fileLocation(f) })),
    }));
  if (roots.length === 0) builder.warnings.push(`Nothing in the project imports ${path.basename(file)}.`);
  return builder.finish(roots, `${plural(distance.size, 'module')} depend on it`);
}
