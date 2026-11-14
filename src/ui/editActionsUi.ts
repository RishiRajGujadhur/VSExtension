import * as vscode from 'vscode';
import { EditAction, editActionsAt } from '../structure/editActions';
import { featureOf } from '../structure/features';
import { isFeatureEnabled } from './features';

/** The commands a chart's hover card may run; anything else sent back by a page is ignored. */
const allowed = new Set(['editor.action.rename', 'tsStructure.safeDelete', 'tsStructure.changeSignature', 'tsStructure.moveMembers', 'editor.action.codeAction', 'editor.action.refactor']);

/** Edits that fit the code at a location of an open document, without the ones whose feature is turned off. */
export function editsFor(document: vscode.TextDocument, line: number, character: number): EditAction[] {
  try {
    return editActionsAt(document.uri.fsPath, document.getText(), line, character).filter((a) => {
      const feature = featureOf(a.command);
      return !feature || isFeatureEnabled(feature.id);
    });
  } catch {
    return [];
  }
}

/** Runs an edit chosen on a hover card: the file opens with the cursor (or the selection) where the edit applies. */
export async function runEdit(file: unknown, action: unknown): Promise<void> {
  const a = action as EditAction | undefined;
  if (typeof file !== 'string' || !a || !allowed.has(a.command) || typeof a.line !== 'number' || typeof a.character !== 'number') return;
  const document = await vscode.workspace.openTextDocument(file);
  const start = new vscode.Position(a.line, a.character);
  const end = typeof a.endLine === 'number' && typeof a.endCharacter === 'number' ? new vscode.Position(a.endLine, a.endCharacter) : start;
  const editor = await vscode.window.showTextDocument(document, { selection: new vscode.Range(start, end), preserveFocus: false });
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand(a.command, ...(Array.isArray(a.args) ? a.args : []));
}
