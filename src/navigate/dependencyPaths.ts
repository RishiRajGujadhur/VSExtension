import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath } from '../analysis/paths';
import { AnalysisError } from '../analysis/types';
import { ReportBuilder, ReportNode, Report, plural } from '../structure/report';
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
    throw new AnalysisError('Both files must be part of the same compiler project.');
  }
  const relative = (file: string) => (root ? path.relative(root, file).replace(/\\/g, '/') : path.basename(file));
  const builder = new ReportBuilder('dependencyPath', `${path.basename(source)} → ${path.basename(target)}`);
  const paths = shortestPaths(graph, source, target);
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
        return {
          label: `${relative(edge.from)}: ${describeEdge(edge)}`,
          description: `line ${edge.line + 1}`,
          icon: edge.kind === 're-export' ? 'export' : 'package',
          location: builder.span(sourceFile, edge.start, edge.end),
        };
      }),
    };
  };
  const roots: ReportNode[] = [];
  if (paths.length === 0) {
    const reverse = shortestPaths(graph, target, source, { limit: 3 });
    roots.push({ label: `${relative(source)} does not depend on ${relative(target)}`, icon: 'pass', tone: 'ok' });
    if (reverse.length) {
      roots.push({ label: `But ${relative(target)} depends on ${relative(source)}`, icon: 'arrow-left', expanded: true, children: reverse.map(pathRow) });
    }
    return builder.finish(roots, 'no dependency');
  }
  const length = paths[0].length;
  roots.push({
    label: `${relative(source)} depends on ${relative(target)}`,
    description: `${plural(length, 'import')} deep${runtime.length ? '' : ', type-only'}`,
    icon: 'references',
    tone: runtime.length ? 'warning' : 'info',
  });
  if (runtime.length === 0) {
    builder.warnings.push('Every path contains a type-only import, so the dependency disappears at runtime.');
  } else if (paths.every((p) => p.some((e) => e.typeOnly))) {
    roots.push({ label: 'Longer runtime path', description: `${plural(runtime[0].length, 'import')}`, icon: 'warning', tone: 'warning', expanded: true, children: [pathRow(runtime[0], 0)] });
  }
  roots.push({ label: 'Shortest paths', description: `${paths.length}${paths.length >= 20 ? '+' : ''}`, icon: 'git-merge', expanded: true, children: paths.map(pathRow) });
  const lastHops = new Map<string, ImportEdge>();
  for (const p of paths) {
    lastHops.set(p[p.length - 1].from, p[p.length - 1]);
  }
  roots.push({
    label: `Modules on these paths that import ${path.basename(target)} directly`,
    description: `${lastHops.size}`,
    icon: 'call-incoming',
    children: [...lastHops.values()].map((edge) => ({ label: relative(edge.from), description: describeEdge(edge), icon: 'file-code', location: builder.span(program.getSourceFile(edge.from)!, edge.start, edge.end) })),
  });
  return builder.finish(roots, `${plural(paths.length, 'shortest path')} of ${plural(length, 'import')}`);
}
