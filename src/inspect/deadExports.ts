import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath } from '../analysis/paths';
import { findNode } from '../analysis/impact';
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
  /** Barrels that still forward the name, which would need updating if it is removed. */
  reexportedBy?: string[];
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
  // Files a framework loads by convention, such as Next.js pages or Storybook stories.
  for (const sourceFile of files) {
    if (isConventionalEntry(sourceFile.fileName)) {
      entrySet.add(normalizePath(sourceFile.fileName));
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

  // Which modules forward which names of each module: `export { a } from './x'` and `export * from './x'`.
  const forwards = new Map<ts.SourceFile, { by: string; names: Set<string> | '*' }[]>();
  for (const sourceFile of files) {
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
        continue;
      }
      const target = checker.getSymbolAtLocation(statement.moduleSpecifier)?.valueDeclaration;
      if (target && ts.isSourceFile(target)) {
        const names = statement.exportClause && ts.isNamedExports(statement.exportClause) ? new Set(statement.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)) : '*';
        forwards.set(target, [...(forwards.get(target) ?? []), { by: normalizePath(sourceFile.fileName), names }]);
      }
    }
  }
  const forwardersOf = (sourceFile: ts.SourceFile, name: string) => {
    const by = (forwards.get(sourceFile) ?? []).filter((f) => f.names === '*' || f.names.has(name)).map((f) => f.by);
    return by.length ? by : undefined;
  };

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
      if (!declaration || isPublicApi(declaration)) {
        // Re-exported from elsewhere, judged where it is declared; or kept on purpose.
        continue;
      }
      const users = new Set<string>();
      for (const d of resolved.declarations ?? []) {
        usedBy.get(d)?.forEach((u) => users.add(u));
      }
      const external = [...users].filter((u) => u !== file);
      if (external.length === 0 || !reachable.has(file)) {
        dead.push({ name: exported.name, declaration, usedLocally: users.has(file), reexportedBy: forwardersOf(sourceFile, exported.name) });
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

/** Exports documented with `@public` or `@api` are part of an API on purpose, whether or not the project uses them. */
function isPublicApi(declaration: ts.Node): boolean {
  return ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'public' || tag.tagName.text === 'api');
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
    description: [
      e.usedLocally ? 'used only inside this module' : 'unused',
      isTypeOnly(e.declaration) ? 'type' : undefined,
      e.reexportedBy ? `re-exported by ${e.reexportedBy.map((f) => path.basename(f)).join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    icon: declarationIcon(e.declaration),
    tone: e.usedLocally ? 'info' : 'warning',
    location: builder.at(nameOf(e.declaration), sf),
    action: { kind: e.usedLocally ? 'unexport' : 'deadExport', file: normalizePath(sf.fileName), name: e.name },
  });
  const unusedOnly = result.unused.map((u) => ({ ...u, exports: u.exports.filter((e) => !e.usedLocally) })).filter((u) => u.exports.length);
  const localOnly = result.unused.map((u) => ({ ...u, exports: u.exports.filter((e) => e.usedLocally) })).filter((u) => u.exports.length);
  const count = (groups: { exports: DeadExport[] }[]) => groups.reduce((n, g) => n + g.exports.length, 0);
  // Small results open fully, so the names are visible without expanding each file.
  const fewEnough = (groups: { exports: DeadExport[] }[]) => count(groups) <= 15;
  const fileGroup = (group: { sourceFile: ts.SourceFile; exports: DeadExport[] }, expanded: boolean, note?: string): ReportNode => ({
    label: path.basename(group.sourceFile.fileName),
    description: `${note ?? plural(group.exports.length, 'export')} · ${relative(group.sourceFile)}`,
    icon: 'file-code',
    location: builder.at(group.sourceFile),
    expanded,
    children: group.exports.map((e) => exportRow(group.sourceFile, e)),
  });
  const roots: ReportNode[] = [];
  if (result.unreachable.length) {
    roots.push({
      label: 'Unreachable modules',
      description: `${plural(result.unreachable.length, 'module')} no entry point imports`,
      icon: 'debug-disconnect',
      tone: 'warning',
      expanded: true,
      children: result.unreachable.map((g) => ({ ...fileGroup(g, result.unreachable.length <= 3 && fewEnough(result.unreachable), plural(g.exports.length, 'export')), action: { kind: 'deadFile', file: normalizePath(g.sourceFile.fileName) } })),
    });
  }
  if (unusedOnly.length) {
    roots.push({ label: 'Unused exports', description: plural(count(unusedOnly), 'export'), icon: 'symbol-misc', tone: 'warning', expanded: true, children: unusedOnly.map((g) => fileGroup(g, fewEnough(unusedOnly))) });
  }
  if (localOnly.length) {
    roots.push({
      label: 'Exported but only used locally',
      description: plural(count(localOnly), 'export'),
      icon: 'eye-closed',
      tone: 'info',
      // Without a file: every file below it at once.
      action: { kind: 'unexportAll' },
      children: localOnly.map((g) => ({ ...fileGroup(g, fewEnough(localOnly)), action: { kind: 'unexportAll', file: normalizePath(g.sourceFile.fileName) } })),
    });
  }
  roots.push({
    label: 'Entry points',
    description: `${result.entries.length}${options.testsAreEntryPoints ? ', including test files' : ''}`,
    icon: 'debug-start',
    children: result.entries.map((e) => ({ label: path.basename(e), description: root ? path.relative(root, e).replace(/\\/g, '/') : undefined, icon: 'file', location: { file: e, line: 0, character: 0, endLine: 0, endCharacter: 0 } })),
  });
  return builder.finish(roots, `${plural(count(unusedOnly), 'unused export')}, ${plural(result.unreachable.length, 'unreachable module')}${localOnly.length ? `, ${count(localOnly)} only used locally` : ''}`);
}

function declarationIcon(declaration: ts.Node): string {
  if (ts.isFunctionDeclaration(declaration) || (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)))) {
    return 'symbol-function';
  }
  if (ts.isClassDeclaration(declaration)) {
    return 'symbol-class';
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return 'symbol-interface';
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return 'symbol-type-parameter';
  }
  if (ts.isEnumDeclaration(declaration)) {
    return 'symbol-enum';
  }
  if (ts.isVariableDeclaration(declaration)) {
    return ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const ? 'symbol-constant' : 'symbol-variable';
  }
  return 'symbol-misc';
}

/** Interfaces and type aliases: removing them never changes runtime behavior. */
function isTypeOnly(declaration: ts.Node): boolean {
  return ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration);
}

function nameOf(declaration: ts.Node): ts.Node {
  const name = (declaration as ts.NamedDeclaration).name;
  return name ?? declaration;
}

/**
 * Where to add `@public` to the top-level declaration at the offset: inside its JSDoc when it has
 * one, or as a new JSDoc line above it.
 */
export function publicTagEdit(sourceFile: ts.SourceFile, offset: number): { offset: number; text: string } | undefined {
  let statement: ts.Node | undefined = findNode(sourceFile, offset);
  while (statement && statement.parent && !ts.isSourceFile(statement.parent)) {
    statement = statement.parent;
  }
  if (!statement || ts.isSourceFile(statement)) {
    return undefined;
  }
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, statement.pos) ?? [];
  const doc = [...comments].reverse().find((c) => text.startsWith('/**', c.pos));
  const start = statement.getStart(sourceFile);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  if (!doc) {
    return { offset: lineStart, text: `${indent}/** @public */\n` };
  }
  const close = doc.end - 2;
  if (!text.slice(doc.pos, doc.end).includes('\n')) {
    // `/** Totals. */` becomes `/** Totals. @public */`.
    return { offset: close, text: text[close - 1] === ' ' ? '@public ' : ' @public ' };
  }
  // A multi-line comment gets a line of its own before the closing `*/`.
  const closeLine = text.lastIndexOf('\n', close - 1) + 1;
  return { offset: closeLine, text: `${indent} * @public\n` };
}

/** Files a framework loads by convention and whose exports it uses, so they count as entry points. */
const entryConventions: { pattern: RegExp; what: string }[] = [];

/** What makes the file an entry point by convention, such as `Next.js page`, or undefined. */
export function isConventionalEntry(fileName: string): string | undefined {
  const normalized = fileName.replace(/\\/g, '/');
  return entryConventions.find((c) => c.pattern.test(normalized))?.what;
}

entryConventions.push({ pattern: /\/pages\/(?!(.*\/)?(components?|lib|utils?)\/)[^]*\.[cm]?[jt]sx?$/, what: 'Next.js page' });

entryConventions.push({ pattern: /(\/app\/([^]*\/)?(page|layout|template|loading|error|not-found|global-error|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)|(^|\/)(src\/)?(middleware|instrumentation))\.[cm]?[jt]sx?$/, what: 'Next.js app route' });

entryConventions.push({ pattern: /(\.(stories|story)\.[cm]?[jt]sx?$)|(\/\.storybook\/)/, what: 'Storybook story' });

entryConventions.push({ pattern: /(^|\/)([\w-]+\.config|\.?(eslintrc|prettierrc|babelrc|commitlintrc|lintstagedrc))\.[cm]?[jt]s$/, what: 'tool config file' });

entryConventions.push({ pattern: /\/app\/(routes\/[^]*|root|entry\.client|entry\.server)\.[cm]?[jt]sx?$/, what: 'route module' });

entryConventions.push({ pattern: /(\/\+(page|layout|server|error)(\.server)?\.[cm]?[jt]s$)|(\/hooks\.(server|client)\.[cm]?[jt]s$)|(\/server\/(api|routes|middleware)\/[^]*\.[cm]?[jt]s$)|(\/src\/(pages|middleware)\/[^]*\.[cm]?[jt]s$)/, what: 'framework route' });

entryConventions.push({ pattern: /(^|\/)(setupTests|setup-tests|test-setup|testSetup|vitest\.setup|jest\.setup|global-setup|globalSetup)\.[cm]?[jt]sx?$/, what: 'test setup file' });

entryConventions.push({ pattern: /((^|\/)(sw|service-worker|[\w-]+\.worker)\.[cm]?[jt]s$)|((^|\/)scripts\/[^/]+\.[cm]?[jt]s$)/, what: 'worker or script' });
