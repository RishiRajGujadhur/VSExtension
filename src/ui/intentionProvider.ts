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

/** How often each rewrite was picked, so the ones you use come first. */
let rewriteUses: vscode.Memento | undefined;
export function rememberRewriteUses(memento: vscode.Memento): void {
  rewriteUses = memento;
}
const usesKey = 'tsStructure.rewriteUses';

/** The nearest line within a few lines of the cursor where rewrites apply, for when none apply at the cursor. */
function nearestRewrites(editor: vscode.TextEditor, disabled: ReadonlySet<string>): { line: number; count: number } | undefined {
  const sourceFile = parse(editor.document);
  const here = editor.selection.active.line;
  for (let distance = 1; distance <= 6; distance++) {
    for (const line of [here - distance, here + distance]) {
      if (line < 0 || line >= editor.document.lineCount) continue;
      const text = editor.document.lineAt(line);
      if (text.isEmptyOrWhitespace) continue;
      const offset = editor.document.offsetAt(new vscode.Position(line, text.firstNonWhitespaceCharacterIndex));
      const found = intentionsAt(sourceFile, offset, indentUnit(editor.document), disabled);
      if (found.length) return { line, count: found.length };
    }
  }
  return undefined;
}

/** Show Rewrites Here: the intentions that apply at the cursor, as a list that applies the one picked. */
export async function showRewritesHere(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const config = vscode.workspace.getConfiguration('tsStructure');
  const disabled = new Set(config.get<string[]>('intentions.disabled', []));
  const rewrites = intentionsAtCursor(editor, disabled);
  if (!editor || rewrites.length === 0) {
    const near = editor && nearestRewrites(editor, disabled);
    const buttons = [
      ...(near ? [`Go to Line ${near.line + 1} (${near.count} rewrite${near.count === 1 ? '' : 's'})`] : []),
      ...(disabled.size ? [`Choose Rewrites (${disabled.size} off)…`] : []),
    ];
    const choice = await vscode.window.showInformationMessage('No rewrites apply at the cursor. Try a condition, a loop, a function or a string.', ...buttons);
    if (choice?.startsWith('Go to Line') && editor && near) {
      const position = new vscode.Position(near.line, editor.document.lineAt(near.line).firstNonWhitespaceCharacterIndex);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
      await showRewritesHere();
    } else if (choice) {
      await vscode.commands.executeCommand('tsStructure.chooseIntentions');
    }
    return;
  }
  // Most used first; the detail line shows the start of the new code, the description which lines it changes.
  const uses = rewriteUses?.get<Record<string, number>>(usesKey, {}) ?? {};
  const ordered = [...rewrites].sort((a, b) => (uses[b.id] ?? 0) - (uses[a.id] ?? 0));
  const preview = (r: (typeof rewrites)[number]) => r.edits.map((e) => e.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  const lines = (r: (typeof rewrites)[number]) => {
    const first = editor.document.positionAt(Math.min(...r.edits.map((e) => e.start))).line + 1;
    const last = editor.document.positionAt(Math.max(...r.edits.map((e) => e.end))).line + 1;
    return first === last ? `line ${first}` : `lines ${first}–${last}`;
  };
  const turnOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('eye-closed'), tooltip: 'Turn this rewrite off (Choose rewrites… turns it back on)' };
  type Item = vscode.QuickPickItem & { rewrite: (typeof rewrites)[number] };
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `Rewrites here (${ordered.length})`;
  picker.placeholder = disabled.size ? `Pick a rewrite to apply · ${disabled.size} turned off: Choose rewrites… brings them back` : 'Pick a rewrite to apply; type to search what the code becomes';
  picker.matchOnDetail = true;
  picker.items = ordered.map((r) => ({ label: `$(wand) ${r.title}`, description: `${lines(r)}${uses[r.id] ? ` · used ${uses[r.id]}×` : ''} · ${r.id}`, detail: preview(r) ? `→ ${preview(r)}` : undefined, buttons: [turnOff], rewrite: r }));
  picker.onDidTriggerItemButton(async (e) => {
    await config.update('intentions.disabled', [...disabled, e.item.rewrite.id], vscode.ConfigurationTarget.Global);
    disabled.add(e.item.rewrite.id);
    picker.items = picker.items.filter((i) => i !== e.item);
    void vscode.window.setStatusBarMessage(`Turned off "${e.item.rewrite.title}"`, 4000);
  });
  const picked = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (picked) {
    const edit = new vscode.WorkspaceEdit();
    for (const e of picked.rewrite.edits) {
      edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(e.start), editor.document.positionAt(e.end)), e.text);
    }
    const start = Math.min(...picked.rewrite.edits.map((e) => e.start));
    if (await vscode.workspace.applyEdit(edit)) {
      void rewriteUses?.update(usesKey, { ...uses, [picked.rewrite.id]: (uses[picked.rewrite.id] ?? 0) + 1 });
      // The cursor stays where the rewritten code starts.
      const at = editor.document.positionAt(start);
      editor.selection = new vscode.Selection(at, at);
      void vscode.window.setStatusBarMessage(`$(wand) ${picked.rewrite.title}. ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Z undoes it.`, 4000);
    }
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
  picker.title = `Choose rewrites (${intentionList.length - disabled.size} of ${intentionList.length} on)`;
  picker.placeholder = 'Tick the rewrites to offer in the lightbulb menu; the ones that apply at the cursor come first';
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  const applies = intentionList.filter((i) => here.has(i.id));
  picker.items = [
    ...(applies.length ? [{ label: 'Here at the cursor', kind: vscode.QuickPickItemKind.Separator }, ...applies.map(item)] : []),
    { label: 'Conditions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => conditionIntentions.has(i.id) && !here.has(i.id)).map(item),
    { label: 'Loops, functions and expressions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => !conditionIntentions.has(i.id) && !here.has(i.id)).map(item),
  ];
  picker.selectedItems = picker.items.filter((i) => i.picked);
  const allOn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Turn all on' };
  const allOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Turn all off' };
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
  const turnedOff = off.filter((id) => !disabled.has(id));
  const turnedOn = [...disabled].filter((id) => on.has(id));
  if (!turnedOff.length && !turnedOn.length) {
    void vscode.window.setStatusBarMessage('No change to the rewrites', 3000);
    return;
  }
  const inspected = config.inspect<string[]>('intentions.disabled');
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('intentions.disabled', off.length ? off : undefined, target);
  const named = (ids: string[]) => (ids.length <= 2 ? ids.map((id) => intentionList.find((i) => i.id === id)?.title ?? id).join(', ') : `${ids.length} rewrites`);
  void vscode.window.setStatusBarMessage(`${on.size} of ${intentionList.length} rewrites on${turnedOn.length ? `; turned on ${named(turnedOn)}` : ''}${turnedOff.length ? `; turned off ${named(turnedOff)}` : ''}`, 5000);
}

/** One level of indentation as the editor showing the document is configured. */
function indentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 2;
  return editor?.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
}
