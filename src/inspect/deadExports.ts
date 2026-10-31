import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath } from '../analysis/paths';
import { projectSourceFiles, resolveAlias } from '../analysis/referenceIndex';
import { discoverTests } from '../analysis/testDiscovery';
import { ReportBuilder, ReportNode, Report, plural } from '../structure/report';
import { programGraph, reachableFrom } from '../navigate/moduleGraph';

export interface DeadExportOptions {
  /** Files whose exports are the public API. When empty, files nothing imports are used. */
  entryPoints: readonly string[];
  /** Count test files as entry points, so exports used only by tests are alive. */
  testsAreEntryPoints: boolean;
  /** Files excluded from the results, though still read for usages. */
  isExcluded?: (fileName: string) => boolean;
}

export interface DeadExport {
  name: string;
  declaration: ts.Node;
  /** Used inside its own module, so only the `export` keyword is unnecessary. */
  usedLocally: boolean;
}

export interface DeadExportResult {
  entries: string[];
  unreachable: { sourceFile: ts.SourceFile; exports: DeadExport[] }[];
  unused: { sourceFile: ts.SourceFile; exports: DeadExport[] }[];
  inferredEntries: boolean;
}

/** Dead Export Analyzer: exports nothing reachable from the entry points uses. */
export function findDeadExports(program: ts.Program, options: DeadExportOptions): DeadExportResult {
  const checker = program.getTypeChecker();
  const files = projectSourceFiles(program);
  const graph = programGraph(program);
  let entries = options.entryPoints.map(normalizePath).filter((f) => graph.files.has(f));
  const inferredEntries = entries.length === 0;
  if (inferredEntries) {
    const imported = new Set([...graph.edges.values()].flat().map((e) => e.to));
    entries = [...graph.files].filter((f) => !imported.has(f));
  }
  const entrySet = new Set(entries);
  if (options.testsAreEntryPoints) {
    for (const sourceFile of files) {
      if (discoverTests(sourceFile).isTestFile) {
        entrySet.add(normalizePath(sourceFile.fileName));
      }
    }
  }
  const reachable = reachableFrom(graph, entrySet);

  // Which files use each declaration, keyed by declaration node.
  const usedBy = new Map<ts.Node, Set<string>>();
  const markSymbol = (symbol: ts.Symbol | undefined, file: string) => {
    if (!symbol) {
      return;
    }
    const resolved = resolveAlias(checker, symbol);
    for (const declaration of resolved.declarations ?? []) {
      let users = usedBy.get(declaration);
      if (!users) {
        users = new Set();
        usedBy.set(declaration, users);
      }
      users.add(file);
    }
  };
  const markAllExports = (moduleSymbol: ts.Symbol | undefined, file: string) => {
    if (moduleSymbol) {
      checker.getExportsOfModule(moduleSymbol).forEach((s) => markSymbol(s, file));
    }
  };

  for (const sourceFile of files) {
    const file = normalizePath(sourceFile.fileName);
    if (!reachable.has(file)) {
      continue;
    }
    if (entrySet.has(file)) {
      // The public API, including everything re-exported through it.
      markAllExports(checker.getSymbolAtLocation(sourceFile), 'entry point');
    }
    const visit = (node: ts.Node) => {
      if (ts.isExportDeclaration(node) && !entrySet.has(file)) {
        // A re-export only forwards a name; it is a use only if someone imports it from here.
        return;
      }
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        markSymbol(symbol, file);
        // `import * as ns` used as a value: every export may be accessed.
        if (symbol && symbol.flags & ts.SymbolFlags.Alias && symbol.declarations?.some(ts.isNamespaceImport) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
          markAllExports(resolveAlias(checker, symbol), file);
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0]) {
        markAllExports(checker.getSymbolAtLocation(node.arguments[0]), file);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const result: DeadExportResult = { entries: [...entrySet], unreachable: [], unused: [], inferredEntries };
  for (const sourceFile of files) {
    const file = normalizePath(sourceFile.fileName);
    if (entrySet.has(file) || options.isExcluded?.(file)) {
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      continue;
    }
    const dead: DeadExport[] = [];
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = resolveAlias(checker, exported);
      const declaration = resolved.declarations?.find((d) => d.getSourceFile() === sourceFile);
      if (!declaration) {
        // Re-exported from elsewhere: judged where it is declared.
        continue;
      }
      const users = new Set<string>();
      for (const d of resolved.declarations ?? []) {
        usedBy.get(d)?.forEach((u) => users.add(u));
      }
      const external = [...users].filter((u) => u !== file);
      if (external.length === 0 || !reachable.has(file)) {
        dead.push({ name: exported.name, declaration, usedLocally: users.has(file) });
      }
    }
    if (!reachable.has(file)) {
      result.unreachable.push({ sourceFile, exports: dead });
    } else if (dead.length > 0) {
      result.unused.push({ sourceFile, exports: dead });
    }
  }
  return result;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) {
    // Importing a name is a use of the export.
    return false;
  }
  return (parent as ts.NamedDeclaration).name === node;
}

export function deadExportReport(program: ts.Program, options: DeadExportOptions, root?: string): Report {
  const result = findDeadExports(program, options);
  const builder = new ReportBuilder('deadExports', 'Dead exports');
  const relative = (sf: ts.SourceFile) => (root ? path.relative(root, sf.fileName).replace(/\\/g, '/') : path.basename(sf.fileName));
  if (result.inferredEntries) {
    builder.warnings.push('No entry points are configured or found in package.json, so files that nothing imports are treated as entry points. Set tsStructure.deadExports.entryPoints for precise results.');
  }
  const exportRow = (sf: ts.SourceFile, e: DeadExport): ReportNode => ({
    label: e.name,
    description: e.usedLocally ? 'used only inside this module' : 'unused',
    icon: 'symbol-misc',
    tone: e.usedLocally ? 'info' : 'warning',
    location: builder.at(nameOf(e.declaration), sf),
    action: { kind: e.usedLocally ? 'unexport' : 'deadExport', file: normalizePath(sf.fileName), name: e.name },
  });
  const unusedOnly = result.unused.map((u) => ({ ...u, exports: u.exports.filter((e) => !e.usedLocally) })).filter((u) => u.exports.length);
  const localOnly = result.unused.map((u) => ({ ...u, exports: u.exports.filter((e) => e.usedLocally) })).filter((u) => u.exports.length);
  const fileGroup = (group: { sourceFile: ts.SourceFile; exports: DeadExport[] }, note?: string): ReportNode => ({
    label: path.basename(group.sourceFile.fileName),
    description: `${note ? `${note} · ` : ''}${relative(group.sourceFile)}`,
    icon: 'file-code',
    location: builder.at(group.sourceFile),
    children: group.exports.map((e) => exportRow(group.sourceFile, e)),
  });
  const count = (groups: { exports: DeadExport[] }[]) => groups.reduce((n, g) => n + g.exports.length, 0);
  const roots: ReportNode[] = [];
  if (result.unreachable.length) {
    roots.push({
      label: 'Unreachable modules',
      description: `${plural(result.unreachable.length, 'module')} no entry point imports`,
      icon: 'debug-disconnect',
      tone: 'warning',
      expanded: true,
      children: result.unreachable.map((g) => ({ ...fileGroup(g, plural(g.exports.length, 'export')), action: { kind: 'deadFile', file: normalizePath(g.sourceFile.fileName) } })),
    });
  }
  if (unusedOnly.length) {
    roots.push({ label: 'Unused exports', description: plural(count(unusedOnly), 'export'), icon: 'symbol-misc', tone: 'warning', expanded: true, children: unusedOnly.map((g) => fileGroup(g)) });
  }
  if (localOnly.length) {
    roots.push({ label: 'Exported but only used locally', description: plural(count(localOnly), 'export'), icon: 'eye-closed', tone: 'info', children: localOnly.map((g) => fileGroup(g)) });
  }
  roots.push({
    label: 'Entry points',
    description: `${result.entries.length}${options.testsAreEntryPoints ? ', including test files' : ''}`,
    icon: 'debug-start',
    children: result.entries.map((e) => ({ label: path.basename(e), description: root ? path.relative(root, e).replace(/\\/g, '/') : undefined, icon: 'file', location: { file: e, line: 0, character: 0, endLine: 0, endCharacter: 0 } })),
  });
  return builder.finish(roots, `${plural(count(unusedOnly), 'unused export')}, ${plural(result.unreachable.length, 'unreachable module')}`);
}

function nameOf(declaration: ts.Node): ts.Node {
  const name = (declaration as ts.NamedDeclaration).name;
  return name ?? declaration;
}
