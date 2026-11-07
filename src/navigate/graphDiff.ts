import { execFileSync } from 'child_process';
import * as path from 'path';
import * as ts from 'typescript';
import { isSourceFileName, normalizePath } from '../analysis/paths';
import { AnalysisError } from '../analysis/types';
import { ReportBuilder, ReportNode, Report, plural } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import { ImportEdge, ModuleGraph, buildModuleGraph, scriptKind } from './moduleGraph';

const excluded = /(^|\/)(node_modules|dist|out|build|coverage|\.git)\//;

function git(cwd: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', args, { cwd, input, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new AnalysisError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function gitRoot(cwd: string): string {
  return normalizePath(git(cwd, ['rev-parse', '--show-toplevel']).toString().trim());
}

/** Source files under `directory` as they were at `ref`, read in one `git cat-file --batch` call. */
export function filesAtRef(repoRoot: string, ref: string, directory: string): Map<string, string> {
  const relativeDir = path.relative(repoRoot, directory).replace(/\\/g, '/');
  const listing = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', ref, '--', relativeDir || '.']).toString();
  const names = listing.split('\0').filter((name) => name && isSourceFileName(name) && !excluded.test(`/${name}`));
  const files = new Map<string, string>();
  if (names.length === 0) {
    return files;
  }
  const output = git(repoRoot, ['cat-file', '--batch'], names.map((name) => `${ref}:${name}`).join('\n') + '\n');
  let offset = 0;
  for (const name of names) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString();
    offset = headerEnd + 1;
    const size = /^\S+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) {
      continue;
    }
    files.set(normalizePath(path.join(repoRoot, name)), output.subarray(offset, offset + Number(size)).toString('utf8'));
    offset += Number(size) + 1;
  }
  return files;
}

/** Source files under `directory` in the working tree, with unsaved editor text where available. */
export function workingTreeFiles(directory: string, readFile: (fileName: string) => string | undefined): Map<string, string> {
  const files = new Map<string, string>();
  for (const fileName of ts.sys.readDirectory(directory, ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/coverage/**'], ['**/*'])) {
    if (!isSourceFileName(fileName)) {
      continue;
    }
    const text = readFile(fileName) ?? ts.sys.readFile(fileName);
    if (text !== undefined) {
      files.set(normalizePath(fileName), text);
    }
  }
  return files;
}

export function graphOf(files: Map<string, string>, options: ts.CompilerOptions): ModuleGraph {
  return buildModuleGraph(files.keys(), (f) => files.get(f), options);
}

/** Strongly connected groups of modules that import each other, largest first. */
export function cycles(graph: ModuleGraph, runtimeOnly = false): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  const strongConnect = (file: string) => {
    index.set(file, counter);
    low.set(file, counter);
    counter++;
    stack.push(file);
    onStack.add(file);
    for (const edge of graph.edges.get(file) ?? []) {
      if (runtimeOnly && edge.typeOnly) {
        continue;
      }
      if (!index.has(edge.to)) {
        strongConnect(edge.to);
        low.set(file, Math.min(low.get(file)!, low.get(edge.to)!));
      } else if (onStack.has(edge.to)) {
        low.set(file, Math.min(low.get(file)!, index.get(edge.to)!));
      }
    }
    if (low.get(file) === index.get(file)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== file);
      const selfLoop = (graph.edges.get(file) ?? []).some((e) => e.to === file);
      if (component.length > 1 || selfLoop) {
        result.push(component.sort());
      }
    }
  };
  for (const file of [...graph.files].sort()) {
    if (!index.has(file)) {
      strongConnect(file);
    }
  }
  return result.sort((a, b) => b.length - a.length);
}

interface MergedEdge {
  from: string;
  to: string;
  names: Set<string>;
  typeOnly: boolean;
  edge: ImportEdge;
}

function mergedEdges(graph: ModuleGraph, rel: (f: string) => string): Map<string, MergedEdge> {
  const merged = new Map<string, MergedEdge>();
  for (const list of graph.edges.values()) {
    for (const edge of list) {
      const key = `${rel(edge.from)}|${rel(edge.to)}`;
      const existing = merged.get(key);
      if (existing) {
        edge.names.forEach((n) => existing.names.add(n));
        existing.typeOnly &&= edge.typeOnly;
      } else {
        merged.set(key, { from: rel(edge.from), to: rel(edge.to), names: new Set(edge.names), typeOnly: edge.typeOnly, edge });
      }
    }
  }
  return merged;
}

export interface GraphDiff {
  addedModules: string[];
  removedModules: string[];
  addedEdges: MergedEdge[];
  removedEdges: MergedEdge[];
  changedEdges: { after: MergedEdge; addedNames: string[]; removedNames: string[]; typeOnlyChanged: boolean }[];
  newCycles: string[][];
  /** For each new cycle, the imports between its modules, which are the edges to cut. */
  newCycleEdges: MergedEdge[][];
  /** For each new cycle, whether it also exists without type-only imports, that is, at runtime. */
  newCycleAtRuntime: boolean[];
  resolvedCycles: string[][];
  fanIn: { module: string; before: number; after: number; added: string[]; removed: string[] }[];
}

/** Compares two import graphs by paths relative to `root`, so both revisions line up. */
export function diffGraphs(before: ModuleGraph, after: ModuleGraph, root: string): GraphDiff {
  const rel = (f: string) => path.relative(root, f).replace(/\\/g, '/');
  const beforeModules = new Set([...before.files].map(rel));
  const afterModules = new Set([...after.files].map(rel));
  const beforeEdges = mergedEdges(before, rel);
  const afterEdges = mergedEdges(after, rel);
  const changedEdges: GraphDiff['changedEdges'] = [];
  for (const [key, edge] of afterEdges) {
    const old = beforeEdges.get(key);
    if (!old) {
      continue;
    }
    const addedNames = [...edge.names].filter((n) => !old.names.has(n));
    const removedNames = [...old.names].filter((n) => !edge.names.has(n));
    if (addedNames.length || removedNames.length || old.typeOnly !== edge.typeOnly) {
      changedEdges.push({ after: edge, addedNames, removedNames, typeOnlyChanged: old.typeOnly !== edge.typeOnly });
    }
  }
  const cycleKey = (c: string[]) => c.map(rel).join('|');
  const beforeCycles = new Set(cycles(before).map(cycleKey));
  const afterCycleList = cycles(after);
  const afterCycles = new Set(afterCycleList.map(cycleKey));
  const runtimeCycles = cycles(after, true);
  const fanInOf = (edges: Map<string, MergedEdge>) => {
    const counts = new Map<string, number>();
    for (const edge of edges.values()) {
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
    return counts;
  };
  const fanBefore = fanInOf(beforeEdges);
  const fanAfter = fanInOf(afterEdges);
  const fanIn = [...new Set([...fanBefore.keys(), ...fanAfter.keys()])]
    .map((module) => {
      const importers = (edges: Map<string, MergedEdge>) => new Set([...edges.values()].filter((e) => e.to === module).map((e) => e.from));
      const was = importers(beforeEdges);
      const now = importers(afterEdges);
      return { module, before: fanBefore.get(module) ?? 0, after: fanAfter.get(module) ?? 0, added: [...now].filter((m) => !was.has(m)), removed: [...was].filter((m) => !now.has(m)) };
    })
    .filter((f) => f.before !== f.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 10);
  return {
    addedModules: [...afterModules].filter((m) => !beforeModules.has(m)).sort(),
    removedModules: [...beforeModules].filter((m) => !afterModules.has(m)).sort(),
    addedEdges: [...afterEdges].filter(([key]) => !beforeEdges.has(key)).map(([, e]) => e),
    removedEdges: [...beforeEdges].filter(([key]) => !afterEdges.has(key)).map(([, e]) => e),
    changedEdges,
    newCycles: afterCycleList.filter((c) => !beforeCycles.has(cycleKey(c))).map((c) => c.map(rel)),
    newCycleAtRuntime: afterCycleList
      .filter((c) => !beforeCycles.has(cycleKey(c)))
      .map((c) => {
        const members = new Set(c);
        return runtimeCycles.some((r) => r.some((m) => members.has(m)) && r.every((m) => members.has(m)));
      }),
    newCycleEdges: afterCycleList
      .filter((c) => !beforeCycles.has(cycleKey(c)))
      .map((c) => {
        const members = new Set(c.map(rel));
        return [...afterEdges.values()].filter((e) => members.has(e.from) && members.has(e.to));
      }),
    resolvedCycles: cycles(before)
      .filter((c) => !afterCycles.has(cycleKey(c)))
      .map((c) => c.map(rel)),
    fanIn,
  };
}

/** Dependency Graph Diff: how the import architecture changed between a Git revision and the working tree. */
export function graphDiffReport(diff: GraphDiff, afterFiles: Map<string, string>, root: string, refLabel: string, revision?: { repo: string; ref: string }): Report {
  const builder = new ReportBuilder('graphDiff', `Dependency changes since ${refLabel}`);
  const sourceFiles = new Map<string, ts.SourceFile>();
  const locate = (edge: MergedEdge) => {
    const file = edge.edge.from;
    let sourceFile = sourceFiles.get(file);
    if (!sourceFile) {
      sourceFile = ts.createSourceFile(file, afterFiles.get(file) ?? '', ts.ScriptTarget.Latest, true, scriptKind(file));
      sourceFiles.set(file, sourceFile);
    }
    return builder.span(sourceFile, edge.edge.start, edge.edge.end);
  };
  const names = (set: Iterable<string>) => {
    const list = [...set];
    return list.length === 0 ? 'side effects' : list.includes('*') ? '*' : `{ ${list.join(', ')} }`;
  };
  const byFrom = (edges: MergedEdge[], icon: string, located: boolean): ReportNode[] => {
    const groups = new Map<string, MergedEdge[]>();
    for (const edge of edges) {
      groups.set(edge.from, [...(groups.get(edge.from) ?? []), edge]);
    }
    return [...groups].map(([from, list]) => ({
      label: from,
      description: plural(list.length, 'import'),
      icon: 'file-code',
      // The whole file against the revision, to see the change around the imports.
      action: revision && afterFiles.has(normalizePath(path.join(root, from))) ? { kind: 'compareRevision', ...revision, file: normalizePath(path.join(root, from)) } : undefined,
      expanded: groups.size <= 8,
      children: list.map((e) => ({ label: `→ ${e.to}`, description: `${e.typeOnly ? 'type ' : ''}${names(e.names)}`, icon, location: located ? locate(e) : undefined })),
    }));
  };
  const cycleRow = (cycle: string[], tone: 'error' | 'ok'): ReportNode => ({
    label: cycle.map((m) => path.basename(m)).join(' ⇄ '),
    description: plural(cycle.length, 'module'),
    icon: 'sync',
    tone,
    children: cycle.map((m) => ({ label: m, icon: 'file-code', location: afterFiles.has(normalizePath(path.join(root, m))) ? { file: normalizePath(path.join(root, m)), line: 0, character: 0, endLine: 0, endCharacter: 0 } : undefined })),
  });
  const roots: ReportNode[] = [];
  if (diff.newCycles.length) {
    roots.push({
      label: 'New import cycles',
      description: plural(diff.newCycles.length, 'cycle'),
      icon: 'sync',
      tone: diff.newCycleAtRuntime.some((runtime) => runtime) ? 'error' : 'info',
      expanded: true,
      // A new cycle lists the imports that close it, each opening its line.
      children: diff.newCycles.map((c, i) => ({
        ...cycleRow(c, diff.newCycleAtRuntime[i] === false ? 'ok' : 'error'),
        // A cycle through type-only imports is erased at runtime, so it cannot break module loading.
        ...(diff.newCycleAtRuntime[i] === false ? { tone: 'info' as const, description: `${plural(c.length, 'module')} · type-only: erased at runtime` } : {}),
        expanded: true,
        children: (diff.newCycleEdges[i] ?? []).map((e) => ({ label: `${e.from} → ${e.to}`, description: `${e.typeOnly ? 'type ' : ''}${names(e.names)}`, icon: 'arrow-right', location: locate(e) })),
      })),
    });
  }
  if (diff.resolvedCycles.length) {
    roots.push({ label: 'Cycles removed', description: plural(diff.resolvedCycles.length, 'cycle'), icon: 'pass', tone: 'ok', children: diff.resolvedCycles.map((c) => cycleRow(c, 'ok')) });
  }
  roots.push(
    { label: 'Added imports', description: plural(diff.addedEdges.length, 'import'), icon: 'diff-added', expanded: true, children: byFrom(diff.addedEdges, 'add', true) },
    { label: 'Removed imports', description: plural(diff.removedEdges.length, 'import'), icon: 'diff-removed', expanded: true, children: byFrom(diff.removedEdges, 'remove', false) },
  );
  if (diff.changedEdges.length) {
    roots.push({
      label: 'Changed imports',
      description: plural(diff.changedEdges.length, 'import'),
      icon: 'diff-modified',
      expanded: true,
      children: diff.changedEdges.map((c) => ({
        label: `${c.after.from} → ${c.after.to}`,
        description: [c.addedNames.length ? `+ ${c.addedNames.join(', ')}` : '', c.removedNames.length ? `− ${c.removedNames.join(', ')}` : '', c.typeOnlyChanged ? (c.after.typeOnly ? 'now type-only' : 'now a runtime import') : ''].filter(Boolean).join('  '),
        icon: 'diff-modified',
        location: locate(c.after),
      })),
    });
  }
  if (diff.addedModules.length || diff.removedModules.length) {
    roots.push({
      label: 'Modules',
      description: `+${diff.addedModules.length} −${diff.removedModules.length}`,
      icon: 'files',
      children: [
        ...diff.addedModules.map((m) => ({ label: m, description: 'added', icon: 'diff-added', location: { file: normalizePath(path.join(root, m)), line: 0, character: 0, endLine: 0, endCharacter: 0 } })),
        ...diff.removedModules.map((m) => ({ label: m, description: 'removed', icon: 'diff-removed' })),
      ],
    });
  }
  if (diff.fanIn.length) {
    roots.push({
      label: 'Biggest changes in importers',
      icon: 'graph',
      children: diff.fanIn.map((f) => {
        const file = normalizePath(path.join(root, f.module));
        return {
          label: f.module,
          description: `${f.before} → ${f.after} importers`,
          icon: f.after > f.before ? 'arrow-up' : 'arrow-down',
          location: afterFiles.has(file) ? { file, line: 0, character: 0, endLine: 0, endCharacter: 0 } : undefined,
          // Which modules started or stopped importing it.
          children: [
            ...f.added.map((m) => ({ label: m, description: 'now imports it', icon: 'add' })),
            ...f.removed.map((m) => ({ label: m, description: 'no longer imports it', icon: 'remove' })),
          ],
        };
      }),
    });
  }
  if (diff.newCycles.length) {
    roots.push(
      howToFix([
        'Look at the imports listed under each new cycle: usually one of them was added on this branch and can point elsewhere.',
        'Move shared code into a module both sides import, or change type-only imports to import type.',
      ]),
    );
  }
  if (!diff.addedEdges.length && !diff.removedEdges.length) {
    return builder.finish(roots, 'imports unchanged');
  }
  return builder.finish(roots, `+${diff.addedEdges.length} −${diff.removedEdges.length} imports, ${plural(diff.newCycles.length, 'new cycle')}`);
}
