import * as vscode from 'vscode';
import { intentionList, intentionsAt } from '../intentions/intentions';
import { parse } from './codeActions';
import { isFeatureEnabled } from './features';

export const intentionKind = vscode.CodeActionKind.RefactorRewrite.append('tsStructure');

/** Offers the syntactic intention actions in the lightbulb menu. */
export class IntentionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [intentionKind];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    if ((context.only && !intentionKind.intersects(context.only)) || !isFeatureEnabled('intentions')) {
      return [];
    }
    const disabled = new Set(vscode.workspace.getConfiguration('tsStructure').get<string[]>('intentions.disabled', []));
    const actions = intentionsAt(parse(document), document.offsetAt(range.start), indentUnit(document), disabled);
    return actions.map((action) => {
      const codeAction = new vscode.CodeAction(action.title, intentionKind);
      codeAction.edit = new vscode.WorkspaceEdit();
      for (const edit of action.edits) {
        codeAction.edit.replace(document.uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
      }
      return codeAction;
    });
  }
}

/** A checklist of the intention actions; unticked ones are left out of the lightbulb menu. */
export async function chooseIntentions(): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure');
  const disabled = new Set(config.get<string[]>('intentions.disabled', []));
  const picked = await vscode.window.showQuickPick(
    intentionList.map((intention) => ({ label: intention.title, description: intention.id, picked: !disabled.has(intention.id), id: intention.id })),
    { title: 'Intention Actions', placeHolder: 'Tick the rewrites to offer in the lightbulb menu', canPickMany: true, matchOnDescription: true },
  );
  if (!picked) {
    return;
  }
  const on = new Set(picked.map((p) => p.id));
  const off = intentionList.map((i) => i.id).filter((id) => !on.has(id));
  const inspected = config.inspect<string[]>('intentions.disabled');
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('intentions.disabled', off.length ? off : undefined, target);
  void vscode.window.setStatusBarMessage(`${on.size} of ${intentionList.length} intention actions on`, 3000);
}

/** One level of indentation as the editor showing the document is configured. */
function indentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 2;
  return editor?.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
}
