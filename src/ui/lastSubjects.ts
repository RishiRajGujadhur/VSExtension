import * as vscode from 'vscode';
import * as path from 'path';
import { activeFeature } from './activeFeature';

/**
 * Where each feature last ran: the file and cursor position, and a short name for it (the word at the cursor, or
 * the file). Kept per command once the run showed a result, so the Actions view can offer "Run again on total
 * (cart.ts:12)" for every feature, without finding the place again.
 */
export interface LastSubject {
  file: string;
  offset: number;
  line: number;
  label: string;
}

const key = 'tsStructure.lastSubjects';
let memento: vscode.Memento | undefined;
const pending = new Map<string, LastSubject>();
const listeners = new Set<() => void>();

/** Starts keeping last subjects in global state; the result of a run confirms its subject. */
export function registerLastSubjects(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  context.subscriptions.push(
    activeFeature.onDidChange(() => {
      const command = activeFeature.active;
      const subject = command && pending.get(command);
      if (!command || !subject) return;
      pending.delete(command);
      void memento?.update(key, { ...all(), [command]: subject }).then(() => listeners.forEach((l) => l()));
    }),
  );
}

/** A command started: where the cursor is, in case it shows a result. */
export function noteSubject(command: string): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const position = editor.selection.active;
  const word = editor.document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
  const file = editor.document.uri.fsPath;
  const where = `${path.basename(file)}:${position.line + 1}`;
  pending.set(command, { file, offset: editor.document.offsetAt(position), line: position.line, label: word ? `${editor.document.getText(word)} (${where})` : where });
}

export function all(): Record<string, LastSubject> {
  return memento?.get<Record<string, LastSubject>>(key) ?? {};
}

export function onDidChangeSubjects(listener: () => void): vscode.Disposable {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/** Puts the cursor back where the command last ran; false when that file is gone. */
export async function goToSubject(command: string): Promise<boolean> {
  const subject = all()[command];
  if (!subject) return false;
  try {
    const document = await vscode.workspace.openTextDocument(subject.file);
    const position = document.positionAt(Math.min(subject.offset, document.getText().length));
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preserveFocus: false });
    return true;
  } catch {
    return false;
  }
}
