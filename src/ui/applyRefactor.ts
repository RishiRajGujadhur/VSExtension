import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathKey } from '../analysis/paths';
import { AnalysisError } from '../analysis/types';
import { RefactorError, RefactorResult } from '../refactor/types';

const output = vscode.window.createOutputChannel('TypeScript Structure');

/**
 * Applies a computed refactoring after showing its conflicts. With `preview`, VS Code's Refactor
 * Preview lets the user review and untick individual changes before anything is written.
 */
export async function applyRefactor(result: RefactorResult, preview: boolean): Promise<boolean> {
  if (result.changes.length === 0) {
    void vscode.window.showInformationMessage(`${result.label}: nothing to change.`);
    return false;
  }
  if (result.conflicts.length > 0) {
    output.appendLine(`${result.label}: ${result.conflicts.length} problem(s)`);
    for (const conflict of result.conflicts) {
      const where = conflict.location ? ` (${vscode.workspace.asRelativePath(conflict.location.file)}:${conflict.location.line + 1})` : '';
      output.appendLine(`  - ${conflict.message}${where}`);
    }
    const shown = result.conflicts.slice(0, 6).map((c) => `• ${c.message}`).join('\n');
    const more = result.conflicts.length > 6 ? `\n…and ${result.conflicts.length - 6} more (see the TypeScript Structure output).` : '';
    const proceed = preview ? 'Preview Anyway' : 'Apply Anyway';
    const choice = await vscode.window.showWarningMessage(`${result.label} found problems`, { modal: true, detail: shown + more }, proceed, 'Show Details');
    if (choice === 'Show Details') {
      output.show(true);
      return false;
    }
    if (choice !== proceed) {
      return false;
    }
  }

  const stale = result.changes.find((c) => c.before !== undefined && currentText(c.file) !== c.before);
  if (stale) {
    void vscode.window.showWarningMessage(`${path.basename(stale.file)} changed while the refactoring was computed. Run it again.`);
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  const metadata: vscode.WorkspaceEditEntryMetadata = { label: result.label, needsConfirmation: preview };
  for (const change of result.changes) {
    const uri = vscode.Uri.file(change.file);
    if (change.before === undefined) {
      edit.createFile(uri, { ignoreIfExists: false, contents: Buffer.from(change.after ?? '') }, metadata);
    } else if (change.after === undefined) {
      edit.deleteFile(uri, { ignoreIfNotExists: true }, metadata);
    } else {
      const { start, end, text } = minimalReplacement(change.before, change.after);
      const document = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text, metadata);
    }
  }
  return vscode.workspace.applyEdit(edit, { isRefactoring: true });
}

function currentText(fileName: string): string | undefined {
  const key = pathKey(fileName);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key);
  if (open) {
    return open.getText();
  }
  try {
    return fs.readFileSync(fileName, 'utf8');
  } catch {
    return undefined;
  }
}

/** One replacement covering everything between the common prefix and suffix. */
function minimalReplacement(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix++;
  }
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
}

export function reportError(error: unknown, label: string): void {
  const message = error instanceof Error ? error.message : String(error);
  // Expected failures explain themselves; anything else is a bug worth a stack trace.
  const expected = error instanceof RefactorError || error instanceof AnalysisError;
  void vscode.window.showErrorMessage(expected ? message : `${label} failed: ${message}`);
  if (!expected) {
    output.appendLine(`${label} failed: ${error instanceof Error ? error.stack : message}`);
  }
}
