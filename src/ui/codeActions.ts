import ts = require('typescript');
import * as vscode from 'vscode';
import { findNode } from '../analysis/impact';
import { isFeatureEnabled } from './features';

const parsed = new WeakMap<vscode.TextDocument, { version: number; sourceFile: ts.SourceFile }>();

/** A syntax tree for the document, reused while its version is unchanged. */
export function parse(document: vscode.TextDocument): ts.SourceFile {
  const cached = parsed.get(document);
  if (cached && cached.version === document.version) {
    return cached.sourceFile;
  }
  const kind = /\.[cm]?tsx$|\.[cm]?jsx$/i.test(document.fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/i.test(document.fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest, true, kind);
  parsed.set(document, { version: document.version, sourceFile });
  return sourceFile;
}

export const refactorKind = vscode.CodeActionKind.Refactor.append('tsStructure');

/** Lightbulb entries that open the project-wide refactorings. */
export class RefactorCommandProvider implements vscode.CodeActionProvider {
  static readonly kinds = [refactorKind];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const sourceFile = parse(document);
    const actions: vscode.CodeAction[] = [];
    // Selected statements: where else the same code is, before extracting it.
    if (isFeatureEnabled('duplicates') && !range.isEmpty && selectsStatements(sourceFile, document.offsetAt(range.start), document.offsetAt(range.end))) {
      const find = new vscode.CodeAction('Find copies of the selected code', refactorKind);
      find.command = { command: 'tsStructure.findDuplicates', title: find.title, arguments: ['selection'] };
      actions.push(find);
    }
    if (!isFeatureEnabled('refactorings')) {
      return actions;
    }
    const node = findNode(sourceFile, document.offsetAt(range.start));
    if (!range.isEmpty && isInsideFunctionBody(node)) {
      actions.push(command('Introduce Parameter…', 'tsStructure.introduceParameter'));
    }
    if (isFunctionName(node)) {
      actions.push(command('Change Signature…', 'tsStructure.changeSignature'));
    }
    if (isDeclarationName(node)) {
      actions.push(command('Safe Delete…', 'tsStructure.safeDelete'));
    }
    if (isTopLevelDeclarationName(node)) {
      actions.push(command('Move to Existing Module…', 'tsStructure.moveMembers'));
    }
    return actions;
  }
}

/** Whether the range covers one or more whole statements, give or take surrounding whitespace. */
function selectsStatements(sourceFile: ts.SourceFile, start: number, end: number): boolean {
  const text = sourceFile.text;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node.end < start || node.getStart(sourceFile) > end) {
      return;
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const statements = node.statements.filter((s) => s.getStart(sourceFile) >= start && s.end <= end);
      if (statements.length && statements[0].getStart(sourceFile) === start && statements[statements.length - 1].end === end) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function command(title: string, id: string): vscode.CodeAction {
  const action = new vscode.CodeAction(title, refactorKind);
  action.command = { command: id, title };
  return action;
}

function isInsideFunctionBody(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if ((ts.isFunctionLike(current) && 'body' in current && current.body) || ts.isSourceFile(current)) {
      return !ts.isSourceFile(current);
    }
  }
  return false;
}

function isTopLevelDeclarationName(node: ts.Node): boolean {
  if (!isDeclarationName(node)) {
    return false;
  }
  const declaration = node.parent;
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  return !!statement && ts.isSourceFile(statement.parent);
}

/** The name in a declaration that Safe Delete supports. */
function isDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    !!parent &&
    (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent) ||
      ts.isParameter(parent)) &&
    (parent as ts.NamedDeclaration).name === node
  );
}

/** A function or method name, at its declaration or at a call. */
function isFunctionName(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node)) {
    return false;
  }
  const parent = node.parent;
  if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node) {
    return true;
  }
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) {
    return !!parent.initializer && (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer));
  }
  const callee = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
}
