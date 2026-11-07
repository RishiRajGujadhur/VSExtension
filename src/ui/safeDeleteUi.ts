import * as vscode from 'vscode';
import { analyzeImpact } from '../analysis/impact';
import { ProjectService } from '../analysis/project';
import { SafeDeletePlan, planFileDelete, planSafeDelete } from '../refactor/safeDelete';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';

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
    reportError(error, 'Safe Delete');
  }
}

export async function safeDeleteFile(projects: ProjectService, uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    void vscode.window.showErrorMessage('Select a TypeScript or JavaScript file to delete.');
    return;
  }
  const root = vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath;
  try {
    const plan = planFileDelete(projects.createVirtualProject(target.fsPath, root), target.fsPath);
    await confirmAndApply(plan, impactedTestCount(projects, target.fsPath, 0, 'module', root));
  } catch (error) {
    reportError(error, 'Safe Delete');
  }
}

async function confirmAndApply(plan: SafeDeletePlan, tests: number, showUsages?: () => Promise<void>): Promise<void> {
  const blocking = plan.usages.filter((u) => !u.removable);
  const removable = plan.usages.length - blocking.length;
  const what = plan.kind === 'file' ? plan.name : `${plan.kind} '${plan.name}'`;
  const testNote = tests > 0 ? `${tests} test${tests === 1 ? '' : 's'} depend on it (see Test Impact Analysis).` : '';

  // Nothing uses it, nothing else changes and nothing outside can see it: delete without asking, if the setting allows.
  if (blocking.length === 0 && removable === 0 && !plan.exported && tests === 0 && !vscode.workspace.getConfiguration('tsStructure').get('safeDelete.confirmUnused', true)) {
    if (await applyRefactor(plan.result, previewEnabled())) {
      deleted(what);
    }
    return;
  }
  if (blocking.length === 0) {
    const details = [
      removable > 0 ? `${removable} import${removable === 1 ? '' : 's'} or re-export${removable === 1 ? '' : 's'} of it will also be removed.` : 'No usages were found.',
      testNote,
      plan.exported ? 'It is exported, so code outside this project could still use it.' : '',
    ].filter(Boolean);
    // Preview is offered even with tsStructure.previewRefactorings off, for a one-off look at the edits.
    const preview = previewEnabled();
    const choice = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail: details.join('\n') }, 'Delete', ...(preview ? [] : ['Preview…']));
    if (choice) {
      if (await applyRefactor(plan.result, preview || choice === 'Preview…')) {
        deleted(what);
      }
    }
    return;
  }

  type Item = vscode.QuickPickItem & { action?: 'delete' | 'cancel' | 'usages' | 'copy'; usage?: SafeDeletePlan['usages'][number] };
  const items: Item[] = [
    { label: '$(trash) Delete Anyway', description: 'The usages listed below will no longer compile', action: 'delete' },
    ...(showUsages ? [{ label: '$(references) Show Usages in Results View', description: 'Keep the list open while you remove them', action: 'usages' as const }] : []),
    { label: '$(copy) Copy Usage Locations', description: 'file:line of each, for a ticket or a note', action: 'copy' },
    { label: '$(close) Cancel', action: 'cancel' },
    { label: `Usages that block deletion (${blocking.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...blocking.map((usage) => usageItem(usage)),
  ];
  if (removable > 0) {
    items.push({ label: `Removed together with it (${removable})`, kind: vscode.QuickPickItemKind.Separator });
    items.push(...plan.usages.filter((u) => u.removable).map((usage) => usageItem(usage)));
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `${what} is used in ${blocking.length} place${blocking.length === 1 ? '' : 's'}${testNote ? ` · ${testNote}` : ''}`,
    placeHolder: 'Select a usage to open it, or choose Delete Anyway',
    matchOnDescription: true,
  });
  if (picked?.action === 'delete') {
    if (await applyRefactor(plan.result, previewEnabled())) {
      deleted(what);
    }
  } else if (picked?.action === 'copy') {
    await vscode.env.clipboard.writeText(blocking.map((u) => `${vscode.workspace.asRelativePath(u.location.file)}:${u.location.line + 1}  ${u.lineText}`).join('\n'));
    void vscode.window.setStatusBarMessage(`Copied ${blocking.length} usage location${blocking.length === 1 ? '' : 's'}`, 3000);
  } else if (picked?.action === 'usages') {
    await showUsages?.();
  } else if (picked?.usage) {
    const position = new vscode.Position(picked.usage.location.line, picked.usage.location.character);
    await vscode.window.showTextDocument(vscode.Uri.file(picked.usage.location.file), { selection: new vscode.Range(position, position) });
  }

  function usageItem(usage: SafeDeletePlan['usages'][number]): Item {
    return {
      label: `$(${usage.removable ? 'check' : 'warning'}) ${usage.lineText}`,
      description: `${vscode.workspace.asRelativePath(usage.location.file)}:${usage.location.line + 1}`,
      usage,
    };
  }
}

/** How many tests reach the target, as context for the decision; failures here never block deleting. */
function impactedTestCount(projects: ProjectService, fileName: string, offset: number, scope: 'symbol' | 'module', root: string | undefined): number {
  try {
    return analyzeImpact(projects.load(fileName, root), { fileName, offset, scope }).tests.length;
  } catch {
    return 0;
  }
}

/** Says what went, and how to bring it back. */
function deleted(what: string): void {
  void vscode.window.setStatusBarMessage(`$(trash) Deleted ${what}. ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Z in each file undoes it.`, 6000);
}
