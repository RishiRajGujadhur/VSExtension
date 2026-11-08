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
import { features } from '../../structure/features';
import { hashText } from '../../analysis/paths';

// Refactorings write to files, so the tests work on a throwaway copy of the sample project.
const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-sample-'));
fs.cpSync(path.resolve(__dirname, '../../../sample'), sample, { recursive: true });

/** Runs inside VS Code via --extensionTestsPath; started by scripts/integration.js. */
export async function run(): Promise<void> {
  // Most features start off; every one of them is exercised here.
  for (const feature of features) {
    await vscode.workspace.getConfiguration('tsStructure.features').update(feature.id, true, vscode.ConfigurationTarget.Global);
  }
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
    await compilerErrorFlow();
    await unexportAllFlow();
    await reportActionsFlow();
    await customInspectionFlow();
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

/** A saved custom inspection reports matches, and its lightbulb can edit or disable it. */
async function customInspectionFlow(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('tsStructure');
  await settings.update('customInspections', [{ id: 'no-console-log', pattern: 'console.log($args*$)', message: 'Use the logger', severity: 'warning' }], vscode.ConfigurationTarget.Workspace);
  const file = vscode.Uri.file(path.join(sample, 'src/logging.ts'));
  fs.writeFileSync(file.fsPath, "export function hello(): void {\n  console.log('hello');\n}\n");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  const [finding] = await waitForDiagnostics(file, (d) => d.message === 'Use the logger');
  assert.ok(finding, 'custom inspection did not report');
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, finding.range);
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes("Edit custom inspection 'no-console-log'…"), titles.join(', '));
  const disable = actions.find((a) => a.title === "Disable custom inspection 'no-console-log'")!;
  await vscode.commands.executeCommand(disable.command!.command, ...(disable.command!.arguments ?? []));
  assert.equal((await waitForDiagnostics(file, (d) => d.message === 'Use the logger', 0)).length, 0);
  await settings.update('customInspections', undefined, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('custom inspection actions ok');
}

/** The Dead Export report's file button removes every unneeded export keyword in the file at once. */
async function unexportAllFlow(): Promise<void> {
  const file = path.join(sample, 'src/localOnly.ts');
  fs.writeFileSync(file, 'export const rate = 2;\n\nexport function double(n: number): number {\n  return n * rate;\n}\n');
  const at = (line: number, character: number) => ({ file, line, character, endLine: line, endCharacter: character + 4 });
  await vscode.commands.executeCommand('tsStructure.report.unexportAll', {
    label: 'localOnly.ts',
    action: { kind: 'unexportAll', file },
    children: [{ label: 'rate', location: at(0, 13) }, { label: 'double', location: at(2, 16) }],
  });
  const text = (await vscode.workspace.openTextDocument(file)).getText();
  assert.equal(text, 'const rate = 2;\n\nfunction double(n: number): number {\n  return n * rate;\n}\n');
  await vscode.commands.executeCommand('workbench.action.files.saveAll');
  console.log('remove all export keywords ok');
}

/** Fix All on a group, fixes applied one after another in one file, @public and the group's Remove export. */
async function reportActionsFlow(): Promise<void> {
  const file = path.join(sample, 'src/fixes.ts');
  const original = 'load();\nsave();\nsend();\n';
  fs.writeFileSync(file, original);
  const hash = hashText(original);
  const fix = (offset: number) => ({ kind: 'applyFix', file, hash, edits: [{ start: offset, end: offset, text: 'void ' }], title: 'void' });
  // Two rows computed against the same text: the second still applies after the first changed the file.
  await vscode.commands.executeCommand('tsStructure.report.applyFix', { label: 'load', action: fix(0) });
  await vscode.commands.executeCommand('tsStructure.report.applyFix', { label: 'send', action: fix(16) });
  const document = await vscode.workspace.openTextDocument(file);
  assert.equal(document.getText(), 'void load();\nsave();\nvoid send();\n');
  // Fix All on a group applies what is left, skipping what is already done.
  await vscode.commands.executeCommand('tsStructure.report.applyAllFixes', { label: 'missingAwait', children: [0, 8, 16].map((offset) => ({ label: `at ${offset}`, action: fix(offset) })) });
  assert.equal(document.getText(), 'void load();\nvoid save();\nvoid send();\n');
  console.log('apply fix after fix, and fix all ok');

  const api = path.join(sample, 'src/api.ts');
  fs.writeFileSync(api, '/** Totals. */\nexport function total(): number {\n  return 1;\n}\n\nexport const rate = 2;\nexport const used = rate;\n');
  const at = (line: number, character: number, length: number) => ({ file: api, line, character, endLine: line, endCharacter: character + length });
  await vscode.commands.executeCommand('tsStructure.report.markPublic', { label: 'total', location: at(1, 16, 5), action: { kind: 'deadExport', file: api, name: 'total' } });
  // On the group row, every file below it.
  await vscode.commands.executeCommand('tsStructure.report.unexportAll', {
    label: 'Exported but only used locally',
    action: { kind: 'unexportAll' },
    children: [{ label: 'api.ts', action: { kind: 'unexportAll', file: api }, children: [{ label: 'rate', location: at(5, 13, 4) }] }],
  });
  assert.equal((await vscode.workspace.openTextDocument(api)).getText(), '/** Totals. @public */\nexport function total(): number {\n  return 1;\n}\n\nconst rate = 2;\nexport const used = rate;\n');
  console.log('mark as public API and remove exports from the group ok');
  await vscode.commands.executeCommand('workbench.action.files.saveAll');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** TypeScript's "possibly undefined" errors offer to explain themselves with the Nullability Path Explorer. */
async function compilerErrorFlow(): Promise<void> {
  const file = vscode.Uri.file(path.join(sample, 'src/possiblyUndefined.ts'));
  fs.writeFileSync(file.fsPath, 'export function nameOf(user?: { name: string }): string {\n  return user.name;\n}\n');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  const [error] = await waitForDiagnostics(file, (d) => d.source === 'ts');
  assert.ok(error, 'no TypeScript error');
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, error.range);
  const explain = actions.find((a) => a.title === "Explain why 'user' may be null or undefined");
  assert.ok(explain?.command, actions.map((a) => a.title).join(', '));
  await vscode.commands.executeCommand(explain.command.command, ...(explain.command.arguments ?? []));
  console.log('explain compiler error ok');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function missingAwaitFlow(): Promise<void> {
  const file = vscode.Uri.file(path.join(sample, 'src/notifications.ts'));
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  const diagnostics = await waitForDiagnostics(file, (d) => d.source === 'X-Ray');
  assert.equal(diagnostics.length, 1, diagnostics.map((d) => d.message).join('\n'));
  assert.match(diagnostics[0].message, /notify\(\) \(from send\(\)\) is not awaited/);
  assert.equal(diagnostics[0].relatedInformation?.length, 1);

  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, diagnostics[0].range);
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes("Suppress 'missingAwait' for this line"), titles.join(', '));
  assert.ok(titles.includes('Trace where this promise’s rejection goes…'), titles.join(', '));
  assert.ok(titles.includes("Suppress 'missingAwait' for this file"), titles.join(', '));

  const report = await vscode.commands.executeCommand<{ description?: string }>('tsStructure.inspectCode', 'file');
  assert.match(report?.description ?? '', /^1 problem in 1 file/);
  const fixAll = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', file, new vscode.Range(0, 0, 0, 0), 'source.fixAll.tsStructure');
  assert.equal(fixAll.length, 1, fixAll.map((a) => a.title).join(', '));
  console.log('inspect code and fix-all ok');

  assert.ok(await vscode.workspace.applyEdit(actions.find((a) => a.title === 'Add await')!.edit!));
  assert.match(document.getText(), /await notify\(message\);/);
  await waitForDiagnostics(file, (d) => d.source === 'X-Ray', 0);
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
    // The diagram tab replaces the editor for a while, after which VS Code hands out a new editor object.
    (vscode.window.activeTextEditor ?? editor).selection = new vscode.Selection(position, position);
  };
  const cases: [string, string, unknown[]?][] = [
    ['tsStructure.dataFlow', 'subtotal = '],
    ['tsStructure.mutationTracking', 'calculateTotal'],
    ['tsStructure.mutationTrackingVariable', 'subtotal = '],
    ['tsStructure.raceConditions', 'subtotal = '],
    ['tsStructure.sideEffects', 'calculateTotal'],
    ['tsStructure.nullability', 'coupon);'],
    ['tsStructure.promiseRejections', 'calculateTotal'],
    ['tsStructure.exceptionFlow', 'calculateTotal'],
    ['tsStructure.deadExports', 'calculateTotal', ['project']],
    ['tsStructure.deadExports', 'calculateTotal', ['file']],
    ['tsStructure.findDuplicates', 'calculateTotal', ['project']],
    ['tsStructure.findDuplicates', 'calculateTotal', ['open']],
    ['tsStructure.auditTypeAssertions', 'calculateTotal', ['folder']],
    ['tsStructure.mutationTrackingProject', 'calculateTotal', ['open']],
    ['tsStructure.inspectCode', 'calculateTotal', ['function']],
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
  // Data Flow Diagram opens the chart in an editor tab; closing it brings the code back.
  at('subtotal = ');
  const drawn = await vscode.commands.executeCommand<{ kind: string }>('tsStructure.dataFlowDiagram');
  assert.equal(drawn?.kind, 'dataFlow');
  // The tab appears, and its title names the analysis once the chart has drawn it.
  const active = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  for (let i = 0; i < 50 && !/^Diagram: /.test(active()?.label ?? ''); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagramTab = active();
  assert.ok(diagramTab?.input instanceof vscode.TabInputWebview && diagramTab.input.viewType.endsWith('tsStructure.diagram'), `tabs: ${vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => t.label).join(', ')).join(' | ')}`);
  assert.match(diagramTab.label, /^Diagram: Data flow of subtotal/);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.window.showTextDocument(document);
  console.log('data flow diagram ok');

  // Control Flow Graph draws the function at the cursor in its own tab; Explain Value Path reports in the results view.
  at('subtotal = ');
  const chart = await vscode.commands.executeCommand<{ name: string; nodes: unknown[]; paths: unknown[] }>('tsStructure.controlFlow');
  assert.ok(chart && chart.nodes.length > 2 && chart.paths.length > 0, 'control flow chart');
  for (let i = 0; i < 50 && !/^Control Flow: /.test(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label).join('|')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const flowTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('Control Flow: '));
  assert.ok(flowTab, 'the Control Flow tab opens');
  console.log(`control flow ok: ${chart.name}, ${chart.nodes.length} boxes, ${chart.paths.length} paths`);
  await vscode.window.tabGroups.close(flowTab);
  await vscode.window.showTextDocument(document);
  at('subtotal = ');
  const values = await vscode.commands.executeCommand<{ title: string; description?: string }>('tsStructure.explainValue');
  assert.ok(values, 'explain value report');
  console.log(`explain value ok: ${values.title} — ${values.description}`);

  // The Actions view's title commands rearrange it and can be undone by running them again.
  await vscode.commands.executeCommand('workbench.view.extension.tsStructure');
  for (const command of ['toggleDescriptions', 'toggleDescriptions', 'collapseAll', 'collapseAll', 'toggleMostUsed', 'toggleMostUsed', 'showHidden']) {
    await vscode.commands.executeCommand(`tsStructure.actions.${command}`);
  }
  await vscode.window.showTextDocument(document);
  console.log('actions view commands ok');

  // From the Explorer with two files selected, the path between them, without the picker.
  const discount = vscode.Uri.file(path.join(sample, 'src/discount.ts'));
  const between = await vscode.commands.executeCommand<{ title: string }>('tsStructure.dependencyPath', cart, [cart, discount]);
  assert.equal(between?.title, 'cart.ts → discount.ts');
  console.log('dependency path from two selected files ok');

  // History, navigation and export of the last reports.
  await vscode.commands.executeCommand('tsStructure.report.back');
  await vscode.commands.executeCommand('tsStructure.report.forward');
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  assert.match(await vscode.env.clipboard.readText(), /^## cart\.ts → discount\.ts/);
  await vscode.commands.executeCommand('tsStructure.report.next');
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), cart.fsPath.toLowerCase());
  console.log('report history, export and navigation ok');

  // Show Groups hides the other top-level groups, in the view and in what is copied.
  at('calculateSubtotal(');
  await vscode.commands.executeCommand('tsStructure.semanticUsages');
  await vscode.commands.executeCommand('tsStructure.report.chooseGroups', ['Calls']);
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  const shown = await vscode.env.clipboard.readText();
  assert.match(shown, /Calls/);
  assert.doesNotMatch(shown, /Definitions/);
  console.log('show groups ok');

  // Limit Results to Scope keeps the rows in the current file, and Show All Results brings the rest back.
  await vscode.commands.executeCommand('tsStructure.report.chooseGroups', ['Definitions', 'Calls', 'Imports', 'Reads', 'Writes', 'Exports', 'Type References', 'Other']);
  await vscode.commands.executeCommand('tsStructure.report.limitScope', 'file');
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  const limited = await vscode.env.clipboard.readText();
  assert.match(limited, /cart\.ts:\d+/);
  assert.doesNotMatch(limited, /checkout\.ts:\d+|cart\.test\.ts:\d+/, limited);
  await vscode.commands.executeCommand('tsStructure.report.clearLimit');
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  assert.match(await vscode.env.clipboard.readText(), /(checkout|cart\.test)\.ts:\d+/);
  console.log('limit results to scope ok');

  // Find Usages in Current File: the same search, limited to the file at hand.
  at('calculateSubtotal(');
  await vscode.commands.executeCommand('tsStructure.semanticUsagesInFile');
  await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
  const inFile = await vscode.env.clipboard.readText();
  assert.match(inFile, /cart\.ts:\d+/);
  assert.doesNotMatch(inFile, /checkout\.ts:\d+|cart\.test\.ts:\d+/, inFile);
  await vscode.commands.executeCommand('tsStructure.report.clearLimit');
  console.log('find usages in current file ok');

  // Analyses in the lightbulb on a declaration name, and copies of selected statements.
  const name = document.positionAt(document.getText().indexOf('calculateTotal') + 2);
  const analyses = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', cart, new vscode.Range(name, name), 'refactor.tsStructure.analyze');
  const analysisTitles = analyses.map((a) => a.title);
  assert.ok(analysisTitles.includes('Show side effects of calculateTotal()') && analysisTitles.includes('Show errors thrown by calculateTotal()'), analysisTitles.join(', '));
  const statement = document.getText().indexOf('const subtotal = calculateSubtotal(items);');
  const selected = new vscode.Range(document.positionAt(statement), document.positionAt(statement + 'const subtotal = calculateSubtotal(items);'.length));
  const refactors = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', cart, selected, 'refactor.tsStructure');
  assert.ok(refactors.some((a) => a.title === 'Find copies of the selected code'), refactors.map((a) => a.title).join(', '));
  console.log('analysis lightbulb entries ok');

  // Side-effect CodeLens, off by default.
  await vscode.workspace.getConfiguration('tsStructure').update('codeLens.sideEffects', true, vscode.ConfigurationTarget.Global);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', cart);
  const titles = lenses.map((l) => l.command?.title).filter((t) => t?.includes('pure'));
  assert.equal(titles.length, 2, lenses.map((l) => l.command?.title).join(', '));
  // A feature that is off hides its lens and refuses its commands; turning it on again restores both.
  await vscode.workspace.getConfiguration('tsStructure.features').update('sideEffects', false, vscode.ConfigurationTarget.Global);
  const hidden = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', cart);
  assert.equal(hidden.filter((l) => l.command?.command === 'tsStructure.explainFinding').length, 0);
  at('calculateSubtotal(');
  assert.equal(await vscode.commands.executeCommand('tsStructure.sideEffects'), undefined);
  await vscode.workspace.getConfiguration('tsStructure.features').update('sideEffects', true, vscode.ConfigurationTarget.Global);
  const report = await vscode.commands.executeCommand<{ kind: string }>('tsStructure.sideEffects');
  assert.equal(report?.kind, 'sideEffects');
  await vscode.workspace.getConfiguration('tsStructure').update('codeLens.sideEffects', undefined, vscode.ConfigurationTarget.Global);
  console.log('side-effect code lens ok');
  console.log('feature switches ok');

  await vscode.commands.executeCommand('tsStructure.report.compareDuplicates', {
    label: 'Duplicate 1',
    action: { kind: 'compareDuplicates', copies: [{ file: 'a.ts', label: 'a', text: 'let x = 1;\n    x++;' }, { file: 'b.ts', label: 'b', text: 'let y = 2;\n  y++;' }] },
  });
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(diff?.input instanceof vscode.TabInputTextDiff, `active tab: ${diff?.label}`);
  // Common indentation is removed so copies at different depths line up.
  assert.equal((await vscode.workspace.openTextDocument(diff.input.modified)).getText(), 'let y = 2;\ny++;');
  await vscode.window.tabGroups.close(diff);
  console.log('compare duplicates ok');
  await vscode.window.showTextDocument(document);

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
