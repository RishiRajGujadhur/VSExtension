import * as path from 'path';
import * as ts from 'typescript';
import { findIdentifier, findNode } from '../analysis/impact';
import { normalizePath, pathKey } from '../analysis/paths';
import { resolveAlias } from '../analysis/referenceIndex';
import { SourceLocation } from '../analysis/types';
import { changeSignature } from './changeSignature';
import { EditCollector, applyFileEdits } from './common';
import { replace } from './edits';
import { RefactorError, RefactorResult } from './types';
import { VirtualProject } from './virtualProject';

export interface SafeDeleteUsage {
  location: SourceLocation;
  /** The source line, trimmed, for display. */
  lineText: string;
  /** Imports and re-exports that are removed together with the declaration. */
  removable: boolean;
}

export interface SafeDeletePlan {
  name: string;
  kind: string;
  usages: SafeDeleteUsage[];
  /** True when other modules could import it, so usages outside this project are possible. */
  exported: boolean;
  /** Deletes the declaration and removable usages; other usages are left and become errors. */
  result: RefactorResult;
}

type Deletable = ts.Node & { name?: ts.Node };

/** Plans deleting the symbol at the cursor. Parameters are removed through Change Signature, so calls are updated. */
export function planSafeDelete(project: VirtualProject, fileName: string, offset: number): SafeDeletePlan {
  const sourceFile = project.sourceFile(fileName);
  const declaration = declarationAt(project, sourceFile, offset);

  if (ts.isParameter(declaration)) {
    return planParameterDelete(project, declaration);
  }

  const nameNode = declaration.name!;
  const name = nameNode.getText();
  const declFile = declaration.getSourceFile();
  const groups = project.service.findReferences(declFile.fileName, nameNode.getStart(declFile)) ?? [];
  const edits = new EditCollector();
  const usages: SafeDeleteUsage[] = [];
  const seen = new Set<string>();

  for (const reference of groups.flatMap((g) => g.references)) {
    const key = `${pathKey(reference.fileName)}:${reference.textSpan.start}`;
    const file = project.program().getSourceFile(reference.fileName);
    if (seen.has(key) || !file || file.isDeclarationFile) {
      continue;
    }
    seen.add(key);
    const node = findNode(file, reference.textSpan.start);
    if (node === nameNode || isWithin(node, declaration)) {
      continue; // The declaration itself, and recursive or self references.
    }
    const removal = removableUsage(node);
    if (removal === 'ignore') {
      continue;
    }
    usages.push({ location: project.locationOf(node), lineText: lineOf(file, node), removable: !!removal });
    if (removal) {
      edits.add(normalizePath(file.fileName), replace(removal.start, removal.end, ''));
    }
  }

  const range = deletionRange(declaration);
  edits.add(normalizePath(declFile.fileName), replace(range.start, range.end, ''));
  applyFileEdits(project, edits.byFile);
  return {
    name,
    kind: kindOf(declaration),
    usages: sortUsages(usages),
    exported: isExported(declaration),
    result: { label: `Safe Delete ${name}`, changes: project.changes(), conflicts: [] },
  };
}

/** Plans deleting a file; imports and re-exports of it are listed as usages and removed with it. */
export function planFileDelete(project: VirtualProject, fileName: string): SafeDeletePlan {
  const target = project.sourceFile(fileName);
  const edits = new EditCollector();
  const usages: SafeDeleteUsage[] = [];
  for (const reference of project.service.getFileReferences(target.fileName)) {
    const file = project.program().getSourceFile(reference.fileName);
    if (!file || pathKey(file.fileName) === pathKey(target.fileName)) {
      continue;
    }
    const node = findNode(file, reference.textSpan.start);
    const statement = findAncestor(node, (n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n));
    usages.push({ location: project.locationOf(node), lineText: lineOf(file, node), removable: false });
    if (statement) {
      const range = deletionRange(statement);
      edits.add(normalizePath(file.fileName), replace(range.start, range.end, ''));
    }
  }
  applyFileEdits(project, edits.byFile);
  project.setText(target.fileName, undefined);
  const name = path.basename(target.fileName);
  return {
    name,
    kind: 'file',
    usages: sortUsages(usages),
    exported: target.statements.some((s) => isExported(s)),
    result: { label: `Safe Delete ${name}`, changes: project.changes(), conflicts: [] },
  };
}

function planParameterDelete(project: VirtualProject, parameter: ts.ParameterDeclaration): SafeDeletePlan {
  const fn = parameter.parent;
  const index = fn.parameters.indexOf(parameter);
  const sourceFile = parameter.getSourceFile();
  const name = parameter.name.getText(sourceFile);
  const usedInBody = ts.isIdentifier(parameter.name)
    ? (project.service.findReferences(sourceFile.fileName, parameter.name.getStart(sourceFile)) ?? []).flatMap((g) => g.references).filter((r) => !r.isDefinition)
    : [];
  const fnName = 'name' in fn && fn.name ? fn.name : ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent) ? fn.parent.name : undefined;
  if (!fnName) {
    throw new RefactorError('Parameters can only be safely deleted from named functions, methods and function-valued variables.');
  }
  // Read the uses before Change Signature edits the project.
  const usages: SafeDeleteUsage[] = usedInBody.map((r) => {
    const file = project.program().getSourceFile(r.fileName)!;
    const node = findNode(file, r.textSpan.start);
    return { location: project.locationOf(node), lineText: lineOf(file, node), removable: false };
  });
  const result = changeSignature(
    project,
    sourceFile.fileName,
    fnName.getStart(sourceFile),
    { parameters: fn.parameters.map((p, i) => ({ originalIndex: i, name: p.name.getText(sourceFile) })).filter((p) => p.originalIndex !== index) },
    `Safe Delete parameter ${name}`,
  );
  // Arguments removed from calls are expected; other problems are kept as conflicts.
  result.conflicts = result.conflicts.filter((c) => !c.message.includes('is still used in the body'));
  return { name, kind: 'parameter', usages, exported: false, result };
}

function declarationAt(project: VirtualProject, sourceFile: ts.SourceFile, offset: number): Deletable {
  const checker = project.program().getTypeChecker();
  const token = findIdentifier(sourceFile, offset);
  let symbol = token ? checker.getSymbolAtLocation(token) : undefined;
  if (token && ts.isShorthandPropertyAssignment(token.parent)) {
    symbol = checker.getShorthandAssignmentValueSymbol(token.parent);
  }
  if (symbol) {
    const resolved = resolveAlias(checker, symbol);
    const declarations = (resolved.declarations ?? []).filter(isDeletable);
    if (declarations.length > 1) {
      throw new RefactorError(`'${resolved.getName()}' has ${declarations.length} declarations (overloads or merged declarations), which are not supported yet.`);
    }
    if (declarations.length === 1) {
      if (declarations[0].getSourceFile().isDeclarationFile) {
        throw new RefactorError(`'${resolved.getName()}' is declared in a library and cannot be deleted.`);
      }
      return declarations[0];
    }
  }
  for (let node: ts.Node | undefined = token ?? findNode(sourceFile, offset); node && !ts.isSourceFile(node); node = node.parent) {
    if (isDeletable(node) && node.name && !ts.isParameter(node)) {
      return node;
    }
  }
  throw new RefactorError('Place the cursor on a declaration or a usage of the symbol to delete.');
}

function isDeletable(node: ts.Node): node is Deletable {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isParameter(node)
  );
}

/** A range to delete when the usage only passes the symbol along, 'ignore' for non-usages, or undefined for a real usage. */
function removableUsage(node: ts.Node): { start: number; end: number } | 'ignore' | undefined {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
    if (parent.propertyName && parent.propertyName !== node) {
      // `import { a as b }`: the reference at `b` is reported separately from `a`; handle the specifier once.
      return 'ignore';
    }
    const list = parent.parent;
    if (list.elements.length === 1) {
      const statement = list.parent.parent;
      if (ts.isImportDeclaration(statement) && statement.importClause?.name) {
        // `import d, { x }` keeps the default import.
        return { start: statement.importClause.name.end, end: list.end };
      }
      const declaration = ts.isExportDeclaration(list.parent) ? list.parent : statement;
      return deletionRange(declaration);
    }
    return listItemRange(parent, list.elements);
  }
  if (ts.isImportClause(parent) && parent.name === node) {
    const statement = parent.parent;
    if (parent.namedBindings) {
      return { start: node.getStart(), end: parent.namedBindings.getStart() };
    }
    return deletionRange(statement);
  }
  if (ts.isExportAssignment(parent) && parent.expression === node) {
    return deletionRange(parent);
  }
  return undefined;
}

/** Whole lines of a declaration, with its leading comments and one surrounding blank line. */
export function deletionRange(node: ts.Node): { start: number; end: number } {
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && node.parent.declarations.length > 1) {
    return listItemRange(node, node.parent.declarations);
  }
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) {
    return listItemRange(node, node.parent.properties);
  }
  if (ts.isEnumMember(node)) {
    return listItemRange(node, node.parent.members);
  }
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  const sourceFile = target.getSourceFile();
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, target.getFullStart()) ?? [];
  let start = comments.length > 0 ? comments[0].pos : target.getStart(sourceFile);
  start = text.lastIndexOf('\n', start - 1) + 1;
  let end = target.end;
  const lineEnd = text.indexOf('\n', end);
  end = lineEnd === -1 ? text.length : lineEnd + 1;
  // Swallow the following blank line when the preceding line is blank, opens a block, or is the start of the file,
  // so no double or leading blank line is left behind.
  const previousLine = text.slice(text.lastIndexOf('\n', start - 2) + 1, Math.max(0, start - 1));
  const nextLineEnd = text.indexOf('\n', end);
  const nextLine = text.slice(end, nextLineEnd === -1 ? text.length : nextLineEnd + 1);
  if (nextLine.length > 0 && nextLine.trim() === '' && (start === 0 || previousLine.trim() === '' || previousLine.trimEnd().endsWith('{'))) {
    end += nextLine.length;
  }
  return { start, end };
}

/** An element of a comma-separated list together with one adjoining comma. */
function listItemRange(node: ts.Node, list: ts.NodeArray<ts.Node>): { start: number; end: number } {
  const index = list.indexOf(node);
  const sourceFile = node.getSourceFile();
  if (index < list.length - 1) {
    return { start: node.getStart(sourceFile), end: list[index + 1].getStart(sourceFile) };
  }
  if (index > 0) {
    return { start: list[index - 1].end, end: node.end };
  }
  return { start: node.getStart(sourceFile), end: list.hasTrailingComma ? sourceFile.text.indexOf(',', node.end) + 1 : node.end };
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.pos >= container.pos && node.end <= container.end;
}

function findAncestor(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (predicate(current)) {
      return current;
    }
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  if (ts.canHaveModifiers(target) && ts.getModifiers(target)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    return true;
  }
  // Class members are reachable wherever the class is.
  return (ts.isClassElement(node) || ts.isTypeElement(node)) && isExported(node.parent);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const starts = sourceFile.getLineStarts();
  return sourceFile.text.slice(starts[line], starts[line + 1] ?? sourceFile.text.length).trim();
}

function sortUsages(usages: SafeDeleteUsage[]): SafeDeleteUsage[] {
  return usages.sort((a, b) => Number(a.removable) - Number(b.removable) || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line);
}

function kindOf(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isEnumMember(node)) return 'enum member';
  if (ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) return 'accessor';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  return 'property';
}
