import * as assert from 'node:assert/strict';
import { sections } from '../../ui/settingsPanel';
import type { Report } from '../../structure/report';
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
  // The code model is never downloaded by the tests (the unit tests run it from assets/code-model): no prompt.
  await vscode.workspace.getConfiguration('tsStructure.reel').update('codeModel', 'off', vscode.ConfigurationTarget.Global);
  try {
    await explainCodeFlow();
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
    await cardEditsFlow();
    await compareWithCommitFlow();
    await selectionActionsFlow();
    await gitReelFlow();
  } catch (error) {
    // VS Code exits with 1 and does not always print why.
    console.error(`INTEGRATION FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw error;
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
  assert.equal(tab.label, 'Change parameters: calculateDiscount');
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

/** A chart card's edits include the editor's own refactorings at the box's code, and run when chosen; Show as card never fails. */
async function cardEditsFlow(): Promise<void> {
  const { editsFor, runEdit } = await import('../../ui/editActionsUi');
  const file = path.join(sample, 'src/cardEdits.ts');
  fs.writeFileSync(file, ['export function area(width: number, height: number): number {', '  const doubled = width * height * 2;', '  return doubled / 2;', '}', ''].join('\n'));
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
  // TypeScript needs a moment to load the project before it lists refactorings.
  let edits: Awaited<ReturnType<typeof editsFor>> = [];
  for (let i = 0; i < 40 && !edits.some((e) => /^Extract to/.test(e.label)); i++) {
    edits = await editsFor(document, 1, 18);
    if (!edits.some((e) => /^Extract to/.test(e.label))) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(edits.some((e) => /^Extract to/.test(e.label)), `no Extract refactoring among ${edits.map((e) => e.label).join(', ')}`);
  assert.ok(!edits.some((e) => e.label === 'More edits…'), 'More edits… shown although the editor offers edits');
  const constant = edits.find((e) => /^Extract to constant/.test(e.label)) ?? edits.find((e) => /^Extract to/.test(e.label))!;
  await runEdit(file, constant);
  for (let i = 0; i < 20 && document.getText().includes('const doubled = width * height * 2;'); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok(!document.getText().includes('const doubled = width * height * 2;'), 'the extract edit did not apply');
  await vscode.commands.executeCommand('undo');
  // Show as card twice in a row, with or without its page open: no "Webview is disposed".
  await vscode.commands.executeCommand('tsStructure.report.showAsCard');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('tsStructure.report.showAsCard');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('card edits and show as card ok');
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
  for (let i = 0; i < 50 && !/^Data flow: /.test(active()?.label ?? ''); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagramTab = active();
  assert.ok(diagramTab?.input instanceof vscode.TabInputWebview && diagramTab.input.viewType.endsWith('tsStructure.diagram'), `tabs: ${vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => t.label).join(', ')).join(' | ')}`);
  assert.match(diagramTab.label, /^Data flow: subtotal/);
  // The code model is offered on a Data flow chart, off until turned on: no tags, no Find by meaning.
  type Meaning = { available: boolean; on: boolean; purposes: Record<string, { label: string; by: string }> };
  const meaning = () => vscode.commands.executeCommand<Meaning>('tsStructure.diagram.meaningInfo');
  assert.deepEqual(await meaning(), { available: true, on: false, purposes: {} });
  assert.deepEqual(await vscode.commands.executeCommand('tsStructure.diagram.findByMeaning', 'where is it saved'), []);
  // Turned on (the model is in the test storage, as if downloaded): the boxes get their tags.
  await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', true, vscode.ConfigurationTarget.Global);
  try {
    let state = await meaning();
    for (let i = 0; i < 100 && !(state?.on && Object.keys(state.purposes).length); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await meaning();
    }
    assert.ok(state?.on, `the code model is on: ${JSON.stringify(state)}`);
    console.log(`data flow code model ok: ${Object.entries(state!.purposes).map(([k, p]) => `${k.split('/').pop()} → ${p.label} (${p.by})`).join('; ') || 'no box tagged'}`);
  } finally {
    await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', undefined, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.window.showTextDocument(document);
  console.log('data flow diagram ok');

  // Control Flow Graph draws the function at the cursor in its own tab; Explain Value Path reports in the results view.
  at('subtotal = ');
  const chart = await vscode.commands.executeCommand<{ name: string; nodes: unknown[]; paths: unknown[] }>('tsStructure.controlFlow');
  assert.ok(chart && chart.nodes.length > 2 && chart.paths.length > 0, 'control flow chart');
  for (let i = 0; i < 50 && !/Flowchart: /.test(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label).join('|')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const flowTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('Flowchart: '));
  assert.ok(flowTab, 'the Control Flow tab opens');
  console.log(`control flow ok: ${chart.name}, ${chart.nodes.length} boxes, ${chart.paths.length} paths`);
  // The flowchart offers the code model too (the wand button), on with the setting: its boxes get their tags.
  type FlowMeaning = { available: boolean; on: boolean; purposes: Record<string, { label: string }> };
  const flowMeaning = () => vscode.commands.executeCommand<FlowMeaning>('tsStructure.controlFlow.meaningInfo');
  assert.equal((await flowMeaning())?.available, true);
  await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', true, vscode.ConfigurationTarget.Global);
  try {
    let state = await flowMeaning();
    for (let i = 0; i < 100 && !state?.on; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await flowMeaning();
    }
    assert.ok(state?.on, `the flowchart's code model is on: ${JSON.stringify(state)}`);
    console.log(`flowchart code model ok: ${Object.values(state!.purposes).map((p) => p.label).join(', ') || 'no box tagged'}`);
  } finally {
    await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', undefined, vscode.ConfigurationTarget.Global);
  }
  await vscode.window.tabGroups.close(flowTab);
  await vscode.window.showTextDocument(document);
  at('subtotal = ');
  const values = await vscode.commands.executeCommand<{ title: string; description?: string }>('tsStructure.explainValue');
  assert.ok(values, 'explain value report');
  console.log(`explain value ok: ${values.title} — ${values.description}`);

  // Graphs: the call graph opens with callers and callees; the dependence graph adds arcs to the control flow chart.
  at('subtotal = ');
  const calls = await vscode.commands.executeCommand<{ kind: string; roots: { label: string }[] }>('tsStructure.callGraph');
  assert.equal(calls?.kind, 'callGraph');
  assert.deepEqual(calls.roots.map((r) => r.label).slice(0, 2), ['Called by', 'Calls']);
  await vscode.window.showTextDocument(document);
  at('subtotal = ');
  const dependences = await vscode.commands.executeCommand<{ dependences: { data: unknown[] } }>('tsStructure.dependenceGraph');
  assert.ok(dependences && dependences.dependences.data.length > 0, 'dependence arcs');
  console.log(`graphs ok: ${calls.roots.length} sides, ${dependences.dependences.data.length} data dependences`);
  // The charts these opened are closed again, so later steps find their own tabs.
  const charts = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && /tsStructure\.(diagram|controlFlow)$/.test(t.input.viewType));
  for (let i = 0; i < 5 && charts().length; i++) {
    await vscode.window.tabGroups.close(charts());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(charts().length, 0, 'the chart tabs close');
  // An analysis that can't start at the cursor explains itself rather than failing.
  await vscode.window.showTextDocument(document);
  const editorNow = vscode.window.activeTextEditor!;
  editorNow.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('tsStructure.reactState');
  console.log('error with fixes ok');

  // The Actions view's title commands rearrange it and can be undone by running them again.
  await vscode.commands.executeCommand('tsStructure.actions.focus');
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
  const activeEditor = vscode.window.activeTextEditor;
  assert.equal(report?.kind, 'sideEffects', `active: ${activeEditor?.document.uri.fsPath} at ${activeEditor?.selection.active.line}:${activeEditor?.selection.active.character}, word ${activeEditor && activeEditor.document.getText(activeEditor.document.getWordRangeAtPosition(activeEditor.selection.active))}`);
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
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Search by shape');
  assert.ok(tab, 'Search by shape panel did not open');
  await vscode.window.tabGroups.close(tab);

  // Settings: the page opens, and its sections are built from the real settings, Features and Animations first.
  await vscode.commands.executeCommand('tsStructure.openSettings');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const settingsTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Code X-Ray Settings');
  assert.ok(settingsTab, 'Settings panel did not open');
  const manifest = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ts-test-impact')!.packageJSON;
  const model = sections(manifest);
  assert.deepEqual(model.slice(0, 3).map((s) => s.title), ['Features', 'Animations', 'General']);
  assert.deepEqual(model[1].rows.map((r) => [r.label, r.value]), [['Button animations', false], ['Chart animations', true]]);
  await vscode.workspace.getConfiguration('tsStructure.animations').update('charts', false, vscode.ConfigurationTarget.Global);
  assert.equal(sections(manifest)[1].rows[1].value, false, 'the page shows a changed setting');
  assert.equal(sections(manifest)[1].rows[1].modified, true);
  await vscode.workspace.getConfiguration('tsStructure.animations').update('charts', undefined, vscode.ConfigurationTarget.Global);
  await vscode.window.tabGroups.close(settingsTab);
  console.log('settings ok');

  await csharpThroughLanguageServer();
  await tsql();
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

/**
 * C#: Find usages, Callers and calls and the family tree are built from the C# language server's answers. Here stand-in
 * providers give those answers (as the C# extension would), so the reports can be checked without it.
 */
/** Flowchart vs last commit: a function committed, then edited without saving, compared in the chart. */
async function compareWithCommitFlow(): Promise<void> {
  const { execFileSync } = await import('child_process');
  const file = path.join(sample, 'src', 'grade.ts');
  fs.writeFileSync(file, "export function grade(score: number) {\n  if (score > 90) return 'A';\n  return 'B';\n}\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: sample, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'sample');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((b) => b.insert(new vscode.Position(2, 0), "  if (score > 50) return 'C';\n"));
  editor.selection = new vscode.Selection(0, 18, 0, 18);
  type Shown = { current?: { name: string; nodes: { text: string }[] }; changes?: { added: number[]; changed: unknown[]; newPaths: number[]; gonePaths: unknown[]; against: string } };
  await vscode.commands.executeCommand('tsStructure.controlFlowCompare');
  let shown: Shown | undefined;
  for (let i = 0; i < 40 && !shown?.changes; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    shown = await vscode.commands.executeCommand<Shown>('tsStructure.controlFlow.current');
  }
  assert.equal(shown?.current?.name, 'grade');
  assert.ok(shown?.changes, 'the comparison with the last commit');
  const nodes = shown.current!.nodes;
  assert.deepEqual(shown.changes.added.map((id) => nodes[id].text).sort(), ["return 'C';", 'score > 50']);
  assert.deepEqual([shown.changes.changed.length, shown.changes.newPaths.length, shown.changes.gonePaths.length], [0, 2, 1]);
  assert.equal(shown.changes.against, 'the last commit');
  console.log('flowchart vs last commit ok');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** The Actions view with code highlighted: only the actions that work with it. */
async function selectionActionsFlow(): Promise<void> {
  const file = path.join(sample, 'src', 'grade.ts');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const text = document.getText();
  const select = (from: string, to = from) => {
    const start = text.indexOf(from);
    editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(text.indexOf(to, start) + to.length));
  };
  type Fit = { subject: string; commands: string[] } | undefined;
  select("if (score > 90) return 'A';");
  const code = await vscode.commands.executeCommand<Fit>('tsStructure.actions.selection');
  assert.equal(code?.subject, 'code in grade()');
  assert.ok(code.commands.includes('tsStructure.controlFlow') && code.commands.includes('tsStructure.findDuplicates'), code.commands.join(', '));
  assert.ok(!code.commands.includes('tsStructure.dataFlow') && !code.commands.includes('tsImpact.analyze'), code.commands.join(', '));
  select('score', 'score');
  const name = await vscode.commands.executeCommand<Fit>('tsStructure.actions.selection');
  assert.equal(name?.subject, 'the name score');
  assert.ok(name.commands.includes('tsStructure.dataFlow') && !name.commands.includes('tsStructure.controlFlow'), name.commands.join(', '));
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  assert.equal(await vscode.commands.executeCommand<Fit>('tsStructure.actions.selection'), undefined);
  console.log(`actions for the selection ok: ${code.commands.length} for code, ${name.commands.length} for a name`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Git reel: the changes since the last commit as a plan the player draws, in its own tab. */
/** Explain this code: highlighted code in plain sentences, in a page beside the editor, with nothing downloaded. */
async function explainCodeFlow(): Promise<void> {
  const file = path.join(sample, 'src', 'explainMe.ts');
  const code = 'export function addToCart(items: number[], item: number): number[] {\n  if (item <= 0) return items;\n  return [...items, item];\n}\n';
  fs.writeFileSync(file, code);
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  editor.selection = new vscode.Selection(0, 0, 3, 1);
  type Explained = { subject: string; purpose?: { text: string; by: string }; steps: string[] };
  const e = await vscode.commands.executeCommand<Explained>('tsStructure.explainCode');
  assert.equal(e?.subject, 'the function addToCart()', JSON.stringify(e));
  assert.deepEqual(e?.purpose, { text: 'Adds item to cart', by: 'rules' });
  assert.ok(e!.steps.length >= 1, JSON.stringify(e));
  const tab = await tabLabelled((label) => label.startsWith('Explain: '));
  assert.ok(tab, `the explanation opens beside the editor: ${vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label).join(' | ')}`);
  console.log(`explain this code ok: ${e!.purpose!.text}; ${e!.steps.join(' ')}`);
  // A function's name highlighted where it is called, in another file: that whole function, with what it takes,
  // gives back and changes, found through Go to Definition.
  const user = path.join(sample, 'src', 'explainUse.ts');
  fs.writeFileSync(user, "import { addToCart } from './explainMe';\n\nexport const basket = addToCart([], 3);\n");
  try {
    const userEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(user));
    const call = userEditor.document.getText().lastIndexOf('addToCart');
    userEditor.selection = new vscode.Selection(userEditor.document.positionAt(call), userEditor.document.positionAt(call + 'addToCart'.length));
    type Facts = { subject: string; facts?: { inputs: { name: string; type?: string }[]; output: { type?: string } } };
    let called: Facts | undefined;
    // The language server may still be starting: Go to Definition answers once it is up.
    for (let i = 0; i < 30 && called?.subject !== 'the function addToCart()'; i++) {
      called = await vscode.commands.executeCommand<Facts>('tsStructure.explainCode');
      if (called?.subject !== 'the function addToCart()') await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(called?.subject, 'the function addToCart()', JSON.stringify(called));
    assert.deepEqual(called!.facts!.inputs.map((i) => `${i.name}: ${i.type}`), ['items: number[]', 'item: number']);
    assert.equal(called!.facts!.output.type, 'number[]');
    console.log('explain this code by name ok: a call in another file explains the function it calls');
  } finally {
    fs.rmSync(user, { force: true });
    // The video below is of addToCart, from its own file.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    await vscode.commands.executeCommand('tsStructure.explainCode');
  }
  // As a video, in the Git reel's player: a scene per step on the flowchart. The voice-over is tested with the reel.
  const reelSettings = vscode.workspace.getConfiguration('tsStructure.reel');
  await reelSettings.update('narrationVoice', 'Off', vscode.ConfigurationTarget.Global);
  try {
    type VideoPlan = { meta: { title: string }; scenes: { kind: string; chapter?: string; caption: string }[] };
    const video = await vscode.commands.executeCommand<VideoPlan>('tsStructure.explainCode.video');
    assert.equal(video?.meta.title, 'What addToCart() does');
    // A scene per step on the flowchart (steps on one box together), ending on the last step.
    const flows = video!.scenes.filter((s) => s.kind === 'flow');
    assert.ok(flows.length >= 1 && video!.scenes[video!.scenes.length - 1] === flows[flows.length - 1], JSON.stringify(video!.scenes.map((s) => s.chapter ?? s.kind)));
    assert.ok(video!.scenes.every((s) => !/walk through/i.test(s.caption)));
    const player = await tabLabelled((label) => label === 'Video: What addToCart() does');
    assert.ok(player, `the video opens in the reel's player: ${vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label).join(' | ')}`);
    console.log(`explain this code video ok: ${video!.scenes.map((s) => s.chapter ?? s.kind).join(', ')}`);
  } finally {
    await reelSettings.update('narrationVoice', undefined, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function gitReelFlow(): Promise<void> {
  const file = path.join(sample, 'src', 'grade.ts');
  fs.writeFileSync(file, "export function grade(score: number) {\n  if (score > 90) return 'A';\n  if (score > 75) return 'B';\n  return 'C';\n}\n");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  type Plan = { meta: { title: string; files: number }; scenes: { kind: string; symbol?: string; caption: string; flow?: { nodes: { state: string }[] } }[] };
  const plan = await vscode.commands.executeCommand<Plan>('tsStructure.gitReel', 'HEAD');
  assert.ok(plan, 'a reel plan');
  // The code model is off for the reel here (the tests turned its offer off), whether or not it is on this computer
  // (the test storage has it, for the Data flow test).
  const model = await vscode.commands.executeCommand<{ downloaded: boolean }>('tsStructure.gitReel.codeModelInfo');
  assert.equal(typeof model?.downloaded, 'boolean');
  assert.equal(vscode.workspace.getConfiguration('tsStructure.reel').get('codeModel'), 'off');
  assert.equal(plan.meta.title, 'Uncommitted changes');
  const scene = plan.scenes.find((s) => s.symbol === 'grade');
  assert.ok(scene, plan.scenes.map((s) => s.caption).join(' | '));
  // What the change does, in words, with no counts.
  assert.equal(scene.caption, 'grade now checks whether the score is more than 75, and otherwise returns "C".');
  // No flowchart scenes.
  assert.ok(!plan.scenes.some((s) => s.kind === 'flow'));
  for (let i = 0; i < 40 && !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label.startsWith('Git reel')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === 'Git reel: Uncommitted changes'), 'the Git reel tab');
  console.log(`git reel ok: ${plan.scenes.length} scenes, ${scene.caption}`);
  // Full screen fills the editor area (its group maximized), never VS Code's own window; F again comes back.
  assert.equal(await vscode.commands.executeCommand<boolean>('tsStructure.gitReel.fullscreen'), true, 'full screen on');
  assert.equal(await vscode.commands.executeCommand<boolean>('tsStructure.gitReel.fullscreen'), false, 'full screen off');
  console.log('git reel full screen ok: the editor group, not the window');
  // Recorded by the editor's own engine: a WebM file, and an MP4 one where the engine can make it.
  for (const format of ['webm', 'mp4'] as const) {
    const out = path.join(os.tmpdir(), `reel-test.${format}`);
    const size = await vscode.commands.executeCommand<number>('tsStructure.gitReel.exportTo', out, format);
    if (!size) {
      console.log(`git reel ${format}: not supported by this editor`);
      continue;
    }
    const head = fs.readFileSync(out).subarray(0, 12);
    const valid = format === 'webm' ? head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : head.subarray(4, 8).toString() === 'ftyp';
    assert.ok(valid, `${format} header ${head.toString('hex')}`);
    console.log(`git reel ${format} ok: ${(size / 1024).toFixed(0)} KB`);
  }
  // With the voice on: each scene at least as long as its clip, and the sound in the video.
  const voiced = await vscode.commands.executeCommand<{ scenes: { seconds: number }[] }>('tsStructure.gitReel.voice', true);
  if (process.platform === 'win32') {
    assert.ok(voiced && voiced.scenes.length === plan.scenes.length && voiced.scenes.every((s) => s.seconds >= 3), 'scenes timed to the voice');
    // The downloaded voice model (Nano, in the test storage) reads, by default, a clip for every scene; the picker lists
    // its eight voices by the model they are of.
    const info = await vscode.commands.executeCommand<{ name?: string; voices: string[]; clips: number }>('tsStructure.gitReel.voiceInfo');
    assert.equal(info?.name, 'Jasper (Nano)', JSON.stringify(info));
    assert.deepEqual(info?.voices.slice(0, 8), ['Jasper', 'Bella', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'].map((v) => `${v} (Nano)`));
    assert.ok(info?.voices.every((v) => !/kitten/i.test(v)), 'no voice says Kitten');
    assert.equal(info?.clips, plan.scenes.length);
    console.log(`git reel voice ok: ${info?.name}, ${info?.clips} clips, ${info?.voices.length} voices offered`);
    await new Promise((r) => setTimeout(r, 1500));
    for (const format of ['webm', 'mp4'] as const) {
      const out = path.join(os.tmpdir(), `reel-voice.${format}`);
      const size = await vscode.commands.executeCommand<number>('tsStructure.gitReel.exportTo', out, format);
      if (!size) continue;
      // Started from code, with no click in the page, the browser keeps the sound off: the video is made all the same
      // (the recorder scene checks the voice itself, started with a key press).
      const bytes = fs.readFileSync(out);
      const hasAudio = format === 'webm' ? bytes.includes(Buffer.from('A_OPUS')) : bytes.includes(Buffer.from('mp4a'));
      assert.ok(size > 10_000, `${format} recorded with the voice on`);
      console.log(`git reel ${format} with the voice on ok: ${(size / 1024).toFixed(0)} KB, sound ${hasAudio ? 'in' : 'held back without a click'}`);
    }
    await vscode.commands.executeCommand('tsStructure.gitReel.voice', false);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/**
 * C# without a language server: Explain this code (a method's name where declared and where called), its video,
 * and Data flow with its chart, all from the bundled parser, run as a person runs them (the command, no arguments).
 */
async function csharpExplainAndDataFlow(): Promise<void> {
  const code = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'demo', 'csharp', 'OrderService.cs'), 'utf8');
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'src', 'OrderService.cs');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(code));
  const reelSettings = vscode.workspace.getConfiguration('tsStructure.reel');
  await reelSettings.update('narrationVoice', 'Off', vscode.ConfigurationTarget.Global);
  try {
    let document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'csharp') document = await vscode.languages.setTextDocumentLanguage(document, 'csharp');
    const select = async (needle: string, length = needle.length, from = 0) => {
      const editor = await vscode.window.showTextDocument(document);
      const at = code.indexOf(needle, from);
      editor.selection = new vscode.Selection(document.positionAt(at), document.positionAt(at + length));
      return editor;
    };
    type Explained = { subject: string; summary?: string; steps: string[]; facts?: { inputs: { name: string; type?: string }[]; output: { type?: string; later: boolean }; effects: string[] }; purpose?: { text: string } };

    // The method's name where it is declared: the whole method, with what it takes, gives back and changes.
    await select('PlaceOrderAsync');
    const placed = await vscode.commands.executeCommand<Explained>('tsStructure.explainCode');
    assert.equal(placed?.subject, 'the method PlaceOrderAsync()', JSON.stringify(placed));
    assert.equal(placed!.summary, 'PlaceOrderAsync is an async method that takes the customer and the coupon and returns a decimal, once it finishes.');
    assert.deepEqual(placed!.facts!.inputs.map((i) => `${i.name}: ${i.type}`), ['customer: string', 'coupon: string?']);
    assert.deepEqual(placed!.facts!.output, { type: 'decimal', later: true, values: ['amount'], nothing: false });
    assert.ok(placed!.facts!.effects.includes('changes attempts (++)'), placed!.facts!.effects.join(' | '));
    assert.equal(placed!.steps[0], 'If the customer is empty or blank, it fails with "A customer is needed".');
    assert.ok((await tabLabelled((label) => label === 'Explain: PlaceOrderAsync()')), 'the C# explanation opens beside the editor');
    console.log(`csharp explain ok: ${placed!.purpose?.text}; ${placed!.steps.slice(0, 3).join(' ')}`);

    // As a video, in the reel's player.
    const video = await vscode.commands.executeCommand<{ meta: { title: string; signature?: string }; scenes: { kind: string }[] }>('tsStructure.explainCode.video');
    assert.equal(video?.meta.title, 'What PlaceOrderAsync() does');
    assert.equal(video!.meta.signature, 'public async Task<decimal> PlaceOrderAsync(string customer, string? coupon)');
    assert.ok(video!.scenes.filter((s) => s.kind === 'flow').length >= 3, JSON.stringify(video!.scenes.map((s) => s.kind)));
    assert.ok(await tabLabelled((label) => label === 'Video: What PlaceOrderAsync() does'), 'the C# video opens in the player');
    console.log(`csharp explain video ok: ${video!.scenes.length} scenes`);

    // A method's name where it is called: that method.
    await select('SaveAsync(customer', 'SaveAsync'.length);
    const saved = await vscode.commands.executeCommand<Explained>('tsStructure.explainCode');
    assert.equal(saved?.subject, 'the method SaveAsync()', JSON.stringify(saved));
    console.log('csharp explain by name ok');

    // Data flow and its chart, from the parser.
    await select('amount = cart', 'amount'.length);
    const flow = await vscode.commands.executeCommand<Report>('tsStructure.dataFlow');
    assert.equal(flow?.kind, 'dataFlow', 'C# data flow report');
    assert.deepEqual(flow!.roots.map((r) => r.children!.map((c) => c.label)), [['= cart.Price()', '*= 0.9m'], ['SaveAsync(… amount …)', 'return amount']]);
    await select('amount = cart', 'amount'.length);
    const charted = await vscode.commands.executeCommand<Report>('tsStructure.dataFlowDiagram');
    assert.equal(charted?.kind, 'dataFlow');
    assert.ok(await tabLabelled((label) => label.startsWith('Data flow')), 'the C# data flow chart opens');
    console.log('csharp data flow ok');
  } finally {
    await reelSettings.update('narrationVoice', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(uri);
  }
}

async function csharpThroughLanguageServer(): Promise<void> {
  const code = [
    'namespace Shop {',
    '  public interface IPriced { decimal Price(); }',
    '  public class Cart : IPriced {',
    '    private decimal total;',
    '    public decimal Price() { total = 0; Add(1); return total; }',
    '    public void Add(decimal amount) { total += amount; }',
    '  }',
    '  public class Checkout { public decimal Pay(Cart cart) => cart.Price(); }',
    '}',
  ].join('\n');
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'src', 'Cart.cs');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(code));
  let document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId !== 'csharp') document = await vscode.languages.setTextDocumentLanguage(document, 'csharp');
  const at = (text: string, from = 0) => document.positionAt(code.indexOf(text, from));
  const range = (text: string, from = 0) => new vscode.Range(at(text, from), at(text, from).translate(0, text.length));
  const every = (word: string) => [...code.matchAll(new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`, 'g'))].map((m) => new vscode.Location(uri, new vscode.Range(document.positionAt(m.index!), document.positionAt(m.index! + word.length))));
  const item = (name: string, text: string, kind = vscode.SymbolKind.Method) => new vscode.CallHierarchyItem(kind, name, '', uri, range(text), range(text));
  const price = item('Price', 'Price() {'), pay = item('Pay', 'Pay('), add = item('Add', 'Add(decimal');
  const typeItem = (name: string, text: string, kind: vscode.SymbolKind) => new vscode.TypeHierarchyItem(kind, name, '', uri, range(text), range(text));
  const cart = typeItem('Cart', 'Cart :', vscode.SymbolKind.Class), priced = typeItem('IPriced', 'IPriced {', vscode.SymbolKind.Interface);
  const selector = { language: 'csharp' };
  const providers = [
    vscode.languages.registerReferenceProvider(selector, { provideReferences: (d, p) => every(d.getText(d.getWordRangeAtPosition(p))) }),
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: () => new vscode.Location(uri, range('total;')) }),
    vscode.languages.registerCallHierarchyProvider(selector, {
      prepareCallHierarchy: () => price,
      provideCallHierarchyIncomingCalls: (i) => (i.name === 'Price' ? [new vscode.CallHierarchyIncomingCall(pay, [range('Price();', code.indexOf('Pay'))])] : []),
      provideCallHierarchyOutgoingCalls: (i) => (i.name === 'Price' ? [new vscode.CallHierarchyOutgoingCall(add, [range('Add(1)')])] : []),
    }),
    vscode.languages.registerTypeHierarchyProvider(selector, {
      prepareTypeHierarchy: () => cart,
      provideTypeHierarchySupertypes: (t) => (t.name === 'Cart' ? [priced] : []),
      provideTypeHierarchySubtypes: () => [],
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: () => {
        const cls = new vscode.DocumentSymbol('Cart', '', vscode.SymbolKind.Class, new vscode.Range(2, 0, 6, 3), range('Cart :'));
        const method = (name: string, line: number) => new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Method, new vscode.Range(line, 0, line, 80), new vscode.Range(line, 4, line, 20));
        cls.children = [new vscode.DocumentSymbol('total', 'decimal', vscode.SymbolKind.Field, new vscode.Range(3, 0, 3, 30), range('total;')), method('Price', 4), method('Add', 5)];
        return [cls];
      },
    }),
  ];
  try {
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(at('total = 0'), at('total = 0'));
    const usages = await vscode.commands.executeCommand<Report>('tsStructure.semanticUsages');
    assert.ok(usages, 'C# usages report');
    assert.equal(usages.kind, 'usages');
    assert.deepEqual(usages.roots.map((r) => `${r.label} ${r.description?.split(' · ')[0]}`), ['Definitions 1', 'Writes 2', 'Reads 1']);
    const writes = usages.roots[1].children![0].children!.map((r) => `${r.label} | ${r.description}`);
    assert.deepEqual(writes, ['public decimal Price() { total = 0; Add(1); return total; } | Cart.Price · line 5 · at cursor', 'public void Add(decimal amount) { total += amount; } | Cart.Add · line 6']);

    editor.selection = new vscode.Selection(at('Price() {'), at('Price() {'));
    const calls = await vscode.commands.executeCommand<Report>('tsStructure.callGraph');
    assert.equal(calls?.kind, 'callGraph');
    assert.deepEqual(calls!.roots.map((r) => [r.label, r.children?.map((c) => c.label)]), [['Called by', ['Pay']], ['Calls', ['Add']]]);
    assert.equal(calls!.title, 'Call graph of Price');

    // The call graph opened as a chart, in front: back to the C# file.
    const again = await vscode.window.showTextDocument(document);
    again.selection = new vscode.Selection(at('Cart :'), at('Cart :'));
    const family = await vscode.commands.executeCommand<Report>('tsStructure.typeHierarchy');
    assert.equal(family?.kind, 'hierarchy');
    assert.deepEqual(family!.roots.map((r) => r.label), ['class Cart', 'Supertypes', 'Subtypes and implementations', 'Members']);
    assert.deepEqual(family!.roots[1].children!.map((c) => c.label), ['IPriced']);
    assert.deepEqual(family!.roots[3].children!.map((c) => c.label), ['total', 'Price', 'Add']);
    console.log('csharp ok');

    // The flowchart comes from the bundled C# parser, which needs no language server.
    providers.forEach((p) => p.dispose());
    const flowEditor = await vscode.window.showTextDocument(document);
    flowEditor.selection = new vscode.Selection(at('total = 0'), at('total = 0'));
    let chart: { name: string; nodes: { kind: string; lines: string[] }[]; paths: unknown[] } | undefined;
    // The chart is drawn in the background (the parser loads on first use): ask once, then read it once it is there.
    await vscode.commands.executeCommand('tsStructure.controlFlow');
    for (let i = 0; i < 40 && chart?.name !== 'Cart.Price'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      chart = (await vscode.commands.executeCommand<{ current?: typeof chart }>('tsStructure.controlFlow.current'))?.current;
    }
    assert.equal(chart?.name, 'Cart.Price', 'C# flowchart from the bundled parser');
    assert.deepEqual(chart!.nodes.map((n) => `${n.kind}: ${n.lines.join(' | ')}`), ['start: Cart.Price', 'end: end', 'statement: total = 0 | Add(1)', 'return: return total']);
    console.log('csharp flowchart ok');

    await csharpExplainAndDataFlow();

    // Live C# inspections, from the same parser.
    const bad = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'src', 'Bad.cs');
    await vscode.workspace.fs.writeFile(bad, Buffer.from('class Bad { void Run() { try { Go(); } catch { } } }'));
    try {
      await vscode.window.showTextDocument(bad);
      const found = await waitForDiagnostics(bad, (d) => d.source === 'X-Ray' && d.code === 'csharpEmptyCatch');
      assert.equal(found.length, 1, 'empty catch in C# is reported');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.workspace.fs.delete(bad);
    }
    console.log('csharp inspections ok');
  } finally {
    providers.forEach((p) => p.dispose());
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(uri);
  }
}

/** T-SQL: Find usages and Callers and calls across .sql files, the flowchart and live inspections, all from the T-SQL reader. */
async function tsql(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  const save = vscode.Uri.joinPath(root, 'db', 'SaveOrder.sql');
  const nightly = vscode.Uri.joinPath(root, 'db', 'Nightly.sql');
  const code = [
    'CREATE PROCEDURE dbo.SaveOrder @OrderId INT AS',
    'BEGIN',
    '  SET NOCOUNT ON',
    '  IF @OrderId IS NULL RETURN -1',
    '  UPDATE dbo.Orders SET Total = 0 WHERE Id = @OrderId',
    '  SELECT * FROM dbo.Orders',
    'END',
  ].join('\n');
  await vscode.workspace.fs.writeFile(save, Buffer.from(code));
  await vscode.workspace.fs.writeFile(nightly, Buffer.from('CREATE PROC dbo.Nightly AS EXEC dbo.SaveOrder 1'));
  try {
    let document = await vscode.workspace.openTextDocument(save);
    if (document.languageId !== 'sql') document = await vscode.languages.setTextDocumentLanguage(document, 'sql');
    const editor = await vscode.window.showTextDocument(document);
    const at = (text: string) => document.positionAt(code.indexOf(text) + 1);
    editor.selection = new vscode.Selection(at('Orders SET'), at('Orders SET'));
    const usages = await vscode.commands.executeCommand<Report>('tsStructure.semanticUsages');
    assert.equal(usages?.title, 'Usages of Orders');
    assert.deepEqual(usages!.roots.map((r) => r.label), ['Writes', 'Reads']);

    const again = await vscode.window.showTextDocument(document);
    again.selection = new vscode.Selection(at('SET NOCOUNT'), at('SET NOCOUNT'));
    const calls = await vscode.commands.executeCommand<Report>('tsStructure.callGraph');
    assert.deepEqual(calls?.roots.map((r) => [r.label, r.children?.map((c) => c.label)]), [['Called by', ['dbo.Nightly']], ['Calls', []]]);

    const flowEditor = await vscode.window.showTextDocument(document);
    flowEditor.selection = new vscode.Selection(at('SET NOCOUNT'), at('SET NOCOUNT'));
    await vscode.commands.executeCommand('tsStructure.controlFlow');
    let chart: { name: string; nodes: { kind: string }[] } | undefined;
    for (let i = 0; i < 40 && chart?.name !== 'dbo.SaveOrder'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      chart = (await vscode.commands.executeCommand<{ current?: typeof chart }>('tsStructure.controlFlow.current'))?.current;
    }
    assert.equal(chart?.name, 'dbo.SaveOrder', 'T-SQL flowchart');
    assert.deepEqual(chart!.nodes.map((n) => n.kind), ['start', 'end', 'statement', 'decision', 'return', 'statement']);

    await vscode.window.showTextDocument(document);
    const found = await waitForDiagnostics(save, (d) => d.source === 'X-Ray' && d.code === 'tsqlSelectStar');
    assert.equal(found.length, 1, 'SELECT * is reported live');
    console.log('tsql ok');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, 'db'), { recursive: true });
  }
}

/** A tab whose label matches, waited for: VS Code lists a new tab (and its title) a moment after it opens. */
async function tabLabelled(match: (label: string) => boolean, ms = 5000): Promise<vscode.Tab | undefined> {
  for (let waited = 0; ; waited += 100) {
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => match(t.label));
    if (tab || waited >= ms) return tab;
    await new Promise((r) => setTimeout(r, 100));
  }
}
