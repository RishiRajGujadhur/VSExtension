import * as vscode from 'vscode';
import { remedies, showProblem } from './problems';
import { analyzeImpact } from '../analysis/impact';
import { ProjectService } from '../analysis/project';
import { SafeDeletePlan, planFileDelete, planSafeDelete } from '../refactor/safeDelete';
import { applyRefactor, reportError } from './applyRefactor';
import { PreviewToggle } from './refactorCommands';
import { Flow, finished, flowTitle, showHelp } from './editFlow';

export async function safeDeleteSymbol(projects: ProjectService, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const offset = document.offsetAt(editor.selection.active);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  try {
    const plan = planSafeDelete(projects.createVirtualProject(document.uri.fsPath, root), document.uri.fsPath, offset);
    const tests = plan.kind === 'parameter' ? 0 : impactedTestCount(projects, document.uri.fsPath, offset, 'symbol', root);
    // The usages stay in the results view after the question closes, to fix them one by one.
    const showUsages = async () => {
      const position = document.positionAt(offset);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
      await vscode.commands.executeCommand('tsStructure.semanticUsages');
    };
    await confirmAndApply(plan, tests, showUsages);
  } catch (error) {
    reportError(error, 'Delete safely');
  }
}

export async function safeDeleteFile(projects: ProjectService, uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    void showProblem('Select a TypeScript or JavaScript file to delete.', [remedies.openFile]);
    return;
  }
  const root = vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath;
  try {
    const plan = planFileDelete(projects.createVirtualProject(target.fsPath, root), target.fsPath);
    await confirmAndApply(plan, impactedTestCount(projects, target.fsPath, 0, 'module', root));
  } catch (error) {
    reportError(error, 'Delete safely');
  }
}

const command = 'tsStructure.safeDelete';
const isTest = (file: string) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/](__tests__|tests?)[\\/]/.test(file);

/**
 * One list, in the Edit features' shared look, whatever the case: the choices first (Delete, Show usages, Copy…),
 * then what blocks the delete and what goes with it, grouped by file. Moving through a usage shows it in the editor
 * without leaving the list; Enter on one opens it and keeps the list open.
 */
async function confirmAndApply(plan: SafeDeletePlan, tests: number, showUsages?: () => Promise<void>): Promise<void> {
  const blocking = plan.usages.filter((u) => !u.removable);
  const removableUsages = plan.usages.filter((u) => u.removable);
  const what = plan.kind === 'file' ? plan.name : `${plan.kind} '${plan.name}'`;
  const here = plan.usages[0]?.location.file;
  const order = (a: Usage, b: Usage) => Number(a.location.file !== here) - Number(b.location.file !== here) || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line;
  blocking.sort(order);
  removableUsages.sort(order);
  const files = new Set(blocking.map((u) => u.location.file)).size;
  const onlyTests = blocking.length > 0 && blocking.every((u) => isTest(u.location.file));
  const preview = new PreviewToggle('The delete', false);

  // Nothing uses it, nothing else changes and nothing outside can see it: delete without asking, if the setting allows.
  if (blocking.length === 0 && removableUsages.length === 0 && !plan.exported && tests === 0 && !vscode.workspace.getConfiguration('tsStructure').get('safeDelete.confirmUnused', true)) {
    if (await applyRefactor(plan.result, preview.on)) done();
    return;
  }

  type Item = vscode.QuickPickItem & { action?: 'delete' | 'cancel' | 'usages' | 'copy' | 'tests'; usage?: Usage };
  const openBeside: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the side' };
  const usageItem = (usage: Usage): Item => ({
    label: `$(${usage.removable ? 'check' : 'warning'}) ${usage.lineText.trim()}`,
    description: `line ${usage.location.line + 1}${isTest(usage.location.file) ? ' · test' : ''}`,
    buttons: [openBeside],
    usage,
  });
  // Usages under a heading per file, with how many are in it.
  const byFile = (usages: Usage[], heading: string): Item[] => {
    const out: Item[] = [{ label: heading, kind: vscode.QuickPickItemKind.Separator }];
    const groups = new Map<string, Usage[]>();
    for (const u of usages) groups.set(u.location.file, [...(groups.get(u.location.file) ?? []), u]);
    for (const [file, list] of groups) {
      if (groups.size > 1) out.push({ label: `${vscode.workspace.asRelativePath(file)} (${list.length})`, kind: vscode.QuickPickItemKind.Separator });
      out.push(...list.map(usageItem));
    }
    return out;
  };
  const notes = [
    removableUsages.length ? `${removableUsages.length} import${removableUsages.length === 1 ? '' : 's'} or re-export${removableUsages.length === 1 ? '' : 's'} go with it` : '',
    tests ? `${tests} test${tests === 1 ? '' : 's'} depend on it` : '',
    plan.exported ? 'exported: code outside this project could still use it' : '',
  ].filter(Boolean);
  const items: Item[] = [
    blocking.length
      ? { label: '$(trash) Delete anyway', description: onlyTests ? 'only tests use it: update or delete them too' : 'the usages below will no longer compile', detail: 'Use this when you will fix the usages next; Undo brings it back.', action: 'delete' }
      : { label: '$(trash) Delete', description: notes.length ? notes.join(' · ') : 'nothing uses it', detail: 'Undo brings it back.', action: 'delete' },
    ...(blocking.length && showUsages ? [{ label: '$(references) Show usages in the Results view', description: 'keep the list open while you remove them', detail: 'Then run Delete safely again once nothing uses it.', action: 'usages' as const }] : []),
    ...(onlyTests ? [{ label: '$(beaker) Open the first test that uses it', action: 'tests' as const }] : []),
    ...(blocking.length ? [{ label: '$(copy) Copy usage locations', description: 'file:line and the code of each, for a ticket or a note', action: 'copy' as const }] : []),
    { label: '$(close) Cancel', action: 'cancel' },
    ...(blocking.length ? byFile(blocking, `Usages that block the delete (${blocking.length})`) : []),
    ...(removableUsages.length ? byFile(removableUsages, `Removed together with it (${removableUsages.length})`) : []),
  ];

  const picker = vscode.window.createQuickPick<Item>();
  const flow: Flow = { command, subject: plan.name, steps: 1 };
  picker.title = flowTitle(flow, 1, blocking.length ? `used in ${blocking.length} place${blocking.length === 1 ? '' : 's'}${files > 1 ? ` in ${files} files` : ''}` : 'not used');
  picker.placeholder = blocking.length ? 'Move through the usages to see each in the editor; Enter opens one, or choose Delete anyway' : `Delete ${what}? ${notes.join(' · ') || 'Nothing uses it.'}`;
  picker.items = items;
  picker.matchOnDescription = true;
  picker.ignoreFocusOut = true;
  const helpButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('question'), tooltip: 'What this does' };
  picker.buttons = [preview.button, helpButton];
  const show = (usage: Usage, options: vscode.TextDocumentShowOptions) => {
    const position = new vscode.Position(usage.location.line, usage.location.character);
    return vscode.window.showTextDocument(vscode.Uri.file(usage.location.file), { selection: new vscode.Range(position, position), ...options });
  };
  const chosen = await new Promise<Item | undefined>((resolve) => {
    picker.onDidChangeActive((active) => {
      // A peek at each usage as you move through them, without leaving the list.
      if (active[0]?.usage) void show(active[0].usage, { preview: true, preserveFocus: true });
    });
    picker.onDidTriggerItemButton((e) => e.item.usage && void show(e.item.usage, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }));
    picker.onDidTriggerButton((button) => {
      if (button === helpButton) void showHelp(command);
      else preview.pressed(button, picker);
    });
    picker.onDidAccept(() => {
      const item = picker.activeItems[0];
      // Opening a usage keeps the list, to look at the next one.
      if (item?.usage) void show(item.usage, { preview: false, preserveFocus: true });
      else resolve(item);
    });
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (chosen?.action === 'delete') {
    if (await applyRefactor(plan.result, preview.on)) done();
  } else if (chosen?.action === 'copy') {
    await vscode.env.clipboard.writeText(blocking.map((u) => `${vscode.workspace.asRelativePath(u.location.file)}:${u.location.line + 1}  ${u.lineText.trim()}`).join('\n'));
    void vscode.window.setStatusBarMessage(`Copied ${blocking.length} usage location${blocking.length === 1 ? '' : 's'}`, 3000);
  } else if (chosen?.action === 'usages') {
    await showUsages?.();
  } else if (chosen?.action === 'tests') {
    await show(blocking[0], { preview: false });
  }

  function done(): void {
    const changed = new Set(plan.result.changes.map((c) => c.file)).size;
    void finished(command, `deleted ${what}${removableUsages.length ? ` and ${removableUsages.length} import${removableUsages.length === 1 ? '' : 's'} of it` : ''}.`, { file: here ?? plan.result.changes[0]?.file, changed, undo: plan.kind !== 'file' });
  }
}

type Usage = SafeDeletePlan['usages'][number];

/** How many tests reach the target, as context for the decision; failures here never block deleting. */
function impactedTestCount(projects: ProjectService, fileName: string, offset: number, scope: 'symbol' | 'module', root: string | undefined): number {
  try {
    return analyzeImpact(projects.load(fileName, root), { fileName, offset, scope }).tests.length;
  } catch {
    return 0;
  }
}
