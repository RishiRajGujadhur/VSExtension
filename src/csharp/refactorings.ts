import * as vscode from 'vscode';
import { AnalysisError } from '../analysis/types';
import { NoLanguageServer } from './languageServer';

/**
 * Change parameters, Delete safely and Move in C#, only through the C# extension's language server (Roslyn, from the
 * C# extension or C# Dev Kit), since editing C# safely needs the compiler: the bundled parser sees syntax, not types.
 * Change signature and the Move refactorings are the language server's own code actions, run as it offers them;
 * Delete safely asks it for every reference first and deletes only what nothing uses. Without the C# extension, each
 * says so, with a button to install it.
 */

export type CSharpRefactoring = 'changeSignature' | 'move';

const titles: Record<CSharpRefactoring, { match: RegExp; name: string; where: string }> = {
  changeSignature: { match: /change signature/i, name: 'Change signature', where: "a method's name or its parameters" },
  move: { match: /^move\b/i, name: 'Move', where: 'a type or a static member' },
};

const csharpExtensions = ['ms-dotnettools.csharp', 'ms-dotnettools.csdevkit', 'muhammad-sammy.csharp'];
const hasCSharpExtension = () => csharpExtensions.some((id) => !!vscode.extensions.getExtension(id));

/**
 * Runs the language server's refactoring of this kind at the cursor: the one offered, or the one picked when it offers
 * several (Move type to its own file, Move to namespace…). `pick` chooses among them by title, for tests.
 * Returns the title of what ran.
 */
export async function csharpRefactoring(editor: vscode.TextEditor, which: CSharpRefactoring, pick?: (titles: string[]) => string | undefined): Promise<string | undefined> {
  const { match, name, where } = titles[which];
  const actions = (await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', editor.document.uri, editor.selection, vscode.CodeActionKind.Refactor.value, 10)) ?? [];
  const offered = actions.filter((a) => match.test(a.title));
  if (!offered.length) {
    if (!hasCSharpExtension() && !actions.length) throw new NoLanguageServer(`${name} refactoring`);
    throw new AnalysisError(`The C# language server offers no ${name} here. Put the cursor on ${where} and try again.`);
  }
  let chosen = offered[0];
  if (offered.length > 1) {
    const title = pick ? pick(offered.map((a) => a.title)) : (await vscode.window.showQuickPick(offered.map((a) => a.title), { title: `${name} (C# language server)`, placeHolder: 'Choose what to do' }));
    const found = offered.find((a) => a.title === title);
    if (!found) return undefined;
    chosen = found;
  }
  await runAction(chosen);
  return chosen.title;
}

async function runAction(action: vscode.CodeAction | vscode.Command): Promise<void> {
  if ('command' in action && typeof action.command === 'string') {
    await vscode.commands.executeCommand(action.command, ...((action as vscode.Command).arguments ?? []));
    return;
  }
  const code = action as vscode.CodeAction;
  if (code.edit && !(await vscode.workspace.applyEdit(code.edit))) throw new AnalysisError(`${code.title} could not be applied: the files changed meanwhile. Try again.`);
  if (code.command) await vscode.commands.executeCommand(code.command.command, ...(code.command.arguments ?? []));
}

/** The symbol (and its whole declaration) at the position, from the language server's document symbols. */
async function symbolAt(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.DocumentSymbol | undefined> {
  const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', document.uri);
  let level = (found ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s);
  let best: vscode.DocumentSymbol | undefined;
  for (;;) {
    const inside = level.find((s) => s.range.contains(position));
    if (!inside) break;
    if (inside.selectionRange.contains(position)) best = inside;
    level = inside.children;
  }
  return best;
}

export interface SafeDeleteResult {
  name: string;
  /** References outside the declaration itself. */
  usages: vscode.Location[];
  deleted: boolean;
}

/**
 * Delete safely: the declaration at the cursor is deleted only when the language server finds no reference to it
 * outside itself; otherwise the usages are returned, to show. `confirm` asks before deleting (tests pass false).
 */
export async function csharpSafeDelete(editor: vscode.TextEditor, confirm = true): Promise<SafeDeleteResult> {
  const document = editor.document;
  const position = editor.selection.active;
  const symbol = await symbolAt(document, position);
  if (!symbol) {
    if (!hasCSharpExtension()) throw new NoLanguageServer('symbols');
    throw new AnalysisError("Put the cursor on the name of a declaration: a method, property, field or type.");
  }
  const on = symbol.selectionRange.contains(position) ? position : symbol.selectionRange.start;
  const references = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, on)) ?? [];
  if (!references.length && !hasCSharpExtension()) throw new NoLanguageServer('references');
  const usages = references.filter((r) => !(r.uri.toString() === document.uri.toString() && symbol.range.contains(r.range)));
  if (usages.length) return { name: symbol.name, usages, deleted: false };
  if (confirm) {
    const answer = await vscode.window.showWarningMessage(`Delete ${symbol.name}? The C# language server finds nothing that uses it.`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return { name: symbol.name, usages, deleted: false };
  }
  // The whole lines of the declaration, with the attributes and comments just above that belong to it.
  let first = symbol.range.start.line;
  while (first > 0 && /^\s*(\[.*\]|\/\/\/.*)\s*$/.test(document.lineAt(first - 1).text)) first--;
  const last = symbol.range.end.line;
  const range = new vscode.Range(first, 0, Math.min(last + 1, document.lineCount), 0);
  const edit = new vscode.WorkspaceEdit();
  edit.delete(document.uri, last + 1 < document.lineCount ? range : new vscode.Range(first, 0, last, document.lineAt(last).text.length));
  const deleted = await vscode.workspace.applyEdit(edit);
  return { name: symbol.name, usages, deleted };
}
