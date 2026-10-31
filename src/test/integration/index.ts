import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as vscode from 'vscode';
import { ImpactResult } from '../../analysis/types';

/** Runs inside VS Code via --extensionTestsPath; started by scripts/integration.js. */
export async function run(): Promise<void> {
  const file = vscode.Uri.file(path.resolve(__dirname, '../../../sample/src/impactSource.ts'));
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);

  const analyzeAt = async (needle: string, scope: 'symbol' | 'module') => {
    const position = document.positionAt(document.getText().indexOf(needle));
    editor.selection = new vscode.Selection(position, position);
    const result = await vscode.commands.executeCommand<ImpactResult>('tsImpact.analyze', scope);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    assert.ok(result, 'analyze returned no result');
    return result;
  };

  const symbol = await analyzeAt('formatImpactLabel(count: number)', 'symbol');
  assert.deepEqual(symbol.tests.map((t) => t.test.title).sort(), ['formats a single impacted test', 'prefixes the display label']);
  console.log('symbol scope ok:', symbol.tests.map((t) => t.path.map((s) => s.name).join(' -> ')));

  const module = await analyzeAt('export', 'module');
  assert.equal(module.tests.length, 3);
  console.log('module scope ok:', module.tests.length, 'tests');

  // Unsaved edits are analyzed: displayImpactLabel no longer calls formatImpactLabel.
  const call = 'return `Impact: ${formatImpactLabel(count)}`;';
  const start = document.positionAt(document.getText().indexOf(call));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(file, new vscode.Range(start, start.translate(0, call.length)), 'return `Impact: ${count}`;');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const edited = await analyzeAt('formatImpactLabel(count: number)', 'symbol');
  assert.deepEqual(edited.tests.map((t) => t.test.title), ['formats a single impacted test']);
  console.log('unsaved edit ok');
  await vscode.commands.executeCommand('workbench.action.files.revert');
}
