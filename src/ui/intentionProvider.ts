import * as vscode from 'vscode';
import { intentionList, intentionsAt } from '../intentions/intentions';
import { parse } from './codeActions';
import { isFeatureEnabled } from './features';
import { languageSelector } from './refactorCommands';

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

const conditionIntentions = new Set(['invertIf', 'ifToTernary', 'ternaryToIf', 'flipTernary', 'mergeNestedIfs', 'splitAndCondition', 'ifChainToSwitch', 'deMorgan', 'flipComparison', 'ternaryToNullish', 'optionalChain', 'removeElseAfterReturn', 'switchToIfChain', 'addParentheses', 'booleanReturn', 'ternaryBoolean', 'equalityChainToIncludes', 'simplifyNegation', 'removeDoubleNegation', 'ternaryToOr', 'guardClause', 'nullCheckJoin', 'nullCheckExpand']);

/** The rewrites that apply at the editor's cursor, whether or not they are turned off. */
export function intentionsAtCursor(editor: vscode.TextEditor | undefined, disabled: ReadonlySet<string> = new Set()): ReturnType<typeof intentionsAt> {
  if (!editor || vscode.languages.match(languageSelector, editor.document) === 0) {
    return [];
  }
  return intentionsAt(parse(editor.document), editor.document.offsetAt(editor.selection.active), indentUnit(editor.document), disabled);
}

/** Show Rewrites Here: the intentions that apply at the cursor, as a list that applies the one picked. */
export async function showRewritesHere(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const disabled = new Set(vscode.workspace.getConfiguration('tsStructure').get<string[]>('intentions.disabled', []));
  const rewrites = intentionsAtCursor(editor, disabled);
  if (!editor || rewrites.length === 0) {
    void vscode.window.showInformationMessage('No rewrites apply at the cursor. Try a condition, a loop, a function or a string.');
    return;
  }
  // The detail line shows the start of the new code, so the result is visible before applying it.
  const preview = (r: (typeof rewrites)[number]) => r.edits.map((e) => e.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  const picked = await vscode.window.showQuickPick(rewrites.map((r) => ({ label: `$(wand) ${r.title}`, detail: preview(r) ? `→ ${preview(r)}` : undefined, rewrite: r })), { title: 'Rewrites Here', placeHolder: 'Pick a rewrite to apply' });
  if (picked) {
    const edit = new vscode.WorkspaceEdit();
    for (const e of picked.rewrite.edits) {
      edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(e.start), editor.document.positionAt(e.end)), e.text);
    }
    await vscode.workspace.applyEdit(edit);
  }
}

/** A checklist of the intention actions, in the README's two groups; unticked ones are left out of the lightbulb menu. */
export async function chooseIntentions(): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure');
  const disabled = new Set(config.get<string[]>('intentions.disabled', []));
  // Marking what applies here shows what an intention does on code you know.
  const here = new Set(intentionsAtCursor(vscode.window.activeTextEditor).map((a) => a.id));
  type Item = vscode.QuickPickItem & { id?: string };
  const item = (intention: (typeof intentionList)[number]): Item => ({
    label: intention.title,
    description: here.has(intention.id) ? `${intention.id} · applies at the cursor` : intention.id,
    picked: !disabled.has(intention.id),
    id: intention.id,
  });
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `Intention Actions (${intentionList.length})`;
  picker.placeholder = 'Tick the rewrites to offer in the lightbulb menu';
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  picker.items = [
    { label: 'Conditions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => conditionIntentions.has(i.id)).map(item),
    { label: 'Loops, functions and expressions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => !conditionIntentions.has(i.id)).map(item),
  ];
  picker.selectedItems = picker.items.filter((i) => i.picked);
  const allOn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Turn All On' };
  const allOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Turn All Off' };
  picker.buttons = [allOn, allOff];
  picker.onDidTriggerButton((b) => (picker.selectedItems = b === allOn ? picker.items.filter((i) => i.id) : []));
  const picked = await new Promise<readonly Item[] | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (!picked) {
    return;
  }
  const on = new Set(picked.map((p) => p.id).filter((id): id is string => !!id));
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
