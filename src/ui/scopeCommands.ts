import * as path from 'path';
import * as vscode from 'vscode';
import { isExcluded } from './exclude';
import { registerCommand } from './features';

type ScopeKey = 'include' | 'exclude';

/** Writes next to the folder: in a multi-root workspace each folder keeps its own scope. */
async function updateScope(folder: vscode.WorkspaceFolder, key: ScopeKey, globs: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure', folder.uri);
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  await config.update(key, globs.length ? globs : undefined, multiRoot ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
}

function scopeOf(folder: vscode.WorkspaceFolder, key: ScopeKey): string[] {
  return vscode.workspace.getConfiguration('tsStructure', folder.uri).get<string[]>(key, []);
}

/** Explorer: "Exclude from TypeScript Structure Analysis" on files and folders, several at once. */
async function excludeFromAnalysis(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const uris = selected?.length ? selected : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
  const added: string[] = [];
  for (const target of uris) {
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (!folder || target.scheme !== 'file') {
      continue;
    }
    const relative = path.relative(folder.uri.fsPath, target.fsPath).replace(/\\/g, '/');
    if (!relative) {
      void vscode.window.showWarningMessage('Can’t exclude a whole workspace folder. Turn off features instead.');
      continue;
    }
    const exclude = scopeOf(folder, 'exclude');
    if (exclude.includes(relative)) {
      continue;
    }
    // A file that is already out of scope (by a glob, or by `include`) needs no new entry.
    if ((await vscode.workspace.fs.stat(target)).type === vscode.FileType.File && isExcluded(target.fsPath)) {
      continue;
    }
    await updateScope(folder, 'exclude', [...exclude, relative]);
    added.push(relative);
  }
  if (added.length > 0) {
    const choice = await vscode.window.showInformationMessage(`Excluded ${added.map((a) => `'${a}'`).join(', ')} from TypeScript Structure analysis.`, 'Undo', 'Edit Scope…');
    if (choice === 'Undo') {
      for (const target of uris) {
        const folder = vscode.workspace.getWorkspaceFolder(target);
        if (folder) {
          await updateScope(folder, 'exclude', scopeOf(folder, 'exclude').filter((g) => !added.includes(g)));
        }
      }
    } else if (choice) {
      await editAnalysisScope();
    }
  } else if (uris.length > 0) {
    void vscode.window.setStatusBarMessage('Already excluded from TypeScript Structure analysis', 3000);
  }
}

/** Lists the include and exclude patterns of a folder; picking one removes it, and new ones can be added. */
async function editAnalysisScope(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
  const folder = folders.length > 1 ? (active ?? (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Edit the analysis scope of which folder?' }))) : folders[0];
  if (!folder) {
    void vscode.window.showInformationMessage('Open a folder to set which files TypeScript Structure analyzes.');
    return;
  }
  type Item = vscode.QuickPickItem & { key?: ScopeKey; glob?: string; add?: ScopeKey };
  for (;;) {
    const include = scopeOf(folder, 'include');
    const exclude = scopeOf(folder, 'exclude');
    const items: Item[] = [
      { label: '$(add) Exclude Files…', detail: 'A glob such as **/generated/** or a folder such as src/legacy', add: 'exclude' },
      { label: '$(add) Only Analyze…', detail: 'Limit analysis to a glob or folder, such as src', add: 'include' },
      { label: include.length ? 'Only these files are analyzed' : 'Every file in the project is analyzed', kind: vscode.QuickPickItemKind.Separator },
      ...include.map((glob) => ({ label: `$(pass) ${glob}`, description: 'Select to remove', key: 'include' as const, glob })),
      { label: exclude.length ? 'Except these' : 'Nothing is excluded', kind: vscode.QuickPickItemKind.Separator },
      ...exclude.map((glob) => ({ label: `$(circle-slash) ${glob}`, description: 'Select to remove', key: 'exclude' as const, glob })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: `Analysis Scope: ${folder.name}`, placeHolder: 'Add a pattern, or select one to remove it' });
    if (!picked) {
      return;
    }
    if (picked.add) {
      const glob = await vscode.window.showInputBox({
        title: picked.add === 'exclude' ? 'Exclude Files' : 'Only Analyze',
        prompt: 'A glob relative to the workspace folder, or a folder path',
        placeHolder: picked.add === 'exclude' ? '**/generated/**' : 'src',
        validateInput: (value) => (value.trim() ? undefined : 'Enter a glob or a folder'),
      });
      if (glob?.trim()) {
        const list = picked.add === 'exclude' ? exclude : include;
        await updateScope(folder, picked.add, [...new Set([...list, glob.trim()])]);
      }
    } else if (picked.key && picked.glob) {
      const list = picked.key === 'exclude' ? exclude : include;
      await updateScope(folder, picked.key, list.filter((g) => g !== picked.glob));
    }
  }
}

export function registerScopeCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(registerCommand('tsStructure.excludeFromAnalysis', excludeFromAnalysis), registerCommand('tsStructure.editAnalysisScope', editAnalysisScope));
}
