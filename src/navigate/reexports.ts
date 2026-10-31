import * as path from 'path';
import * as ts from 'typescript';
import { projectSourceFiles, resolveAlias } from '../analysis/referenceIndex';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, lineSnippet, plural } from '../structure/report';
import { identifierAt } from '../structure/util';

export interface ChainStep {
  /** What happens at this hop, such as `export { Square as Box } from './models'`. */
  label: string;
  /** The name the symbol has after this hop. */
  name: string;
  node: ts.Node;
  file: string;
}

/** The module an import or re-export declaration reads from. */
function moduleOf(checker: ts.TypeChecker, declaration: ts.Node): ts.Symbol | undefined {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if ((ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) && current.moduleSpecifier) {
      return checker.getSymbolAtLocation(current.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(current) && ts.isExternalModuleReference(current.moduleReference)) {
      return checker.getSymbolAtLocation(current.moduleReference.expression);
    }
  }
  return undefined;
}

/** `export *` declarations, possibly nested, through which a module reaches the file declaring `next`. */
function starPath(checker: ts.TypeChecker, moduleSymbol: ts.Symbol, next: ts.Symbol, seen = new Set<ts.Symbol>()): ts.ExportDeclaration[] | undefined {
  const sourceFile = moduleSymbol.valueDeclaration;
  const destination = next.declarations?.[0]?.getSourceFile();
  if (!sourceFile || !ts.isSourceFile(sourceFile) || !destination || seen.has(moduleSymbol)) {
    return undefined;
  }
  seen.add(moduleSymbol);
  const target = resolveAlias(checker, next);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) {
      continue;
    }
    const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (!module || !checker.getExportsOfModule(module).some((e) => resolveAlias(checker, e) === target)) {
      continue;
    }
    if (module.valueDeclaration === destination) {
      return [statement];
    }
    const deeper = starPath(checker, module, next, seen);
    if (deeper) {
      return [statement, ...deeper];
    }
  }
  return undefined;
}

function describeAlias(declaration: ts.Declaration): string {
  const statement = ts.findAncestor(declaration, (n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isImportEqualsDeclaration(n));
  return statement ? statement.getText().replace(/\s+/g, ' ') : declaration.getText();
}

/** Follows a name from where it is used, through imports and every re-export, to its declaration. */
export function resolutionChain(checker: ts.TypeChecker, identifier: ts.Node): ChainStep[] {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) {
    throw new AnalysisError('No symbol found at the cursor.');
  }
  const target = resolveAlias(checker, symbol);
  const steps: ChainStep[] = [];
  for (let hops = 0; symbol && symbol.flags & ts.SymbolFlags.Alias && hops < 30; hops++) {
    const declaration = symbol.declarations?.[0];
    if (!declaration) {
      break;
    }
    steps.push({ label: describeAlias(declaration), name: symbol.name, node: declaration, file: declaration.getSourceFile().fileName });
    const next: ts.Symbol | undefined = checker.getImmediateAliasedSymbol(symbol);
    const source = moduleOf(checker, declaration);
    // `export *` forwards names without alias symbols; recover the hops it hides.
    if (source && next && next.declarations?.[0]?.getSourceFile() !== source.valueDeclaration) {
      for (const star of starPath(checker, source, next) ?? []) {
        steps.push({ label: star.getText(), name: next.name, node: star, file: star.getSourceFile().fileName });
      }
    }
    symbol = next;
  }
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (declaration) {
    const name = (declaration as ts.NamedDeclaration).name;
    steps.push({ label: `declared: ${lineSnippet(name ?? declaration)}`, name: target.name, node: name ?? declaration, file: declaration.getSourceFile().fileName });
  }
  return steps;
}

export interface ExportedName {
  file: string;
  name: string;
  /** Re-exported from another module rather than declared here. */
  reexport: boolean;
}

/** Every module that exports the symbol, and under which name. */
export function exportedNames(program: ts.Program, target: ts.Symbol): ExportedName[] {
  const checker = program.getTypeChecker();
  const results: ExportedName[] = [];
  for (const sourceFile of projectSourceFiles(program)) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      continue;
    }
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (resolveAlias(checker, exported) === target) {
        results.push({ file: sourceFile.fileName, name: exported.name, reexport: !target.declarations?.some((d) => d.getSourceFile() === sourceFile) });
      }
    }
  }
  return results;
}

/** Imports of the symbol across the project, with the module each one goes through. */
export function importsOf(program: ts.Program, target: ts.Symbol): { node: ts.Node; via: string; local: string }[] {
  const checker = program.getTypeChecker();
  const results: { node: ts.Node; via: string; local: string }[] = [];
  for (const sourceFile of projectSourceFiles(program)) {
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const clause = statement.importClause;
      const names: ts.Identifier[] = [];
      if (clause.name) {
        names.push(clause.name);
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        names.push(...clause.namedBindings.elements.map((e) => e.name));
      }
      for (const name of names) {
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol && resolveAlias(checker, symbol) === target) {
          results.push({ node: name, via: statement.moduleSpecifier.text, local: name.text });
        }
      }
    }
  }
  return results;
}

/** Re-export Chain Navigator: how a name travels through aliases and barrel files. */
export function reexportChainReport(project: VirtualProject, fileName: string, offset: number, root?: string): Report {
  const program = project.program();
  const checker = program.getTypeChecker();
  const identifier = identifierAt(project.sourceFile(fileName), offset, 'Place the cursor on an import, export or usage of a symbol.');
  const raw = checker.getSymbolAtLocation(identifier);
  if (!raw) {
    throw new AnalysisError(`No symbol found for '${identifier.text}'.`);
  }
  const target = resolveAlias(checker, raw);
  const builder = new ReportBuilder('reexports', `Re-export chain of ${identifier.text}`);
  const relative = (file: string) => (root ? path.relative(root, file).replace(/\\/g, '/') : path.basename(file));
  const chain = resolutionChain(checker, identifier);
  const exported = exportedNames(program, target);
  const imports = importsOf(program, target);
  const roots: ReportNode[] = [
    {
      label: 'Resolution from the cursor',
      description: plural(Math.max(chain.length - 1, 0), 'hop'),
      icon: 'debug-step-into',
      expanded: true,
      children: chain.map((step, i) => ({
        label: step.label,
        description: `${relative(step.file)}${step.name !== chain[chain.length - 1].name ? ` · as ${step.name}` : ''}`,
        icon: i === chain.length - 1 ? 'symbol-class' : 'arrow-down',
        tone: i === chain.length - 1 ? ('ok' as const) : undefined,
        location: builder.at(step.node),
      })),
    },
    {
      label: 'Exported as',
      description: plural(exported.length, 'module'),
      icon: 'export',
      expanded: true,
      children: exported.map((e) => ({
        label: e.name === target.name ? e.name : `${e.name} (renamed from ${target.name})`,
        description: `${relative(e.file)}${e.reexport ? ' · re-export' : ' · declaration'}`,
        icon: e.reexport ? 'references' : 'symbol-class',
        location: { file: e.file.replace(/\\/g, '/'), line: 0, character: 0, endLine: 0, endCharacter: 0 },
      })),
    },
  ];
  const byVia = new Map<string, typeof imports>();
  for (const entry of imports) {
    byVia.set(entry.via, [...(byVia.get(entry.via) ?? []), entry]);
  }
  roots.push({
    label: 'Imported through',
    description: `${plural(imports.length, 'import')} via ${plural(byVia.size, 'path')}`,
    icon: 'package',
    expanded: true,
    children: [...byVia].map(([via, list]) => ({
      label: `'${via}'`,
      description: plural(list.length, 'importer'),
      icon: 'symbol-namespace',
      children: list.map((entry) => ({ label: relative(entry.node.getSourceFile().fileName), description: entry.local !== target.name ? `as ${entry.local}` : undefined, icon: 'file-code', location: builder.at(entry.node) })),
    })),
  });
  return builder.finish(roots, `${plural(chain.length - 1, 'hop')} from the cursor, exported by ${plural(exported.length, 'module')}`);
}
