import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { openChangeSignature } from './changeSignaturePanel';
import { RefactorCommandProvider } from './codeActions';
import { IntentionProvider } from './intentionProvider';
import { runIntroduceParameter } from './introduceParameterUi';
import { runMoveMembers } from './moveMembersUi';
import { safeDeleteFile, safeDeleteSymbol } from './safeDeleteUi';

export const languageSelector: vscode.DocumentSelector = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].map((language) => ({
  language,
  scheme: 'file',
}));

/** The active editor when it holds a TypeScript or JavaScript file on disk, otherwise an explanation. */
export function sourceEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || vscode.languages.match(languageSelector, editor.document) === 0) {
    void vscode.window.showErrorMessage('Open a TypeScript or JavaScript file first.');
    return undefined;
  }
  return editor;
}

export function previewEnabled(): boolean {
  return vscode.workspace.getConfiguration('tsStructure').get('previewRefactorings', true);
}

export function registerRefactorings(context: vscode.ExtensionContext, projects: ProjectService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tsStructure.changeSignature', () => {
      const editor = sourceEditor();
      if (editor) {
        return openChangeSignature(context, projects, editor);
      }
    }),
    vscode.commands.registerCommand('tsStructure.safeDelete', () => {
      const editor = sourceEditor();
      if (editor) {
        return safeDeleteSymbol(projects, editor);
      }
    }),
    vscode.commands.registerCommand('tsStructure.safeDeleteFile', (uri?: vscode.Uri) => safeDeleteFile(projects, uri)),
    vscode.commands.registerCommand('tsStructure.moveMembers', () => {
      const editor = sourceEditor();
      if (editor) {
        return runMoveMembers(projects, editor);
      }
    }),
    vscode.commands.registerCommand('tsStructure.introduceParameter', () => {
      const editor = sourceEditor();
      if (editor) {
        return runIntroduceParameter(projects, editor);
      }
    }),
    vscode.languages.registerCodeActionsProvider(languageSelector, new RefactorCommandProvider(), {
      providedCodeActionKinds: RefactorCommandProvider.kinds,
    }),
    vscode.languages.registerCodeActionsProvider(languageSelector, new IntentionProvider(), {
      providedCodeActionKinds: IntentionProvider.kinds,
    }),
  );
}
