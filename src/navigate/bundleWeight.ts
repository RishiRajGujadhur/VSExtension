import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ImportEdge, ModuleGraph, extractImports, programGraph } from './moduleGraph';
import { normalizePath } from '../analysis/paths';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';

/**
 * Bundle weight: what a file pulls in when it runs. Its runtime imports are followed through the project (type-only
 * imports cost nothing and dynamic import() loads later, so neither counts), each module is weighed by its source
 * size, and each import of the file says how much it brings in and how much only it brings in: what cutting that
 * import line would save. Packages are listed with the size of the file they load first.
 */

export interface WeighedModule {
  file: string;
  size: number;
  /** The files from the start to this one, the start first. */
  via: string[];
}

export interface DirectImport {
  edge: ImportEdge;
  /** Every module this import reaches, with their weight. */
  modules: number;
  total: number;
  /** What only this import brings in: the saving if the line were cut. */
  exclusive: number;
}

export interface BundleWeight {
  file: string;
  ownSize: number;
  modules: WeighedModule[];
  total: number;
  direct: DirectImport[];
  /** import() calls on the way: loaded only when they run. */
  lazy: { edge: ImportEdge; total: number; modules: number }[];
  typeOnly: ImportEdge[];
}

const runtime = (e: ImportEdge) => !e.typeOnly && e.kind !== 'dynamic';

/** The modules reachable from `starts` along runtime imports, each with the path it was first reached by. */
function reach(graph: ModuleGraph, starts: readonly { file: string; via: string[] }[], skip?: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [...starts];
  while (queue.length) {
    const { file, via } = queue.shift()!;
    if (seen.has(file) || file === skip) continue;
    seen.set(file, via);
    for (const e of graph.edges.get(file) ?? []) if (runtime(e) && !seen.has(e.to)) queue.push({ file: e.to, via: [...via, e.to] });
  }
  return seen;
}

/** Weighs what `file` pulls in at run time; `sizeOf` gives a module's size in bytes. */
export function bundleWeight(graph: ModuleGraph, file: string, sizeOf: (file: string) => number): BundleWeight {
  const all = reach(graph, [{ file, via: [file] }]);
  all.delete(file);
  const modules = [...all].map(([f, via]) => ({ file: f, size: sizeOf(f), via })).sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  const sum = (files: Iterable<string>) => [...files].reduce((n, f) => n + sizeOf(f), 0);
  const own = (graph.edges.get(file) ?? []).filter(runtime);
  // One row per imported module, the first import line of it standing for the others.
  const firstEdge = new Map<string, ImportEdge>();
  for (const e of own) if (!firstEdge.has(e.to) && e.to !== file) firstEdge.set(e.to, e);
  const direct = [...firstEdge.values()].map((edge) => {
    const through = reach(graph, [{ file: edge.to, via: [file, edge.to] }], file);
    // What the other imports reach anyway stays when this line is cut.
    const others = reach(graph, [...firstEdge.values()].filter((o) => o !== edge).map((o) => ({ file: o.to, via: [] })), file);
    return { edge, modules: through.size, total: sum(through.keys()), exclusive: sum([...through.keys()].filter((f) => !others.has(f))) };
  }).sort((a, b) => b.exclusive - a.exclusive || b.total - a.total);
  // Dynamic imports from anything on the way: what they would load on top, when they run.
  const loaded = new Set([file, ...all.keys()]);
  const lazy: BundleWeight['lazy'] = [];
  for (const from of loaded) {
    for (const e of graph.edges.get(from) ?? []) {
      if (e.kind !== 'dynamic' || e.typeOnly || loaded.has(e.to)) continue;
      const extra = [...reach(graph, [{ file: e.to, via: [] }]).keys()].filter((f) => !loaded.has(f));
      lazy.push({ edge: e, total: sum(extra), modules: extra.length });
    }
  }
  const typeOnly = [...loaded].flatMap((f) => (graph.edges.get(f) ?? []).filter((e) => e.typeOnly));
  return { file, ownSize: sizeOf(file), modules, total: sum(all.keys()), direct, lazy: lazy.sort((a, b) => b.total - a.total), typeOnly };
}

/** "980 B", "12.4 KB", "1.2 MB". */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const builtins = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);

/** A package's name from an import specifier: "lodash/get" is lodash, "@scope/pkg/x" is @scope/pkg. */
export function packageName(specifier: string): string | undefined {
  if (/^[./]/.test(specifier) || /^[a-zA-Z]:/.test(specifier)) return undefined;
  const parts = specifier.replace(/^node:/, '').split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The size of the file a package loads first, from its package.json; undefined when it can't be found. */
function packageEntrySize(name: string, fromDir: string): { size?: number; builtin?: boolean } {
  if (builtins.has(name.replace(/^node:/, ''))) return { builtin: true };
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const root = path.join(dir, 'node_modules', name);
    const manifest = path.join(root, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { module?: string; main?: string; exports?: unknown };
        const dot = (pkg.exports && typeof pkg.exports === 'object' ? (pkg.exports as Record<string, unknown>)['.'] : pkg.exports) as unknown;
        const fromExports = typeof dot === 'string' ? dot : dot && typeof dot === 'object' ? ((dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default ?? (dot as Record<string, unknown>).require) : undefined;
        const entry = [pkg.module, typeof fromExports === 'string' ? fromExports : undefined, pkg.main, 'index.js'].find((e): e is string => typeof e === 'string');
        const file = entry && [entry, `${entry}.js`, path.join(entry, 'index.js')].map((e) => path.join(root, e)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
        return { size: file ? fs.statSync(file).size : undefined };
      } catch {
        return {};
      }
    }
    if (path.dirname(dir) === dir) return {};
  }
}

const at = (file: string, line: number) => ({ file, line, character: 0, endLine: line, endCharacter: 0 });

/** Bundle weight of a file, as a report. */
export function bundleWeightReport(program: ts.Program, fileName: string, root?: string): Report {
  const file = normalizePath(fileName);
  const graph = programGraph(program);
  const texts = new Map(program.getSourceFiles().map((sf) => [normalizePath(sf.fileName), sf.text]));
  const sizeOf = (f: string) => Buffer.byteLength(texts.get(f) ?? '', 'utf8');
  const weight = bundleWeight(graph, file, sizeOf);
  const sourceOf = (f: string) => program.getSourceFile(f) ?? program.getSourceFiles().find((s) => normalizePath(s.fileName) === f);
  const start = sourceOf(file);
  const name = path.basename(file);
  const builder = new ReportBuilder('bundleWeight', `Bundle weight of ${name}`);
  const rel = (f: string) => (root ? path.relative(root, f).replace(/\\/g, '/') : path.basename(f));
  const short = (via: string[]) => via.slice(1, -1).map((f) => path.basename(f)).join(' → ');

  // Packages: bare imports of every module that runs, with who imports them.
  const packages = new Map<string, { from: { file: string; line: number }[] }>();
  for (const f of [file, ...weight.modules.map((m) => m.file)]) {
    const sf = sourceOf(f);
    if (!sf) continue;
    for (const raw of extractImports(sf)) {
      const pkg = !raw.typeOnly && raw.kind !== 'dynamic' ? packageName(raw.specifier) : undefined;
      if (!pkg) continue;
      const entry = packages.get(pkg) ?? { from: [] };
      entry.from.push({ file: f, line: sf.getLineAndCharacterOfPosition(raw.node.getStart(sf)).line });
      packages.set(pkg, entry);
    }
  }
  const packageRows = [...packages].map(([pkg, { from }]) => {
    const { size, builtin } = packageEntrySize(pkg, path.dirname(file));
    return { pkg, from, size, builtin };
  }).sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || a.pkg.localeCompare(b.pkg));

  const roots: ReportNode[] = [];
  if (weight.direct.length) {
    roots.push({
      label: 'Its imports, heaviest first',
      description: 'what each brings in; cut a line to drop what only it brings',
      icon: 'arrow-circle-down',
      expanded: true,
      children: weight.direct.map((d) => ({
        label: `'${d.edge.specifier}'`,
        description: `${formatSize(d.total)} with ${plural(d.modules, 'module')}${d.exclusive < d.total ? ` · ${formatSize(d.exclusive)} only through it` : ''} · line ${d.edge.line + 1}`,
        tooltip: `${path.basename(d.edge.to)} and what it imports: ${formatSize(d.total)}. Removing this import saves ${formatSize(d.exclusive)}; the rest is pulled in by other imports too.`,
        icon: 'file-code',
        tone: weight.total && d.exclusive / weight.total > 0.3 ? ('warning' as const) : undefined,
        location: start ? builder.span(start, d.edge.start, d.edge.end) : at(file, d.edge.line),
      })),
    });
  }
  if (weight.modules.length) {
    roots.push({
      label: 'Modules it pulls in',
      description: `${plural(weight.modules.length, 'module')}, ${formatSize(weight.total)}`,
      icon: 'files',
      expanded: weight.modules.length <= 12,
      children: weight.modules.slice(0, 200).map((m) => ({
        label: path.basename(m.file),
        description: `${formatSize(m.size)}${m.via.length > 2 ? ` · via ${short(m.via)}` : ' · imported here'}${/(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/](__tests__|tests?)[\\/]/.test(m.file) ? ' · test code pulled into the bundle' : ''}${/(^|[\\/])index\.[cm]?[jt]sx?$/.test(m.file) ? ' · barrel' : ''}`,
        tooltip: `${rel(m.file)}\n${m.via.map((f) => path.basename(f)).join(' → ')}`,
        icon: 'file-code',
        location: at(m.file, 0),
      })),
    });
  }
  if (packageRows.length) {
    roots.push({
      label: 'Packages',
      description: `${plural(packageRows.length, 'package')}; sizes are of the file each one loads first`,
      icon: 'package',
      expanded: true,
      children: packageRows.map((p) => ({
        label: p.pkg,
        description: [p.builtin ? 'built into Node: no weight' : p.size !== undefined ? `${formatSize(p.size)} entry file` : 'size unknown (not installed?)', `imported in ${plural(new Set(p.from.map((f) => f.file)).size, 'file')}`].join(' · '),
        tooltip: p.from.map((f) => `${rel(f.file)}:${f.line + 1}`).join('\n'),
        icon: p.builtin ? 'server-process' : 'package',
        location: at(p.from[0].file, p.from[0].line),
      })),
    });
  }
  if (weight.lazy.length) {
    roots.push({
      label: 'Loaded later with import()',
      description: 'not in the first load: only when the call runs',
      icon: 'clock',
      expanded: false,
      children: weight.lazy.map((l) => ({ label: `import('${l.edge.specifier}')`, description: `${formatSize(l.total)} more, ${plural(l.modules, 'module')} · ${path.basename(l.edge.from)}:${l.edge.line + 1}`, icon: 'clock', location: at(l.edge.from, l.edge.line) })),
    });
  }
  if (weight.typeOnly.length) {
    roots.push({
      label: 'Type-only imports: no weight',
      description: `${plural(weight.typeOnly.length, 'import')} erased when compiled`,
      icon: 'symbol-type-parameter',
      tone: 'ok',
      expanded: false,
      children: weight.typeOnly.slice(0, 100).map((e) => ({ label: `'${e.specifier}'`, description: `${path.basename(e.from)}:${e.line + 1}`, icon: 'symbol-type-parameter', location: at(e.from, e.line) })),
    });
  }
  if (!weight.modules.length && !packageRows.length) {
    roots.push({ label: `${name} imports nothing that runs`, description: `its own ${formatSize(weight.ownSize)} is all it weighs`, icon: 'pass', tone: 'ok' });
  } else {
    roots.push({
      label: 'How to make it lighter',
      icon: 'lightbulb',
      expanded: false,
      children: [
        { label: 'Import types with import type: they cost nothing at run time.' },
        { label: 'Load rarely used code with import() when it is needed, not up front.' },
        { label: 'Import from the module itself rather than an index.ts barrel, which can pull in its siblings too.' },
        { label: 'For a big package, import the part you use (lodash/get, not lodash), or a lighter package.' },
      ],
    });
  }
  const summary = `${plural(weight.modules.length, 'module')}, ${formatSize(weight.total)} of project code on top of its own ${formatSize(weight.ownSize)}${packageRows.length ? `, plus ${plural(packageRows.filter((p) => !p.builtin).length, 'package')}` : ''}`;
  // Every file weighed is remembered, so the report says when one of them changed.
  for (const m of weight.modules) {
    const sf = sourceOf(m.file);
    if (sf) builder.span(sf, 0, 0);
  }
  return builder.finish(roots, summary);
}
