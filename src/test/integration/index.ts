import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ImpactResult } from '../../analysis/types';
import { ProjectService } from '../../analysis/project';
import { changeSignature } from '../../refactor/changeSignature';
import { planFileDelete } from '../../refactor/safeDelete';
import { introduceParameter } from '../../refactor/introduceParameter';
import { moveMembers } from '../../refactor/moveMembers';
import { applyRefactor } from '../../ui/applyRefactor';

// Refactorings write to files, so the tests work on a throwaway copy of the sample project.
const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-sample-'));
fs.cpSync(path.resolve(__dirname, '../../../sample'), sample, { recursive: true });

/** Runs inside VS Code via --extensionTestsPath; started by scripts/integration.js. */
export async function run(): Promise<void> {
  try {
    await testImpact();
    // Before the refactorings, which edit the sample files.
    await analysisCommandsFlow();
    await changeSignatureFlow();
    await safeDeleteFlow();
    await intentionFlow();
    await introduceParameterFlow();
    await moveMembersFlow();
    await missingAwaitFlow();
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

async function introduceParameterFlow(): Promise<void> {
  const discount = vscode.Uri.file(path.join(sample, 'src/discount.ts'));
  const cart = vscode.Uri.file(path.join(sample, 'src/cart.ts'));
  const document = await vscode.workspace.openTextDocument(discount);
  const start = document.getText().indexOf('100');
  const range = new vscode.Range(document.positionAt(start), document.positionAt(start + 3));
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', discount, range);
  assert.ok(actions.some((a) => a.title === 'Introduce Parameter…'), 'Introduce Parameter is not offered for a selection');

  const projects = new ProjectService();
  const result = introduceParameter(projects.createVirtualProject(discount.fsPath), discount.fsPath, start, start + 3, {
    name: 'divisor',
    mode: 'optional',
    replaceAll: true,
  });
  assert.deepEqual(result.conflicts, []);
  assert.ok(await applyRefactor(result, false));
  assert.match(document.getText(), /coupon\?: Coupon, divisor: number = 100\)/);
  assert.match(document.getText(), /\/ divisor;/);
  console.log('introduce parameter ok');
  await revert([discount, cart]);
}

async function moveMembersFlow(): Promise<void> {
  const cart = path.join(sample, 'src/cart.ts');
  const checkout = path.join(sample, 'src/checkout.ts');
  const document = await vscode.workspace.openTextDocument(cart);
  const at = document.positionAt(document.getText().indexOf('calculateSubtotal'));
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', document.uri, new vscode.Range(at, at));
  assert.ok(actions.some((a) => a.title === 'Move to Existing Module…'), 'Move is not offered on a top-level declaration');

  const result = moveMembers(new ProjectService().createVirtualProject(cart), cart, ['calculateSubtotal'], checkout, { keepReExport: true });
  assert.deepEqual(result.conflicts, []);
  assert.ok(await applyRefactor(result, false));
  const checkoutText = (await vscode.workspace.openTextDocument(checkout)).getText();
  assert.match(checkoutText, /export function calculateSubtotal/);
  assert.match(document.getText(), /export \{ calculateSubtotal \} from '\.\/checkout';/);
  console.log('move members ok');
  await revert([vscode.Uri.file(cart), vscode.Uri.file(checkout)]);
}

async function missingAwaitFlow(): Promise<void> {
  const file = vscode.Uri.file(path.join(sample, 'src/notifications.ts'));
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  const diagnostics = await waitForDiagnostics(file, (d) => d.source === 'TS Structure');
  assert.equal(diagnostics.length, 1, diagnostics.map((d) => d.message).join('\n'));
  assert.match(diagnostics[0].message, /notify\(\) \(from send\(\)\) is not awaited/);
  assert.equal(diagnostics[0].relatedInformation?.length, 1);

  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, diagnostics[0].range);
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes("Suppress 'missingAwait' for this line"), titles.join(', '));
  assert.ok(await vscode.workspace.applyEdit(actions.find((a) => a.title === 'Add await')!.edit!));
  assert.match(document.getText(), /await notify\(message\);/);
  await waitForDiagnostics(file, (d) => d.source === 'TS Structure', 0);
  console.log('missing await diagnostics and fix ok');
  await revert([file]);
}

/** Every analysis command runs from the editor and renders its report in the Analysis view. */
async function analysisCommandsFlow(): Promise<void> {
  const cart = vscode.Uri.file(path.join(sample, 'src/cart.ts'));
  const document = await vscode.workspace.openTextDocument(cart);
  const editor = await vscode.window.showTextDocument(document);
  const at = (needle: string, delta = 1) => {
    const position = document.positionAt(document.getText().indexOf(needle) + delta);
    editor.selection = new vscode.Selection(position, position);
  };
  const cases: [string, string, unknown[]?][] = [
    ['tsStructure.dataFlow', 'subtotal = '],
    ['tsStructure.mutationTracking', 'calculateTotal'],
    ['tsStructure.sideEffects', 'calculateTotal'],
    ['tsStructure.nullability', 'coupon);'],
    ['tsStructure.promiseRejections', 'calculateTotal'],
    ['tsStructure.exceptionFlow', 'calculateTotal'],
    ['tsStructure.deadExports', 'calculateTotal'],
    ['tsStructure.findDuplicates', 'calculateTotal', ['project']],
    ['tsStructure.semanticUsages', 'calculateSubtotal('],
    ['tsStructure.reexportChain', 'calculateDiscount,'],
    ['tsStructure.typeHierarchy', 'LineItem {'],
    ['tsStructure.overrideImpact', 'price: number'],
    ['tsStructure.argumentFlow', 'items: LineItem[]): number'],
    ['tsStructure.dependencyPath', 'calculateTotal', [cart, vscode.Uri.file(path.join(sample, 'src/discount.ts'))]],
  ];
  for (const [command, needle, args] of cases) {
    at(needle);
    const report = await vscode.commands.executeCommand<{ title: string; roots: unknown[]; description?: string }>(command, ...(args ?? []));
    assert.ok(report, `${command} returned no report`);
    console.log(`${command}: ${report.title} — ${report.description ?? ''} (${report.roots.length} rows)`);
  }
  // History, navigation and export of the last reports.
  await vscode.commands.executeCommand('tsStructure.report.back');
  await vscode.commands.executeCommand('tsStructure.report.forward');
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  assert.match(await vscode.env.clipboard.readText(), /^## cart\.ts → discount\.ts/);
  await vscode.commands.executeCommand('tsStructure.report.next');
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), cart.fsPath.toLowerCase());
  console.log('report history, export and navigation ok');

  await vscode.commands.executeCommand('tsStructure.structuralSearch');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Structural Search');
  assert.ok(tab, 'Structural Search panel did not open');
  await vscode.window.tabGroups.close(tab);
  console.log('analysis commands ok');
}

/** Waits until the file has the expected number of matching diagnostics (at least one by default). */
async function waitForDiagnostics(uri: vscode.Uri, filter: (d: vscode.Diagnostic) => boolean, count?: number): Promise<vscode.Diagnostic[]> {
  for (let i = 0; i < 100; i++) {
    const found = vscode.languages.getDiagnostics(uri).filter(filter);
    if (count === undefined ? found.length > 0 : found.length === count) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return vscode.languages.getDiagnostics(uri).filter(filter);
}

async function revert(uris: vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
