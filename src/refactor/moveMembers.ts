import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath, pathKey } from '../analysis/paths';
import { introducedErrors, EditCollector, applyFileEdits } from './common';
import { replace } from './edits';
import { Conflict, RefactorError, RefactorResult } from './types';
import { VirtualProject, formatOptions, preferences } from './virtualProject';

export interface MovableMember {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
}

/** Top-level declarations of a module that can be moved. */
export function listMovableMembers(project: VirtualProject, fileName: string): MovableMember[] {
  const sourceFile = project.sourceFile(fileName);
  return sourceFile.statements.flatMap((statement) =>
    namesOf(statement).map((name) => ({
      name,
      kind: kindOf(statement),
      exported: isExported(statement),
      line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line,
    })),
  );
}

export interface MoveOptions {
  /** Leave `export { … } from './target'` in the source module so its public API is unchanged. */
  keepReExport: boolean;
}

/**
 * Moves top-level declarations into another module, existing or new. Imports of the moved
 * declarations are updated everywhere, re-exports of them are redirected, and anything the moved
 * code still needs from the source module is exported and imported.
 */
export function moveMembers(project: VirtualProject, fileName: string, names: string[], targetFile: string, options: MoveOptions): RefactorResult {
  const source = normalizePath(fileName);
  const target = normalizePath(targetFile);
  if (pathKey(source) === pathKey(target)) {
    throw new RefactorError('Choose a different module to move to.');
  }
  if (names.length === 0) {
    throw new RefactorError('Select at least one declaration to move.');
  }
  const available = new Set(listMovableMembers(project, source).map((m) => m.name));
  const missing = names.filter((n) => !available.has(n));
  if (missing.length > 0) {
    throw new RefactorError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not a top-level declaration of ${path.basename(source)}.`);
  }
  const targetText = project.text(target);
  if (targetText !== undefined) {
    const targetNames = new Set(project.sourceFile(target).statements.flatMap(namesOf));
    const clashes = names.filter((n) => targetNames.has(n));
    if (clashes.length > 0) {
      throw new RefactorError(`${path.basename(target)} already declares ${clashes.join(', ')}.`);
    }
  }

  const exportedBefore = new Set(listMovableMembers(project, source).filter((m) => m.exported).map((m) => m.name));
  const reExporters = findReExporters(project, source, names);
  const quote = quoteStyle(project.sourceFile(source));
  const conflicts: Conflict[] = [];

  // Move one contiguous run of statements at a time, re-reading positions after each move.
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const sourceFile = project.sourceFile(source);
    const statements = sourceFile.statements;
    const first = statements.findIndex((s) => namesOf(s).some((n) => remaining.has(n)));
    let last = first;
    while (last + 1 < statements.length && namesOf(statements[last + 1]).every((n) => remaining.has(n)) && namesOf(statements[last + 1]).length > 0) {
      last++;
    }
    const run = statements.slice(first, last + 1);
    const unwanted = run.flatMap(namesOf).filter((n) => !remaining.has(n));
    if (unwanted.length > 0) {
      throw new RefactorError(`${unwanted.join(', ')} is declared in the same statement as ${namesOf(run[0]).filter((n) => remaining.has(n)).join(', ')}; select them together.`);
    }
    const range = { pos: run[0].getStart(sourceFile), end: run[run.length - 1].end };
    const edits = project.service.getEditsForRefactor(source, formatOptions, range, 'Move to file', 'Move to file', { ...preferences, quotePreference: quote }, { targetFile: target });
    if (!edits || edits.edits.length === 0) {
      throw new RefactorError(`TypeScript cannot move ${run.flatMap(namesOf).join(', ')}.`);
    }
    project.applyTextChanges(edits.edits);
    run.flatMap(namesOf).forEach((n) => remaining.delete(n));
  }

  redirectReExports(project, reExporters, target, quote, conflicts);

  if (options.keepReExport) {
    const kept = names.filter((n) => exportedBefore.has(n));
    if (kept.length > 0) {
      const specifier = moduleSpecifier(source, target, undefined);
      const text = project.text(source) ?? '';
      const statement = `export { ${kept.join(', ')} } from ${quote === 'single' ? `'${specifier}'` : `"${specifier}"`};\n`;
      project.setText(source, text.endsWith('\n') || text === '' ? text + statement : `${text}\n${statement}`);
    }
  }

  const label = `Move ${names.length === 1 ? names[0] : `${names.length} declarations`} to ${path.basename(target)}`;
  conflicts.push(...introducedErrors(project));
  return { label, changes: project.changes(), conflicts };
}

interface ReExporter {
  file: string;
  declaration: ts.ExportDeclaration;
  /** Specifiers naming moved declarations, by their name in the source module. */
  moved: ts.ExportSpecifier[];
}

/** `export { a } from './source'` and `export * from './source'` statements that expose moved names. */
function findReExporters(project: VirtualProject, source: string, names: string[]): ReExporter[] {
  const program = project.program();
  const checker = program.getTypeChecker();
  const sourceFile = project.sourceFile(source);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const result: ReExporter[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file === sourceFile) {
      continue;
    }
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || checker.getSymbolAtLocation(statement.moduleSpecifier) !== moduleSymbol) {
        continue;
      }
      const moved =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.filter((e) => names.includes((e.propertyName ?? e.name).text))
          : [];
      if (moved.length > 0 || !statement.exportClause) {
        result.push({ file: normalizePath(file.fileName), declaration: statement, moved });
      }
    }
  }
  return result;
}

/** Points re-exports of moved names at the target module. Positions come from the original text, so this runs as one batch per file. */
function redirectReExports(project: VirtualProject, reExporters: ReExporter[], target: string, quote: 'single' | 'double', conflicts: Conflict[]): void {
  const edits = new EditCollector();
  for (const { file, declaration, moved } of reExporters) {
    if (!declaration.exportClause) {
      conflicts.push({
        message: `${path.basename(file)} has 'export *' from the source module, which no longer includes the moved declarations; add an export from ${path.basename(target)} if needed.`,
      });
      continue;
    }
    const sourceFile = declaration.getSourceFile();
    // The language service may have edited this file already; only rewrite it if the statement is unchanged.
    const current = project.text(file) ?? '';
    const statementText = declaration.getText(sourceFile);
    const at = current.indexOf(statementText);
    if (at < 0) {
      continue;
    }
    const elements = (declaration.exportClause as ts.NamedExports).elements;
    const keep = elements.filter((e) => !moved.includes(e)).map((e) => e.getText(sourceFile));
    const original = (declaration.moduleSpecifier as ts.StringLiteral).text;
    const specifier = moduleSpecifier(file, target, original);
    const literal = quote === 'single' ? `'${specifier}'` : `"${specifier}"`;
    const typeOnly = declaration.isTypeOnly ? 'type ' : '';
    const lines = [
      ...(keep.length > 0 ? [`export ${typeOnly}{ ${keep.join(', ')} } from ${declaration.moduleSpecifier!.getText(sourceFile)};`] : []),
      `export ${typeOnly}{ ${moved.map((e) => e.getText(sourceFile)).join(', ')} } from ${literal};`,
    ];
    edits.add(file, replace(at, at + statementText.length, lines.join('\n')));
  }
  applyFileEdits(project, edits.byFile);
}

/** A relative module specifier from one file to another, following the extension style of `like`. */
export function moduleSpecifier(fromFile: string, toFile: string, like: string | undefined): string {
  let relative = path.posix.relative(path.posix.dirname(normalizePath(fromFile)), normalizePath(toFile));
  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }
  const extension = /\.([cm]?)[jt]sx?$/i.exec(relative);
  if (!extension) {
    return relative;
  }
  const withoutExtension = relative.slice(0, -extension[0].length);
  if (like && /\.[cm]?jsx?$/i.test(like)) {
    return `${withoutExtension}.${extension[1]}js`; // ESM-style imports name the emitted file.
  }
  if (like && /\.[cm]?tsx?$/i.test(like)) {
    return relative;
  }
  return withoutExtension.replace(/\/index$/, '');
}

function quoteStyle(sourceFile: ts.SourceFile): 'single' | 'double' {
  const firstImport = sourceFile.statements.find((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier);
  const specifier = firstImport && (firstImport as ts.ImportDeclaration).moduleSpecifier;
  if (specifier) {
    return specifier.getText(sourceFile).startsWith("'") ? 'single' : 'double';
  }
  const firstString = /['"]/.exec(sourceFile.text);
  return firstString?.[0] === '"' ? 'double' : 'single';
}

function namesOf(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  return [];
}

function isExported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function kindOf(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement)) return 'function';
  if (ts.isClassDeclaration(statement)) return 'class';
  if (ts.isInterfaceDeclaration(statement)) return 'interface';
  if (ts.isTypeAliasDeclaration(statement)) return 'type';
  if (ts.isEnumDeclaration(statement)) return 'enum';
  if (ts.isModuleDeclaration(statement)) return 'namespace';
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
  }
  return 'declaration';
}
