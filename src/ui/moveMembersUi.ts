import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath, pathKey } from '../analysis/paths';
import { listMovableMembers, moveMembers } from '../refactor/moveMembers';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';

const recentTargetsKey = 'tsStructure.moveMembers.recentTargets';

export async function runMoveMembers(projects: ProjectService, editor: vscode.TextEditor, memento?: vscode.Memento): Promise<void> {
  const document = editor.document;
  const source = normalizePath(document.uri.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const version = document.version;
  try {
    const members = listMovableMembers(projects.createVirtualProject(source, root), source);
    if (members.length === 0) {
      void vscode.window.showInformationMessage(`${path.basename(source)} has no top-level declarations to move.`);
      return;
    }
    // Every declaration the selection touches is ticked, or the one at the cursor.
    const { start, end } = editor.selection;
    const selected = editor.selection.isEmpty ? [] : members.filter((m) => m.endLine >= start.line && m.line <= end.line);
    const atCursor = selected.length ? selected : [...members].reverse().filter((m) => m.line <= start.line).slice(0, 1);
    const picked = await vscode.window.showQuickPick(
      members.map((m) => ({ label: m.name, description: `${m.kind}${m.exported ? '' : ' · not exported'}`, picked: atCursor.includes(m), member: m })),
      { title: `Move members of ${path.basename(source)}`, placeHolder: 'Select the declarations to move', canPickMany: true },
    );
    if (!picked || picked.length === 0) {
      return;
    }

    const target = await pickTarget(projects, source, root, memento?.get<string[]>(recentTargetsKey) ?? []);
    if (!target) {
      return;
    }
    void memento?.update(recentTargetsKey, [target, ...(memento.get<string[]>(recentTargetsKey) ?? []).filter((t) => pathKey(t) !== pathKey(target))].slice(0, 5));

    let keepReExport = false;
    if (picked.some((p) => p.member.exported)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Update imports to the new module', description: 'importers and re-exports point at the new module', keep: false },
          { label: `Also keep a re-export in ${path.basename(source)}`, description: "the source module's public API stays the same", keep: true },
        ],
        { title: `Move to ${vscode.workspace.asRelativePath(target)}` },
      );
      if (!choice) {
        return;
      }
      keepReExport = choice.keep;
    }

    if (document.version !== version) {
      void vscode.window.showWarningMessage('The file changed. Run Move again.');
      return;
    }
    const result = moveMembers(projects.createVirtualProject(source, root), source, picked.map((p) => p.member.name), target, { keepReExport });
    await applyRefactor(result, previewEnabled());
  } catch (error) {
    reportError(error, 'Move Members');
  }
}

/** Project modules ordered by folder distance from the source, plus options for a new or browsed file. */
async function pickTarget(projects: ProjectService, source: string, root: string | undefined, recent: readonly string[]): Promise<string | undefined> {
  const files = projectSourceFiles(projects.load(source, root).program)
    .map((sf) => normalizePath(sf.fileName))
    .filter((f) => pathKey(f) !== pathKey(source));
  const distance = (file: string) => path.posix.relative(path.posix.dirname(source), path.posix.dirname(file)).split('/').filter(Boolean).length;
  files.sort((a, b) => distance(a) - distance(b) || a.localeCompare(b));

  type Item = vscode.QuickPickItem & { file?: string; action?: 'new' | 'browse' };
  const item = (file: string): Item => ({ label: path.basename(file), description: vscode.workspace.asRelativePath(path.dirname(file)), file });
  // Modules moved to recently come first: moving several things to one place is usually done in a row.
  const keys = new Set(files.map(pathKey));
  const recentFiles = recent.filter((f) => keys.has(pathKey(f)));
  const recentKeys = new Set(recentFiles.map(pathKey));
  const items: Item[] = [
    ...(recentFiles.length ? [{ label: 'Recently used', kind: vscode.QuickPickItemKind.Separator }, ...recentFiles.map(item), { label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
    { label: '$(new-file) New module…', action: 'new' },
    { label: '$(folder-opened) Browse…', action: 'browse' },
    { label: 'Project modules', kind: vscode.QuickPickItemKind.Separator },
    ...files.filter((f) => !recentKeys.has(pathKey(f))).map(item),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Move to module', placeHolder: 'Type to search for the target module', matchOnDescription: true });
  if (!picked) {
    return undefined;
  }
  if (picked.file) {
    return picked.file;
  }
  if (picked.action === 'browse') {
    const uris = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(path.dirname(source)),
      canSelectMany: false,
      filters: { 'TypeScript / JavaScript': ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] },
    });
    return uris?.[0] ? normalizePath(uris[0].fsPath) : undefined;
  }
  const extension = path.extname(source);
  const name = await vscode.window.showInputBox({
    title: 'New module',
    prompt: `Path relative to ${vscode.workspace.asRelativePath(path.dirname(source))}`,
    value: `newModule${extension}`,
    valueSelection: [0, 'newModule'.length],
    validateInput: (value) => (/\.[cm]?[jt]sx?$/i.test(value.trim()) ? undefined : 'Use a .ts, .tsx, .js or .jsx file name.'),
  });
  return name ? normalizePath(path.resolve(path.dirname(source), name.trim())) : undefined;
}
