import * as vscode from 'vscode';
import { awaitPick, ticked as tickedItems } from './quickPick';
import { intentionList, intentionsAt } from '../intentions/intentions';
import { parse } from './codeActions';
import { isFeatureEnabled } from './features';
import { languageSelector } from './refactorCommands';
import { flowTitle, showHelp } from './editFlow';

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
  const lastUsed = rewriteUses?.get<string>(lastKey);
  const preview = (r: Rewrite) => r.edits.map((e) => e.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  const lines = (r: Rewrite) => {
    const first = editor.document.positionAt(Math.min(...r.edits.map((e) => e.start))).line + 1;
    const last = editor.document.positionAt(Math.max(...r.edits.map((e) => e.end))).line + 1;
    return first === last ? `line ${first}` : `lines ${first}–${last}`;
  };
  const turnOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('eye-closed'), tooltip: 'Turn this rewrite off (Choose rewrites… turns it back on)' };
  const applyStay: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pass'), tooltip: 'Apply it and keep the list open for another rewrite' };
  const chooseButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'Choose rewrites… (which ones the lightbulb offers)' };
  const helpButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'What this does' };
  type Item = vscode.QuickPickItem & { rewrite?: Rewrite };
  const itemsFor = (list: Rewrite[]): Item[] => {
    const ordered = [...list].sort((a, b) => Number(b.id === lastUsed) - Number(a.id === lastUsed) || (uses[b.id] ?? 0) - (uses[a.id] ?? 0));
    const item = (r: Rewrite): Item => ({ label: `$(wand) ${r.title}`, description: `${lines(r)}${r.id === lastUsed ? ' · last used' : uses[r.id] ? ` · used ${uses[r.id]}×` : ''}`, detail: preview(r) ? `→ ${preview(r)}` : undefined, buttons: [applyStay, turnOff], rewrite: r });
    // Conditions and the rest under their own headings, when both are there.
    const conditions = ordered.filter((r) => conditionIntentions.has(r.id));
    const others = ordered.filter((r) => !conditionIntentions.has(r.id));
    if (!conditions.length || !others.length) return ordered.map(item);
    return [{ label: 'Conditions', kind: vscode.QuickPickItemKind.Separator }, ...conditions.map(item), { label: 'Loops, functions and expressions', kind: vscode.QuickPickItemKind.Separator }, ...others.map(item)];
  };
  // The new code, shown faintly after the line it rewrites while the rewrite is highlighted in the list.
  const ghost = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' } });
  const showGhost = (r: Rewrite | undefined) => {
    if (!r) return editor.setDecorations(ghost, []);
    const at = editor.document.positionAt(Math.min(...r.edits.map((e) => e.start)));
    const end = editor.document.lineAt(at.line).range.end;
    editor.setDecorations(ghost, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: `→ ${preview(r).slice(0, 70)}` } } }]);
  };
  const apply = async (r: Rewrite): Promise<boolean> => {
    const edit = new vscode.WorkspaceEdit();
    for (const e of r.edits) edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(e.start), editor.document.positionAt(e.end)), e.text);
    const start = Math.min(...r.edits.map((e) => e.start));
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    void rewriteUses?.update(usesKey, { ...uses, [r.id]: (uses[r.id] ?? 0) + 1 });
    void rewriteUses?.update(lastKey, r.id);
    // The cursor stays where the rewritten code starts.
    const at = editor.document.positionAt(start);
    editor.selection = new vscode.Selection(at, at);
    void vscode.window.setStatusBarMessage(`$(wand) Show rewrites: ${r.title}. ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Z undoes it.`, 4000);
    return true;
  };
  const picker = vscode.window.createQuickPick<Item>();
  const refresh = () => {
    const now = intentionsAtCursor(editor, disabled);
    picker.title = flowTitle({ command: 'tsStructure.showRewrites', subject: `line ${editor.selection.active.line + 1}`, steps: 1 }, 1, `${now.length} rewrite${now.length === 1 ? '' : 's'}`);
    picker.items = itemsFor(now);
    return now.length;
  };
  refresh();
  picker.placeholder = disabled.size ? `Pick a rewrite to apply; the new code shows beside the line · ${disabled.size} turned off (the gear brings them back)` : 'Pick a rewrite to apply; the new code shows beside the line as you move through the list';
  picker.matchOnDetail = true;
  picker.matchOnDescription = true;
  picker.ignoreFocusOut = true;
  picker.buttons = [chooseButton, helpButton];
  picker.onDidChangeActive((active) => showGhost(active[0]?.rewrite));
  picker.onDidTriggerButton((b) => {
    if (b === helpButton) void showHelp('tsStructure.showRewrites');
    else if (b === chooseButton) { picker.hide(); void vscode.commands.executeCommand('tsStructure.chooseIntentions'); }
  });
  picker.onDidTriggerItemButton(async (e) => {
    const r = e.item.rewrite;
    if (!r) return;
    if (e.button === applyStay) {
      // Applied, then the list shows what applies to the code now.
      if (await apply(r) && refresh() === 0) picker.hide();
      return;
    }
    await config.update('intentions.disabled', [...disabled, r.id], vscode.ConfigurationTarget.Global);
    disabled.add(r.id);
    picker.items = picker.items.filter((i) => i !== e.item);
    void vscode.window.setStatusBarMessage(`Turned off "${r.title}"`, 4000);
  });
  const picked = await awaitPick(picker, (p) => p.activeItems[0]);
  ghost.dispose();
  if (picked?.rewrite) await apply(picked.rewrite);
}

type Rewrite = ReturnType<typeof intentionsAt>[number];
const lastKey = 'tsStructure.rewriteLast';

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
  const titleNow = () => flowTitle({ command: 'tsStructure.chooseIntentions', steps: 1 }, 1, `${picker.selectedItems.filter((i) => i.id).length} of ${intentionList.length} on`);
  picker.placeholder = 'Tick the rewrites the lightbulb offers; the ones that apply at the cursor come first. Type to search by name or id.';
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  picker.ignoreFocusOut = true;
  const applies = intentionList.filter((i) => here.has(i.id));
  picker.items = [
    ...(applies.length ? [{ label: 'Here at the cursor', kind: vscode.QuickPickItemKind.Separator }, ...applies.map(item)] : []),
    { label: 'Conditions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => conditionIntentions.has(i.id) && !here.has(i.id)).map(item),
    { label: 'Loops, functions and expressions', kind: vscode.QuickPickItemKind.Separator },
    ...intentionList.filter((i) => !conditionIntentions.has(i.id) && !here.has(i.id)).map(item),
  ];
  picker.selectedItems = picker.items.filter((i) => i.picked);
  picker.title = titleNow();
  const allOn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Turn all on' };
  const allOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Turn all off' };
  const conditionsOnly: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('symbol-boolean'), tooltip: 'Only the condition rewrites' };
  const hereOnly: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('target'), tooltip: 'Only the ones that apply at the cursor' };
  const reset: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Back to how it was when this opened' };
  const helpButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'What this does' };
  picker.buttons = [allOn, allOff, conditionsOnly, ...(here.size ? [hereOnly] : []), reset, helpButton];
  const ticked = picker.selectedItems;
  picker.onDidTriggerButton((b) => {
    if (b === helpButton) return void showHelp('tsStructure.chooseIntentions');
    const all = picker.items.filter((i) => i.id);
    picker.selectedItems = b === allOn ? all : b === allOff ? [] : b === conditionsOnly ? all.filter((i) => conditionIntentions.has(i.id!)) : b === hereOnly ? all.filter((i) => here.has(i.id!)) : ticked;
    picker.title = titleNow();
  });
  // The count in the title follows the ticks.
  picker.onDidChangeSelection(() => (picker.title = titleNow()));
  const picked = await awaitPick(picker, tickedItems);
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
  void vscode.window.setStatusBarMessage(`Choose rewrites: ${on.size} of ${intentionList.length} on${turnedOn.length ? `; turned on ${named(turnedOn)}` : ''}${turnedOff.length ? `; turned off ${named(turnedOff)}` : ''}`, 5000);
}

/** One level of indentation as the editor showing the document is configured. */
function indentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 2;
  return editor?.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
}
