import * as ts from 'typescript';
import * as vscode from 'vscode';
import { findNode } from '../analysis/impact';

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
    const node = findNode(sourceFile, document.offsetAt(range.start));
    const actions: vscode.CodeAction[] = [];
    if (isFunctionName(node)) {
      actions.push(command('Change Signature…', 'tsStructure.changeSignature'));
    }
    if (isDeclarationName(node)) {
      actions.push(command('Safe Delete…', 'tsStructure.safeDelete'));
    }
    return actions;
  }
}

function command(title: string, id: string): vscode.CodeAction {
  const action = new vscode.CodeAction(title, refactorKind);
  action.command = { command: id, title };
  return action;
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
