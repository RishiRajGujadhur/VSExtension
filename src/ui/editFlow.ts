import * as vscode from 'vscode';
import { actionCatalog } from '../structure/actionCatalog';
import { nameOf } from '../structure/names';

/**
 * The shared look of every Edit feature that asks its questions in the command palette's box: one title format
 * ("Move to another file: cart.ts · step 2 of 3"), a help button on every step, Back from the second step on,
 * steps that stay open when you click elsewhere, and one way of saying what was done, with Undo.
 */
export interface Flow {
  /** The command, for its name and its explanation. */
  command: string;
  /** What the edit is about, such as a function or a file. */
  subject?: string;
  /** How many steps the flow has, for "step 2 of 3". */
  steps: number;
}

/** Returned by a step when Back was pressed. */
export const BACK = Symbol('back');
export type StepResult<T> = T | typeof BACK | undefined;

const helpButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'What this does' };

/** The feature's plain name without its trailing "…", as titles and messages use it. */
export function featureName(command: string): string {
  return nameOf(command).replace(/…$/, '');
}

/** "Change signature: total · step 2 of 3". */
export function flowTitle(flow: Flow, step: number, what?: string): string {
  const name = featureName(flow.command);
  const head = `${name}${flow.subject ? `: ${flow.subject}` : ''}`;
  const counter = flow.steps > 1 ? ` · step ${step} of ${flow.steps}` : '';
  return `${head}${what ? ` · ${what}` : ''}${counter}`;
}

/** The feature's explanation, with ways to read more: the guide, its shortcuts, and the Actions view. */
export async function showHelp(command: string): Promise<void> {
  const entry = actionCatalog.find((a) => a.command === command);
  const name = featureName(command);
  const choice = await vscode.window.showInformationMessage(`${name}: ${entry?.info ?? ''}`, { modal: false }, 'Open the guide', 'Keyboard shortcuts');
  if (choice === 'Open the guide') {
    const readme = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ts-test-impact')?.extensionUri;
    if (readme) await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(readme, 'docs', 'GUIDE.md'));
  } else if (choice === 'Keyboard shortcuts') {
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', command);
  }
}

interface PickOptions<T extends vscode.QuickPickItem> {
  placeholder?: string;
  /** What this step asks, shown after the subject in the title. */
  what?: string;
  many?: boolean;
  /** The item Enter takes; for many, the ticked ones. */
  active?: T | readonly T[];
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /** More title-bar buttons, handled by `onButton`. */
  buttons?: vscode.QuickInputButton[];
  onButton?: (button: vscode.QuickInputButton, picker: vscode.QuickPick<T>) => void;
  onItemButton?: (event: vscode.QuickPickItemButtonEvent<T>, picker: vscode.QuickPick<T>) => void;
}

/** One step that picks from a list, in the shared look. */
export async function pickStep<T extends vscode.QuickPickItem>(flow: Flow, step: number, items: readonly T[], options: PickOptions<T> = {}): Promise<StepResult<T[]>> {
  const picker = vscode.window.createQuickPick<T>();
  picker.title = flowTitle(flow, step, options.what);
  picker.placeholder = options.placeholder;
  picker.items = items;
  picker.canSelectMany = !!options.many;
  picker.matchOnDescription = options.matchOnDescription ?? true;
  picker.matchOnDetail = options.matchOnDetail ?? true;
  // Clicking into the editor to look at the code does not lose the flow.
  picker.ignoreFocusOut = true;
  picker.buttons = [...(step > 1 ? [vscode.QuickInputButtons.Back] : []), ...(options.buttons ?? []), helpButton];
  if (options.active) {
    const active = Array.isArray(options.active) ? options.active : [options.active as T];
    if (options.many) picker.selectedItems = active;
    else picker.activeItems = active.slice(0, 1);
  }
  return new Promise<StepResult<T[]>>((resolve) => {
    let done = false;
    const finish = (value: StepResult<T[]>) => {
      if (done) return;
      done = true;
      resolve(value);
      picker.dispose();
    };
    picker.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) finish(BACK);
      else if (button === helpButton) void showHelp(flow.command);
      else options.onButton?.(button, picker);
    });
    picker.onDidTriggerItemButton((event) => options.onItemButton?.(event, picker));
    picker.onDidAccept(() => {
      const chosen = options.many ? [...picker.selectedItems] : picker.activeItems.slice(0, 1);
      if (!chosen.length && !options.many) return;
      finish(chosen);
    });
    picker.onDidHide(() => finish(undefined));
    picker.show();
  });
}

interface InputOptions {
  prompt?: string;
  what?: string;
  value?: string;
  valueSelection?: [number, number];
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  /** Other values to offer: a button cycles through them. */
  suggestions?: string[];
  /** Turns what was typed into what is used, such as "total price" into totalPrice, before it is checked. */
  normalize?: (value: string) => string;
}

/** One step that asks for text, in the shared look. */
export async function inputStep(flow: Flow, step: number, options: InputOptions): Promise<StepResult<string>> {
  const box = vscode.window.createInputBox();
  box.title = flowTitle(flow, step, options.what);
  box.prompt = options.prompt;
  box.value = options.value ?? '';
  if (options.valueSelection) box.valueSelection = options.valueSelection;
  box.placeholder = options.placeholder;
  box.ignoreFocusOut = true;
  const suggestions = [...new Set((options.suggestions ?? []).filter(Boolean))];
  const next: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('lightbulb'), tooltip: `Another suggestion (${suggestions.length})` };
  box.buttons = [...(step > 1 ? [vscode.QuickInputButtons.Back] : []), ...(suggestions.length > 1 ? [next] : []), helpButton];
  const check = () => (box.validationMessage = options.validate?.((options.normalize ?? ((v) => v))(box.value)));
  check();
  let shown = 0;
  return new Promise<StepResult<string>>((resolve) => {
    let done = false;
    const finish = (value: StepResult<string>) => {
      if (done) return;
      done = true;
      resolve(value);
      box.dispose();
    };
    box.onDidChangeValue(check);
    box.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) finish(BACK);
      else if (button === helpButton) void showHelp(flow.command);
      else if (button === next) {
        shown = (shown + 1) % suggestions.length;
        box.value = suggestions[shown];
        box.valueSelection = [0, box.value.length];
        check();
      }
    });
    box.onDidAccept(() => {
      const value = (options.normalize ?? ((v) => v))(box.value);
      if (options.validate?.(value)) return;
      finish(value);
    });
    box.onDidHide(() => finish(undefined));
    box.show();
  });
}

/**
 * Says what an edit did, the same way for every feature: what changed and where, with Undo (one step back across
 * every file it touched), Show changes, and any action of the feature's own.
 */
export async function finished(command: string, message: string, options: { file?: string; changed?: number; undo?: boolean; extra?: { label: string; run: () => unknown } } = {}): Promise<void> {
  // Undo needs the file the edit started in; a deleted file has none to undo in.
  const canUndo = options.undo !== false && !!options.file;
  const buttons = [...(options.extra ? [options.extra.label] : []), ...(canUndo ? ['Undo'] : []), ...(options.changed && options.changed > 1 ? ['Show changes'] : [])];
  const choice = await vscode.window.showInformationMessage(`${featureName(command)}: ${message}`, ...buttons);
  if (choice === 'Undo') {
    if (options.file) await vscode.window.showTextDocument(vscode.Uri.file(options.file), { preserveFocus: false });
    await vscode.commands.executeCommand('undo');
  } else if (choice === 'Show changes') {
    await vscode.commands.executeCommand('tsStructure.showLastRefactoring');
  } else if (choice && options.extra && choice === options.extra.label) {
    await options.extra.run();
  }
}

/** "total price" or "total-price" as totalPrice: what a name with spaces or dashes would be as an identifier. */
export function camelName(text: string): string {
  const words = text.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length < 2) return text.trim();
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('');
}
