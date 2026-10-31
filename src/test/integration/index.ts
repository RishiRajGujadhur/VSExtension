import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ImpactResult } from '../../analysis/types';
import { ProjectService } from '../../analysis/project';
import { changeSignature } from '../../refactor/changeSignature';
import { planFileDelete } from '../../refactor/safeDelete';
import { applyRefactor } from '../../ui/applyRefactor';

// Refactorings write to files, so the tests work on a throwaway copy of the sample project.
const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-sample-'));
fs.cpSync(path.resolve(__dirname, '../../../sample'), sample, { recursive: true });

/** Runs inside VS Code via --extensionTestsPath; started by scripts/integration.js. */
export async function run(): Promise<void> {
  try {
    await testImpact();
    await changeSignatureFlow();
    await safeDeleteFlow();
    await intentionFlow();
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      fs.rmSync(sample, { recursive: true, force: true });
    } catch {
      // VS Code may still hold the folder open on Windows; it is in the temp directory either way.
    }
  }
}

async function testImpact(): Promise<void> {
  const file = vscode.Uri.file(path.join(sample, 'src/impactSource.ts'));
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
  console.log('test impact, symbol scope ok:', symbol.tests.map((t) => t.path.map((s) => s.name).join(' -> ')));

  const module = await analyzeAt('export', 'module');
  assert.equal(module.tests.length, 3);
  console.log('test impact, module scope ok:', module.tests.length, 'tests');

  // Unsaved edits are analyzed: displayImpactLabel no longer calls formatImpactLabel.
  const call = 'return `Impact: ${formatImpactLabel(count)}`;';
  const start = document.positionAt(document.getText().indexOf(call));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(file, new vscode.Range(start, start.translate(0, call.length)), 'return `Impact: ${count}`;');
  assert.ok(await vscode.workspace.applyEdit(edit));
  const edited = await analyzeAt('formatImpactLabel(count: number)', 'symbol');
  assert.deepEqual(edited.tests.map((t) => t.test.title), ['formats a single impacted test']);
  console.log('test impact, unsaved edit ok');
  await revert([file]);
}

async function changeSignatureFlow(): Promise<void> {
  const discount = vscode.Uri.file(path.join(sample, 'src/discount.ts'));
  const cart = vscode.Uri.file(path.join(sample, 'src/cart.ts'));
  const document = await vscode.workspace.openTextDocument(discount);
  const editor = await vscode.window.showTextDocument(document);
  const offset = document.getText().indexOf('calculateDiscount');
  editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset));

  await vscode.commands.executeCommand('tsStructure.changeSignature');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const tab = tabs.find((t) => t.input instanceof vscode.TabInputWebview);
  assert.ok(tab, `Change Signature dialog did not open; tabs: ${tabs.map((t) => `${t.label} (${t.input?.constructor.name})`).join(', ')}`);
  assert.equal(tab.label, 'Change Signature: calculateDiscount');
  await vscode.window.tabGroups.close(tab);
  console.log('change signature dialog ok');

  const projects = new ProjectService((f) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === path.resolve(f).toLowerCase())?.getText());
  const result = changeSignature(projects.createVirtualProject(discount.fsPath), discount.fsPath, offset, {
    parameters: [{ originalIndex: 0, name: 'amount' }, { name: 'currency', type: 'string', callValue: "'USD'" }, { originalIndex: 1, name: 'coupon' }],
  });
  assert.deepEqual(result.conflicts, []);
  assert.ok(await applyRefactor(result, false));
  const cartText = (await vscode.workspace.openTextDocument(cart)).getText();
  assert.match(cartText, /calculateDiscount\(subtotal, 'USD', coupon\)/);
  assert.match(document.getText(), /calculateDiscount\(amount: number, currency: string, coupon\?: Coupon\)/);
  assert.match(document.getText(), /Math\.round\(amount \* coupon\.percent\)/);
  console.log('change signature apply ok');
  await revert([discount, cart]);
}

async function safeDeleteFlow(): Promise<void> {
  const source = vscode.Uri.file(path.join(sample, 'src/impactSource.ts'));
  const document = await vscode.workspace.openTextDocument(source);
  const at = document.positionAt(document.getText().indexOf('sumTotals'));
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', source, new vscode.Range(at, at));
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes('Safe Delete…') && titles.includes('Change Signature…'), `lightbulb actions: ${titles.join(', ')}`);
  console.log('safe delete lightbulb ok');

  const testFile = path.join(sample, 'src/impactSource.test.ts');
  const plan = planFileDelete(new ProjectService().createVirtualProject(testFile), testFile);
  assert.deepEqual(plan.usages, []);
  assert.ok(await applyRefactor(plan.result, false));
  assert.equal(fs.existsSync(testFile), false);
  console.log('safe delete file ok');
}

async function intentionFlow(): Promise<void> {
  const file = vscode.Uri.file(path.join(sample, 'src/discount.ts'));
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  const at = document.positionAt(document.getText().indexOf('if (!coupon)') + 1);
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, new vscode.Range(at, at));
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes("Remove braces from 'if' statement"), `intentions: ${titles.join(', ')}`);
  const removeBraces = actions.find((a) => a.title === "Remove braces from 'if' statement")!;
  assert.ok(await vscode.workspace.applyEdit(removeBraces.edit!));
  assert.match(document.getText(), /if \(!coupon\) return 0;/);
  console.log('intentions ok:', titles.filter((t) => !t.endsWith('…')).join(' | '));
  await revert([file]);
}

async function revert(uris: vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
