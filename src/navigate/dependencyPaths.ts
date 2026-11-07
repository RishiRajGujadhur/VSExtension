import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath } from '../analysis/paths';
import { AnalysisError } from '../analysis/types';
import { ReportBuilder, ReportNode, Report, codeContextAt, plural } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import { ImportEdge, ModuleGraph, programGraph, reverseEdges } from './moduleGraph';

/** Distances, in imports, from every file that can reach `to`. */
function distancesTo(graph: ModuleGraph, to: string, runtimeOnly: boolean): Map<string, number> {
  const reverse = reverseEdges(graph);
  const distance = new Map([[to, 0]]);
  const queue = [to];
  while (queue.length) {
    const file = queue.shift()!;
    for (const edge of reverse.get(file) ?? []) {
      if ((runtimeOnly && edge.typeOnly) || distance.has(edge.from)) {
        continue;
      }
      distance.set(edge.from, distance.get(file)! + 1);
      queue.push(edge.from);
    }
  }
  return distance;
}

/** How many imports away every module the file depends on is, directly or indirectly. */
export function distancesFrom(graph: ModuleGraph, from: string): Map<string, number> {
  const source = normalizePath(from);
  const distance = new Map([[source, 0]]);
  const queue = [source];
  while (queue.length) {
    const file = queue.shift()!;
    for (const edge of graph.edges.get(file) ?? []) {
      if (!distance.has(edge.to)) {
        distance.set(edge.to, distance.get(file)! + 1);
        queue.push(edge.to);
      }
    }
  }
  distance.delete(source);
  return distance;
}

/** Every shortest import path from one module to another, up to `limit` paths. */
export function shortestPaths(graph: ModuleGraph, from: string, to: string, options: { runtimeOnly?: boolean; limit?: number } = {}): ImportEdge[][] {
  const source = normalizePath(from);
  const target = normalizePath(to);
  const distance = distancesTo(graph, target, !!options.runtimeOnly);
  const limit = options.limit ?? 20;
  const paths: ImportEdge[][] = [];
  if (!distance.has(source) || source === target) {
    return paths;
  }
  const walk = (file: string, trail: ImportEdge[]) => {
    if (paths.length >= limit) {
      return;
    }
    if (file === target) {
      paths.push(trail);
      return;
    }
    const remaining = distance.get(file)!;
    const seen = new Set<string>();
    for (const edge of graph.edges.get(file) ?? []) {
      if ((options.runtimeOnly && edge.typeOnly) || distance.get(edge.to) !== remaining - 1 || seen.has(edge.to)) {
        continue;
      }
      seen.add(edge.to);
      walk(edge.to, [...trail, edge]);
    }
  };
  walk(source, []);
  return paths;
}

function describeEdge(edge: ImportEdge): string {
  const names = edge.names.length === 0 ? '' : edge.names.includes('*') && edge.names.length === 1 ? '* ' : `{ ${edge.names.join(', ')} } `;
  const verb = edge.kind === 're-export' ? 'export' : edge.kind === 'dynamic' ? 'import(' : edge.kind === 'require' ? 'require(' : 'import';
  if (edge.kind === 'dynamic' || edge.kind === 'require') {
    return `${verb}'${edge.specifier}')`;
  }
  return `${verb} ${edge.typeOnly ? 'type ' : ''}${names}${names ? 'from ' : ''}'${edge.specifier}'`;
}

/** Dependency Path Finder: exactly why one module depends on another, through every shortest import chain. */
export function dependencyPathReport(program: ts.Program, from: string, to: string, root?: string): Report {
  const graph = programGraph(program);
  const source = normalizePath(from);
  const target = normalizePath(to);
  if (!graph.files.has(source) || !graph.files.has(target)) {
    throw new AnalysisError('Both files must be in the same project.');
  }
  const relative = (file: string) => (root ? path.relative(root, file).replace(/\\/g, '/') : path.basename(file));
  const builder = new ReportBuilder('dependencyPath', `${path.basename(source)} → ${path.basename(target)}`);
  const paths = shortestPaths(graph, source, target);
  // The same question the other way round: why does the target depend on the source?
  const swap = { kind: 'swapDependency', from: target, to: source };
  const runtime = shortestPaths(graph, source, target, { runtimeOnly: true, limit: 1 });
  const pathRow = (edges: ImportEdge[], index: number): ReportNode => {
    const typeOnly = edges.some((e) => e.typeOnly);
    return {
      label: `Path ${index + 1}: ${[source, ...edges.map((e) => e.to)].map((f) => path.basename(f)).join(' → ')}`,
      description: typeOnly ? 'type-only: erased at compile time' : edges.some((e) => e.kind === 'dynamic') ? 'includes a lazy import()' : 'runtime',
      icon: typeOnly ? 'symbol-interface' : 'arrow-right',
      tone: typeOnly ? 'info' : 'warning',
      expanded: index < 3,
      children: edges.map((edge) => {
        const sourceFile = program.getSourceFile(edge.from)!;
        // Find Usages on the first imported name shows what in the importing module needs it.
        const name = edge.kind === 'import' ? edge.names.find((n) => n !== '*' && n !== 'default') : undefined;
        const at = name ? sourceFile.text.indexOf(name, edge.start) : -1;
        return {
          label: `${relative(edge.from)}: ${describeEdge(edge)}`,
          description: `line ${edge.line + 1}`,
          icon: edge.kind === 're-export' ? 'export' : 'package',
          tooltip: codeContextAt(sourceFile, edge.start, 0),
          location: builder.span(sourceFile, edge.start, edge.end),
          action: at >= edge.start && at < edge.end ? { kind: 'findUsages', command: 'tsStructure.semanticUsages', file: sourceFile.fileName, offset: at } : undefined,
        };
      }),
    };
  };
  const roots: ReportNode[] = [];
  if (paths.length === 0) {
    const reverse = shortestPaths(graph, target, source, { limit: 3 });
    roots.push({ label: `${relative(source)} does not depend on ${relative(target)}`, icon: 'pass', tone: 'ok', action: swap });
    if (reverse.length) {
      roots.push({ label: `But ${relative(target)} depends on ${relative(source)}`, icon: 'arrow-left', expanded: true, children: reverse.map(pathRow) });
    }
    return builder.finish(roots, reverse.length ? 'no dependency (but the other way round there is)' : 'no dependency either way');
  }
  const length = paths[0].length;
  roots.push({
    label: `${relative(source)} depends on ${relative(target)}`,
    description: `${plural(length, 'import')} deep${runtime.length ? '' : ', type-only'}`,
    icon: 'references',
    tone: runtime.length ? 'warning' : 'info',
    action: swap,
  });
  if (runtime.length === 0) {
    builder.warnings.push('Every path contains a type-only import, so the dependency disappears at runtime.');
  } else if (paths.every((p) => p.some((e) => e.typeOnly))) {
    roots.push({ label: 'Longer runtime path', description: `${plural(runtime[0].length, 'import')}`, icon: 'warning', tone: 'warning', expanded: true, children: [pathRow(runtime[0], 0)] });
  }
  // Both directions at once is an import cycle: module initialization order then decides what is undefined.
  const back = shortestPaths(graph, target, source, { runtimeOnly: true, limit: 3 });
  if (runtime.length && back.length) {
    builder.warnings.push(`Circular dependency: ${relative(target)} also depends on ${relative(source)} at runtime, so one of them sees the other half-initialized while loading.`);
    roots.push({ label: `Circular: ${relative(target)} depends back on ${relative(source)}`, description: plural(back.length, 'path'), icon: 'sync', tone: 'error', expanded: true, children: back.map(pathRow) });
  }
  const circular = runtime.length > 0 && back.length > 0;
  roots.push({ label: 'Shortest paths', description: paths.length >= 20 ? 'first 20 paths' : plural(paths.length, 'path'), icon: 'git-merge', expanded: true, children: paths.map(pathRow) });
  const lastHops = new Map<string, ImportEdge>();
  for (const p of paths) {
    lastHops.set(p[p.length - 1].from, p[p.length - 1]);
  }
  roots.push({
    label: `Modules on these paths that import ${path.basename(target)} directly`,
    description: plural(lastHops.size, 'module'),
    icon: 'call-incoming',
    children: [...lastHops.values()].map((edge) => ({ label: relative(edge.from), description: describeEdge(edge), icon: 'file-code', location: builder.span(program.getSourceFile(edge.from)!, edge.start, edge.end) })),
  });
  if (circular) {
    roots.push(
      howToFix([
        'Move what both modules need into a third module that imports neither.',
        'Change imports that only bring in types to import type; they disappear at run time.',
        'Load one side lazily with import() inside the function that needs it.',
      ]),
    );
  }
  return builder.finish(roots, `${plural(paths.length, 'shortest path')} of ${plural(length, 'import')}`);
}
