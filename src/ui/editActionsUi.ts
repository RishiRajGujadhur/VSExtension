import * as vscode from 'vscode';
import { EditAction, editActionsAt } from '../structure/editActions';
import { featureOf } from '../structure/features';
import { isFeatureEnabled } from './features';

/** The commands a chart's hover card may run; anything else sent back by a page is ignored. */
const allowed = new Set(['editor.action.rename', 'tsStructure.safeDelete', 'tsStructure.changeSignature', 'tsStructure.moveMembers', 'editor.action.codeAction', 'editor.action.refactor', codeActionCommand()]);

/** Stands for "apply the code action with this id", for edits that come from the editor's own code actions. */
function codeActionCommand(): string {
  return 'codeXRay.applyCodeAction';
}

/** Code actions offered on cards, by id, until the next ones replace them. */
const offered = new Map<string, { file: string; version: number; action: vscode.CodeAction }>();
let nextId = 0;

/** Our own kinds that only repeat the card's buttons (Delete safely, Move…) or run an analysis. */
const ownCommandKind = vscode.CodeActionKind.Refactor.append('tsStructure');
const ownRewriteKind = vscode.CodeActionKind.RefactorRewrite.append('tsStructure');

const iconFor = (action: vscode.CodeAction): string => {
  const kind = action.kind?.value ?? '';
  if (kind.startsWith('quickfix')) return 'lightbulb-autofix';
  if (kind.startsWith('refactor.extract')) return 'symbol-method';
  if (kind.startsWith('refactor.inline')) return 'fold-up';
  if (kind.startsWith('refactor.move')) return 'file-symlink-file';
  return 'wand';
};

/**
 * Edits that fit the code at a location of an open document: ours (Rename, Delete safely…) and the editor's own
 * code actions there (TypeScript's refactorings and quick fixes, and Code X-Ray's rewrites), each as a button.
 * "Extract…" and "More edits…" only stay when the editor offers nothing more specific.
 */
export async function editsFor(document: vscode.TextDocument, line: number, character: number): Promise<EditAction[]> {
  let ours: EditAction[];
  try {
    ours = editActionsAt(document.uri.fsPath, document.getText(), line, character).filter((a) => {
      const feature = featureOf(a.command);
      return !feature || isFeatureEnabled(feature.id);
    });
  } catch {
    return [];
  }
  // Ask where Extract would apply (the expression), or else on the declaration's name.
  const spot = ours.find((a) => a.endLine !== undefined) ?? ours[0];
  if (!spot) return ours;
  const range = new vscode.Range(spot.line, spot.character, spot.endLine ?? spot.line, spot.endCharacter ?? spot.character);
  let actions: vscode.CodeAction[] = [];
  try {
    const found = await withTimeout(Promise.resolve(vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', document.uri, range, undefined, 12)), 1500);
    actions = (found ?? []).filter((a): a is vscode.CodeAction => 'title' in a && !('command' in a && typeof a.command === 'string'));
  } catch {
    actions = [];
  }
  const ownTitles = new Set(ours.map((a) => a.label.toLowerCase()));
  const useful = actions.filter((a) => {
    const kind = a.kind;
    if (a.disabled || !kind) return false;
    if (kind.value.startsWith('source')) return false;
    if (ownCommandKind.contains(kind) && !ownRewriteKind.contains(kind)) return false;
    return !ownTitles.has(a.title.toLowerCase());
  });
  if (!useful.length) return ours;
  // The editor's actions replace the general Extract… and More edits… buttons.
  const kept = ours.filter((a) => a.command !== 'editor.action.refactor' && a.command !== 'editor.action.codeAction');
  if (offered.size > 200) offered.clear();
  const fromEditor = useful.slice(0, 8).map((action): EditAction => {
    const id = String(++nextId);
    offered.set(id, { file: document.uri.fsPath, version: document.version, action });
    return { command: codeActionCommand(), args: [id], label: shortTitle(action.title), icon: iconFor(action), line: range.start.line, character: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
  });
  return [...kept, ...fromEditor];
}

/** "Extract to function in module scope" reads well enough; very long titles are cut. */
function shortTitle(title: string): string {
  return title.length > 42 ? `${title.slice(0, 41)}…` : title;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
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
  if (a.command === codeActionCommand()) {
    const chosen = offered.get(String(Array.isArray(a.args) ? a.args[0] : ''));
    if (!chosen || chosen.file !== document.uri.fsPath || chosen.version !== document.version) {
      // Offered before the file changed: the editor's own list at the same spot instead.
      await vscode.commands.executeCommand('editor.action.refactor');
      return;
    }
    if (chosen.action.edit) await vscode.workspace.applyEdit(chosen.action.edit);
    if (chosen.action.command) await vscode.commands.executeCommand(chosen.action.command.command, ...(chosen.action.command.arguments ?? []));
    return;
  }
  await vscode.commands.executeCommand(a.command, ...(Array.isArray(a.args) ? a.args : []));
}
