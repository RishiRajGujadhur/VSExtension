import * as path from 'path';
import * as ts from 'typescript';
import { findIdentifier, findNode } from '../analysis/impact';
import { resolveAlias } from '../analysis/referenceIndex';
import { normalizePath, pathKey } from '../analysis/paths';
import { Edit, applyEdits } from './edits';
import { Conflict, RefactorError } from './types';
import { VirtualProject } from './virtualProject';

export type FunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodSignature;

export interface FunctionTarget {
  fn: FunctionNode;
  /** The name callers use; references are found from here. */
  nameNode: ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral;
  name: string;
}

/** The function, method or function-valued variable at the cursor, resolving call sites to their declaration. */
export function functionAt(project: VirtualProject, fileName: string, offset: number): FunctionTarget {
  const sourceFile = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const token = findIdentifier(sourceFile, offset);
  if (token) {
    const symbol = checker.getSymbolAtLocation(token);
    if (symbol) {
      const resolved = resolveAlias(checker, symbol);
      const declarations = resolved.declarations ?? [];
      const targets = declarations.map(asFunctionTarget).filter((t): t is FunctionTarget => !!t);
      const implementation = targets.find((t) => 'body' in t.fn && t.fn.body) ?? targets[0];
      if (implementation) {
        if (targets.filter((t) => ts.isFunctionDeclaration(t.fn) || ts.isMethodDeclaration(t.fn)).length > 1) {
          throw new RefactorError(`'${implementation.name}' has overload signatures, which are not supported yet.`);
        }
        if (implementation.fn.getSourceFile().isDeclarationFile) {
          throw new RefactorError(`'${implementation.name}' is declared in a library and cannot be changed.`);
        }
        return implementation;
      }
    }
  }
  for (let node: ts.Node | undefined = token ?? findNode(sourceFile, offset); node; node = node.parent) {
    const target = asFunctionTarget(node) ?? (node.parent && isFunctionValued(node) ? asFunctionTarget(node.parent) : undefined);
    if (target) {
      return target;
    }
  }
  throw new RefactorError('Place the cursor on a named function, method or function-valued variable.');
}

function isFunctionValued(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function asFunctionTarget(node: ts.Node): FunctionTarget | undefined {
  const named = (fn: FunctionNode, nameNode: ts.Node | undefined): FunctionTarget | undefined =>
    nameNode && (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode) || ts.isStringLiteral(nameNode))
      ? { fn, nameNode, name: nameNode.text }
      : undefined;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return named(node, node.name);
  }
  if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer && isFunctionValued(node.initializer)) {
    return named(node.initializer as ts.ArrowFunction | ts.FunctionExpression, node.name);
  }
  return undefined;
}

export type Usage =
  | { kind: 'call'; call: ts.CallExpression; node: ts.Node }
  | { kind: 'name'; node: ts.Node }
  | { kind: 'other'; node: ts.Node; reason: string };

/** Every reference to the target, classified by how it is used. Declarations of related members are reported too. */
export function usagesOf(project: VirtualProject, target: FunctionTarget): { usages: Usage[]; related: FunctionTarget[] } {
  const sourceFile = target.nameNode.getSourceFile();
  const program = project.program();
  const groups = project.service.findReferences(sourceFile.fileName, target.nameNode.getStart(sourceFile)) ?? [];
  const usages: Usage[] = [];
  const related: FunctionTarget[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const reference of group.references) {
      const key = `${pathKey(reference.fileName)}:${reference.textSpan.start}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const file = program.getSourceFile(reference.fileName);
      if (!file || file.isDeclarationFile) {
        continue;
      }
      const node = findNode(file, reference.textSpan.start);
      // Interface members, base and overriding methods are reported by the language service
      // as references in their own groups; they are declarations, not uses.
      const declaration = asFunctionTarget(node.parent);
      if (declaration && declaration.nameNode === node) {
        if (declaration.fn !== target.fn) {
          related.push(declaration);
        }
        continue;
      }
      if (reference.isDefinition) {
        if (!isAliasDeclaration(node)) {
          usages.push({ kind: 'name', node });
        }
        continue;
      }
      usages.push(classifyUsage(node));
    }
  }
  return { usages, related };
}

function isAliasDeclaration(node: ts.Node): boolean {
  return ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent);
}

function classifyUsage(node: ts.Node): Usage {
  let callee: ts.Node = node;
  if ((ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAccessChain(node.parent)) && node.parent.name === node) {
    callee = node.parent;
  } else if (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) {
    callee = node.parent;
  }
  const parent = callee.parent;
  if (ts.isCallExpression(parent) && parent.expression === callee) {
    return { kind: 'call', call: parent, node };
  }
  if (isAliasDeclaration(node) || ts.isExportAssignment(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) {
    return { kind: 'name', node };
  }
  if (ts.isPropertyAccessExpression(parent) && ['call', 'apply', 'bind'].includes(parent.name.text)) {
    return { kind: 'other', node, reason: `called through .${parent.name.text}(), whose arguments are not updated` };
  }
  if (ts.isJsxOpeningLikeElement(parent) || ts.isJsxClosingElement(parent)) {
    return { kind: 'other', node, reason: 'used as a JSX component; props are not positional' };
  }
  if (ts.isNewExpression(parent) || ts.isTaggedTemplateExpression(parent)) {
    return { kind: 'other', node, reason: 'invoked in a form whose arguments are not updated' };
  }
  return { kind: 'other', node, reason: 'passed or stored as a value; its eventual callers are not updated' };
}

/** Applies edits grouped by file to the virtual project. */
export function applyFileEdits(project: VirtualProject, edits: Map<string, { fileName: string; edits: Edit[] }>): void {
  for (const { fileName, edits: list } of edits.values()) {
    const text = project.text(fileName);
    if (text === undefined) {
      throw new RefactorError(`Cannot read ${path.basename(fileName)}.`);
    }
    project.setText(fileName, applyEdits(text, list));
  }
}

export class EditCollector {
  readonly byFile = new Map<string, { fileName: string; edits: Edit[] }>();

  add(fileName: string, edit: Edit): void {
    const key = pathKey(fileName);
    let entry = this.byFile.get(key);
    if (!entry) {
      entry = { fileName, edits: [] };
      this.byFile.set(key, entry);
    }
    entry.edits.push(edit);
  }
}

/**
 * Errors present after the refactoring that were not there before, as a safety net.
 * Compares error messages per file, so pre-existing errors that only moved are not reported.
 */
export function introducedErrors(project: VirtualProject, alsoCheck: Iterable<string> = [], limit = 8): Conflict[] {
  const changes = project.changes();
  const files = new Map<string, string>();
  for (const file of [...changes.filter((c) => c.after !== undefined).map((c) => c.file), ...alsoCheck]) {
    if (/\.[cm]?tsx?$/i.test(file)) {
      files.set(pathKey(file), normalizePath(file));
    }
  }
  const errorsOf = (file: string) =>
    project.text(file) === undefined
      ? []
      : [...project.service.getSyntacticDiagnostics(file), ...project.service.getSemanticDiagnostics(file)].filter(
          (d) => d.category === ts.DiagnosticCategory.Error,
        );
  const after = new Map([...files.values()].map((f) => [f, errorsOf(f)]));

  // Errors before the refactoring: revert every change at once, since errors can be cross-file.
  const afterTexts = changes.map((c) => project.text(c.file));
  changes.forEach((c) => project.setText(c.file, c.before));
  const before = new Map<string, Map<string, number>>();
  for (const file of files.values()) {
    const counts = new Map<string, number>();
    for (const d of errorsOf(file)) {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      counts.set(message, (counts.get(message) ?? 0) + 1);
    }
    before.set(file, counts);
  }
  changes.forEach((c, i) => project.setText(c.file, afterTexts[i]));

  const conflicts: Conflict[] = [];
  for (const [file, diagnostics] of after) {
    const remaining = before.get(file)!;
    for (const d of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      const count = remaining.get(message) ?? 0;
      if (count > 0) {
        remaining.set(message, count - 1);
        continue;
      }
      const sourceFile = project.program().getSourceFile(file);
      const position = sourceFile && d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      conflicts.push({ message: `New error: ${message}`, location: { file, ...position } });
      if (conflicts.length >= limit) {
        return conflicts;
      }
    }
  }
  return conflicts;
}

const reservedWords = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for function ' +
    'if import in instanceof new null return super switch this throw true try typeof var void while with ' +
    'implements interface let package private protected public static yield await').split(' '),
);

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !reservedWords.has(name);
}

/** Wraps an expression's text in parentheses unless it is already a primary or call expression. */
export function parenthesize(text: string): string {
  const parsed = ts.createSourceFile('expr.ts', `(${text});`, ts.ScriptTarget.Latest, false);
  const statement = parsed.statements[0];
  if (parsed.statements.length !== 1 || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) {
    return `(${text})`;
  }
  const inner = statement.expression.expression;
  const primary =
    ts.isIdentifier(inner) ||
    ts.isPropertyAccessExpression(inner) ||
    ts.isElementAccessExpression(inner) ||
    ts.isCallExpression(inner) ||
    ts.isParenthesizedExpression(inner) ||
    ts.isLiteralExpression(inner) ||
    ts.isTemplateExpression(inner) ||
    ts.isArrayLiteralExpression(inner) ||
    ts.isObjectLiteralExpression(inner) ||
    inner.kind === ts.SyntaxKind.ThisKeyword ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword;
  return primary ? text : `(${text})`;
}
