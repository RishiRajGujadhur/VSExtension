import * as path from 'path';
import * as ts from 'typescript';
import { projectSourceFiles, resolveAlias } from '../analysis/referenceIndex';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, codeContext, lineSnippet, plural } from '../structure/report';
import { identifierAt } from '../structure/util';
import { TextEdit } from '../intentions/intentions';
import { hashText, normalizePath } from '../analysis/paths';

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
  /** Where the module exports it: the declaration, the export specifier, or the `export *` that forwards it. */
  node: ts.Node;
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
        const local = exported.declarations?.find((d) => d.getSourceFile() === sourceFile);
        const node = local ? ((local as ts.NamedDeclaration).name ?? local) : (starPath(checker, moduleSymbol, exported)?.[0] ?? sourceFile);
        results.push({ file: sourceFile.fileName, name: exported.name, reexport: !target.declarations?.some((d) => d.getSourceFile() === sourceFile), node });
      }
    }
  }
  return results;
}

/** Imports of the symbol across the project, with the module each one goes through. */
export function importsOf(program: ts.Program, target: ts.Symbol): { node: ts.Node; via: string; local: string; from?: ts.SourceFile }[] {
  const checker = program.getTypeChecker();
  const results: { node: ts.Node; via: string; local: string; from?: ts.SourceFile }[] = [];
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
          const from = checker.getSymbolAtLocation(statement.moduleSpecifier)?.valueDeclaration;
          results.push({ node: name, via: statement.moduleSpecifier.text, local: name.text, from: from && ts.isSourceFile(from) ? from : undefined });
        }
      }
    }
  }
  return results;
}

/**
 * Edits that import the symbol straight from the module declaring it instead of through a barrel: the specifier is
 * moved to its own import, or the whole import is repointed when it is the only name.
 */
export function directImportEdits(name: ts.Identifier, target: ts.Symbol): TextEdit[] | undefined {
  const specifier = name.parent;
  const declaration = target.declarations?.[0]?.getSourceFile();
  const statement = ts.findAncestor(specifier, ts.isImportDeclaration);
  if (!ts.isImportSpecifier(specifier) || !declaration || !statement || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return undefined;
  }
  const sourceFile = specifier.getSourceFile();
  const elements = (specifier.parent as ts.NamedImports).elements;
  let module = path.relative(path.dirname(sourceFile.fileName), declaration.fileName).replace(/\\/g, '/').replace(/\.(d\.)?[cm]?[jt]sx?$/, '');
  module = module.startsWith('.') ? module : `./${module}`;
  if (/\.[cm]?js$/.test(statement.moduleSpecifier.text)) {
    // ESM-style specifiers keep their .js extension.
    module += '.js';
  }
  const quote = statement.moduleSpecifier.getText(sourceFile)[0];
  const typeOnly = statement.importClause?.isTypeOnly || specifier.isTypeOnly;
  const imported = name.text === target.name ? name.text : `${target.name} as ${name.text}`;
  const line = `import ${typeOnly ? 'type ' : ''}{ ${imported} } from ${quote}${module}${quote};`;
  if (elements.length === 1 && !statement.importClause?.name) {
    return [{ start: statement.getStart(sourceFile), end: statement.end, text: line }];
  }
  // Remove the specifier with the comma after it (or before it, for the last one) and add the new import below.
  const index = elements.indexOf(specifier);
  const remove = index < elements.length - 1 ? { start: specifier.getStart(sourceFile), end: elements[index + 1].getStart(sourceFile) } : { start: elements[index - 1].end, end: specifier.end };
  return [
    { ...remove, text: '' },
    { start: statement.end, end: statement.end, text: `\n${line}` },
  ];
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
  // How many files import the symbol from each exporting module: a barrel nobody imports through can go.
  const importerCount = (file: string) => {
    const count = new Set(imports.filter((i) => i.from?.fileName === file).map((i) => i.node.getSourceFile())).size;
    return count ? plural(count, 'importer') : 'no importers';
  };
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
        tooltip: codeContext(step.node),
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
        description: `${relative(e.file)}${e.reexport ? ' · re-export' : ' · declaration'} · ${importerCount(e.file)}`,
        icon: e.reexport ? 'references' : 'symbol-class',
        location: builder.at(e.node),
      })),
    },
  ];
  const byVia = new Map<string, typeof imports>();
  for (const entry of imports) {
    byVia.set(entry.via, [...(byVia.get(entry.via) ?? []), entry]);
  }
  if (byVia.size > 1) {
    builder.warnings.push(
      `${target.name} is imported through ${byVia.size} different paths (${[...byVia.keys()].map((v) => `'${v}'`).join(', ')}). Importing it one way avoids duplicate module instances with bundler aliases and makes circular imports less likely.`,
    );
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
      children: list.map((entry) => {
        const throughBarrel = entry.from && !target.declarations?.some((d) => d.getSourceFile() === entry.from);
        const edits = throughBarrel && ts.isIdentifier(entry.node) ? directImportEdits(entry.node, target) : undefined;
        const importer = entry.node.getSourceFile();
        return {
        label: relative(entry.node.getSourceFile().fileName),
        description: [`line ${entry.node.getSourceFile().getLineAndCharacterOfPosition(entry.node.getStart()).line + 1}`, entry.local !== target.name ? `as ${entry.local}` : undefined].filter(Boolean).join(' · '),
        tooltip: codeContext(entry.node),
        icon: 'file-code',
        location: builder.at(entry.node),
        action: edits ? { kind: 'applyFix', file: normalizePath(importer.fileName), hash: hashText(importer.text), edits, title: `Import ${target.name} directly from ${path.basename(target.declarations![0].getSourceFile().fileName)}` } : undefined,
        };
      }),
    })),
  });
  return builder.finish(roots, `${plural(chain.length - 1, 'hop')} from the cursor, exported by ${plural(exported.length, 'module')}`);
}
