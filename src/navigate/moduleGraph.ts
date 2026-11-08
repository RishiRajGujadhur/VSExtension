import * as path from 'path';
import ts = require('typescript');
import { isSourceFileName, normalizePath, pathKey } from '../analysis/paths';
import { projectSourceFiles } from '../analysis/referenceIndex';

export type ImportKind = 'import' | 're-export' | 'dynamic' | 'require';

export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  /** Imported or re-exported names; `*` for namespace imports and `export *`, empty for side-effect imports. */
  names: string[];
  typeOnly: boolean;
  kind: ImportKind;
  /** Zero-based line of the import in `from`. */
  line: number;
  start: number;
  end: number;
}

/** Files and their resolved imports, keyed by normalized path. */
export interface ModuleGraph {
  files: Set<string>;
  edges: Map<string, ImportEdge[]>;
}

export interface RawImport {
  specifier: string;
  names: string[];
  typeOnly: boolean;
  kind: ImportKind;
  node: ts.Node;
}

/** Imports, re-exports, dynamic imports and requires, read syntactically from a file. */
export function extractImports(sourceFile: ts.SourceFile): RawImport[] {
  const imports: RawImport[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) {
        names.push('default');
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push('*');
        } else {
          names.push(...clause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text));
        }
      }
      const typeOnly = !!clause?.isTypeOnly || (!!clause && !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      imports.push({ specifier: node.moduleSpecifier.text, names, typeOnly, kind: 'import', node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = !node.exportClause ? ['*'] : ts.isNamespaceExport(node.exportClause) ? ['*'] : node.exportClause.elements.map((e) => (e.propertyName ?? e.name).getText());
      imports.push({ specifier: node.moduleSpecifier.text, names, typeOnly: node.isTypeOnly, kind: 're-export', node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      imports.push({ specifier: node.moduleReference.expression.text, names: ['*'], typeOnly: node.isTypeOnly, kind: 'require', node });
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push({ specifier: node.arguments[0].text, names: ['*'], typeOnly: false, kind: 'dynamic', node });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        imports.push({ specifier: node.arguments[0].text, names: ['*'], typeOnly: false, kind: 'require', node });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      imports.push({ specifier: node.argument.literal.text, names: [node.qualifier?.getText() ?? '*'], typeOnly: true, kind: 'import', node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

/**
 * Builds the import graph of a set of files. `readFile` supplies their text (from disk, open
 * editors or a Git revision); module resolution only sees files in the set plus `node_modules`.
 */
export function buildModuleGraph(fileNames: Iterable<string>, readFile: (fileName: string) => string | undefined, options: ts.CompilerOptions): ModuleGraph {
  const files = new Set<string>();
  const byKey = new Map<string, string>();
  for (const fileName of fileNames) {
    const normalized = normalizePath(fileName);
    files.add(normalized);
    byKey.set(pathKey(normalized), normalized);
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => byKey.has(pathKey(f)) || (/[\\/]node_modules[\\/]/.test(f) && ts.sys.fileExists(f)),
    readFile: (f) => (byKey.has(pathKey(f)) ? readFile(byKey.get(pathKey(f))!) : ts.sys.readFile(f)),
    directoryExists: (d) => ts.sys.directoryExists?.(d) ?? true,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => process.cwd(),
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const cache = ts.createModuleResolutionCache(process.cwd(), (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), options);
  const edges = new Map<string, ImportEdge[]>();
  for (const from of files) {
    const text = readFile(from);
    if (text === undefined) {
      continue;
    }
    const sourceFile = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true, scriptKind(from));
    const list: ImportEdge[] = [];
    for (const raw of extractImports(sourceFile)) {
      const resolved = ts.resolveModuleName(raw.specifier, from, options, host, cache).resolvedModule;
      const to = resolved && byKey.get(pathKey(resolved.resolvedFileName));
      if (!to) {
        continue;
      }
      list.push({
        from,
        to,
        specifier: raw.specifier,
        names: raw.names,
        typeOnly: raw.typeOnly,
        kind: raw.kind,
        line: sourceFile.getLineAndCharacterOfPosition(raw.node.getStart(sourceFile)).line,
        start: raw.node.getStart(sourceFile),
        end: raw.node.end,
      });
    }
    edges.set(from, list);
  }
  return { files, edges };
}

/** The import graph of a compiler project's own source files. */
export function programGraph(program: ts.Program): ModuleGraph {
  const sourceFiles = projectSourceFiles(program);
  const texts = new Map(sourceFiles.map((sf) => [normalizePath(sf.fileName), sf.text]));
  return buildModuleGraph(texts.keys(), (f) => texts.get(f), program.getCompilerOptions());
}

export function scriptKind(fileName: string): ts.ScriptKind {
  return /\.[cm]?tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Files that import each file. */
export function reverseEdges(graph: ModuleGraph): Map<string, ImportEdge[]> {
  const reverse = new Map<string, ImportEdge[]>();
  for (const list of graph.edges.values()) {
    for (const edge of list) {
      reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge]);
    }
  }
  return reverse;
}

/** Files reachable from the given entry files by following imports. */
export function reachableFrom(graph: ModuleGraph, entries: Iterable<string>, includeTypeOnly = true): Set<string> {
  const reached = new Set<string>();
  const queue = [...entries].map(normalizePath).filter((f) => graph.files.has(f));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) {
      continue;
    }
    reached.add(file);
    for (const edge of graph.edges.get(file) ?? []) {
      if (includeTypeOnly || !edge.typeOnly) {
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

/**
 * Likely entry points of a package: files named by package.json (`main`, `module`, `exports`,
 * `bin`, …) mapped back to sources, plus conventional `index` and `main` files.
 */
export function defaultEntryPoints(root: string, files: ReadonlySet<string>): string[] {
  const keyed = new Map([...files].map((f) => [pathKey(f), f]));
  const found = new Set<string>();
  const tryPath = (relative: string) => {
    const withoutExt = relative.replace(/\.(d\.)?[cm]?[jt]sx?$/i, '');
    const stems = [withoutExt, withoutExt.replace(/^(\.\/)?(dist|lib|build|out|esm|cjs)\//, 'src/')];
    for (const stem of stems) {
      for (const extension of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']) {
        const match = keyed.get(pathKey(path.join(root, stem + extension)));
        if (match && isSourceFileName(match)) {
          found.add(match);
          return;
        }
      }
    }
  };
  const text = ts.sys.readFile(path.join(root, 'package.json'));
  if (text) {
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      const collect = (value: unknown): void => {
        if (typeof value === 'string') {
          tryPath(value);
        } else if (value && typeof value === 'object') {
          Object.values(value).forEach(collect);
        }
      };
      ['main', 'module', 'browser', 'bin', 'exports', 'source'].forEach((field) => collect(manifest[field]));
    } catch {
      // A broken manifest has no usable entry points.
    }
  }
  // Conventional names only stand in for a manifest that names no entry: a barrel such as src/index.ts next to
  // `"main": "src/main.ts"` would otherwise keep everything it re-exports alive.
  if (found.size === 0) {
    for (const conventional of ['src/index', 'src/main', 'src/app', 'index', 'main']) {
      tryPath(conventional);
    }
  }
  return [...found];
}
