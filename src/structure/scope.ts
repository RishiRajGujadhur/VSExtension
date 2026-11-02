import { pathKey } from '../analysis/paths';
import { ReportLocation, ReportNode } from './report';

/**
 * Part of a project to analyze: some files, everything under some folders, or lines of one file.
 * With nothing set it is the whole project.
 */
export interface ScopeSpec {
  /** Absolute file paths. */
  files?: readonly string[];
  /** Absolute folder paths; every file below them is inside. */
  folders?: readonly string[];
  /** Zero-based, inclusive lines of one file, such as a function or a selection. */
  lines?: { file: string; start: number; end: number };
}

/** A test for whether a file is inside the scope, with the paths keyed once. */
export function scopeFilter(spec: ScopeSpec): (fileName: string) => boolean {
  const files = new Set([...(spec.files ?? []), ...(spec.lines ? [spec.lines.file] : [])].map(pathKey));
  const folders = (spec.folders ?? []).map((f) => `${pathKey(f).replace(/\/$/, '')}/`);
  if (files.size === 0 && folders.length === 0) {
    return () => true;
  }
  return (fileName) => {
    const key = pathKey(fileName);
    return files.has(key) || folders.some((folder) => key.startsWith(folder));
  };
}

/** Whether a result location is inside the scope; with `lines`, it must overlap them. */
export function locationFilter(spec: ScopeSpec): (location: ReportLocation) => boolean {
  const inFile = scopeFilter(spec);
  const lines = spec.lines;
  if (!lines) {
    return (location) => inFile(location.file);
  }
  const file = pathKey(lines.file);
  return (location) => (pathKey(location.file) === file ? location.endLine >= lines.start && location.line <= lines.end : inFile(location.file));
}

/**
 * The rows with a location inside the scope, with the groups that lead to them. A row inside keeps
 * its children that are inside too, or all of them when none are (they are its details).
 */
export function limitReport(nodes: readonly ReportNode[], inside: (location: ReportLocation) => boolean): ReportNode[] {
  const result: ReportNode[] = [];
  for (const node of nodes) {
    const children = limitReport(node.children ?? [], inside);
    const own = !!node.location && inside(node.location);
    if (own || children.length > 0) {
      const kept = children.length ? children : own ? node.children : undefined;
      // A group's own count, such as "3 (1 in tests)", would count the rows left out.
      const [before, after] = [countResults(node.children ?? []), countResults(kept ?? [])];
      result.push({ ...node, children: kept, description: after < before ? `${after} of ${before}` : node.description });
    }
  }
  return result;
}

/** Counts the rows with a location and nothing below them: the results, not the groups. */
export function countResults(nodes: readonly ReportNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.children?.length ? countResults(node.children) : node.location ? 1 : 0), 0);
}
