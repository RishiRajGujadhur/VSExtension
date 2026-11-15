import * as fs from 'fs';
import * as path from 'path';
import { BACK, Flow, StepResult, finished, inputStep, pickStep } from './editFlow';
import { remedies, showProblem } from './problems';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath, pathKey } from '../analysis/paths';
import { listMovableMembers, moveMembers } from '../refactor/moveMembers';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';

const recentTargetsKey = 'tsStructure.moveMembers.recentTargets';

const command = 'tsStructure.moveMembers';

/**
 * Move to another file: tick the declarations, pick the file, and (for exported ones) whether the old module keeps
 * a re-export. Each step has Back, help, and stays open while you look at the code.
 */
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
    type Member = (typeof members)[number];
    type MemberItem = vscode.QuickPickItem & { member?: Member };
    const memberItem = (m: Member): MemberItem => {
      const size = m.endLine - m.line + 1;
      return { label: `$(${kindIcon(m.kind)}) ${m.name}`, description: `${m.kind} · line ${m.line + 1}${size > 1 ? `–${m.endLine + 1} (${size} lines)` : ''}${atCursor.includes(m) ? ' · at cursor' : ''}`, picked: atCursor.includes(m), member: m };
    };
    // Exported declarations, then the module's own, each in line order.
    const exportedItems = members.filter((m) => m.exported).map(memberItem);
    const localItems = members.filter((m) => !m.exported).map(memberItem);
    const both = exportedItems.length > 0 && localItems.length > 0;
    const memberItems: MemberItem[] = [
      ...(both ? [{ label: 'Exported', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...exportedItems,
      ...(both ? [{ label: 'Only used in this file', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...localItems,
    ];
    const allExported: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('export'), tooltip: 'Tick every exported declaration' };
    const noneButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Untick all' };

    const flow: Flow = { command, subject: path.basename(source), steps: 3 };
    let step = 1;
    let picked: MemberItem[] = memberItems.filter((i) => i.member && atCursor.includes(i.member));
    let target = '';
    let keepReExport = memento?.get<boolean>('tsStructure.moveMembers.keepReExport', false) ?? false;
    let preview = previewEnabled();
    while (step <= 3) {
      if (step === 1) {
        const result = await pickStep(flow, 1, memberItems, {
          what: 'what to move',
          many: true,
          active: picked,
          placeholder: 'Tick the declarations to move (the box at the top ticks all; the buttons tick the exported ones or none)',
          buttons: [allExported, noneButton],
          onButton: (button, picker) => {
            picker.selectedItems = button === allExported ? picker.items.filter((i) => i.member?.exported) : [];
          },
        });
        if (result === undefined) return;
        if (result === BACK) continue;
        const ticked = result.filter((r) => r.member);
        if (!ticked.length) {
          void vscode.window.setStatusBarMessage('Tick at least one declaration to move', 3000);
          continue;
        }
        picked = ticked;
        step = 2;
      } else if (step === 2) {
        const chosen = await pickTarget(projects, source, root, memento?.get<string[]>(recentTargetsKey) ?? [], picked[0].member!.name, flow);
        if (chosen === undefined) return;
        if (chosen === BACK) { step = 1; continue; }
        target = chosen;
        void memento?.update(recentTargetsKey, [target, ...(memento.get<string[]>(recentTargetsKey) ?? []).filter((t) => pathKey(t) !== pathKey(target))].slice(0, 5));
        step = picked.some((p) => p.member!.exported) ? 3 : 4;
      } else {
        const lastKeep = memento?.get<boolean>('tsStructure.moveMembers.keepReExport');
        const previewLook = (): vscode.QuickInputButton => ({ iconPath: new vscode.ThemeIcon(preview ? 'eye' : 'eye-closed'), tooltip: preview ? 'Changes open in the Refactor Preview first (click to apply straight away)' : 'Changes apply straight away (click to preview them first)' });
        let previewButton = previewLook();
        const choices = [
          { label: '$(references) Update imports to the new module', description: `importers and re-exports point at the new module${lastKeep === false ? ' · last used' : ''}`, detail: 'Cleanest result; code outside this project that imports from the old module would break.', keep: false },
          { label: `$(export) Also keep a re-export in ${path.basename(source)}`, description: `the source module's public API stays the same${lastKeep === true ? ' · last used' : ''}`, detail: 'Safest for published libraries: the old import path keeps working.', keep: true },
        ];
        const result = await pickStep(flow, 3, choices, {
          what: `to ${path.basename(target)}`,
          active: choices.find((c) => c.keep === keepReExport),
          placeholder: 'What happens to imports of the old module? Enter repeats your last choice.',
          buttons: [previewButton],
          onButton: (button, picker) => {
            if (button !== previewButton) return;
            preview = !preview;
            const old = previewButton;
            previewButton = previewLook();
            picker.buttons = picker.buttons.map((x) => (x === old ? previewButton : x));
          },
        });
        if (result === undefined) return;
        if (result === BACK) { step = 2; continue; }
        keepReExport = result[0].keep;
        void memento?.update('tsStructure.moveMembers.keepReExport', keepReExport);
        step = 4;
      }
    }

    if (document.version !== version) {
      void showProblem('The file changed while Move to another file was open.', [remedies.runAgain(command)], 'warning');
      return;
    }
    const names = picked.map((p) => p.member!.name);
    const result = moveMembers(projects.createVirtualProject(source, root), source, names, target, { keepReExport });
    if (await applyRefactor(result, preview)) {
      const what = names.length <= 3 ? names.join(', ') : `${names.length} declarations`;
      void finished(command, `moved ${what} to ${path.basename(target)}${result.changes.length > 2 ? `; imports updated in ${result.changes.length - 2} other file${result.changes.length === 3 ? '' : 's'}` : ''}.`, {
        file: source,
        changed: result.changes.length,
        extra: { label: `Open ${path.basename(target)}`, run: () => vscode.window.showTextDocument(vscode.Uri.file(target)) },
      });
    }
  } catch (error) {
    reportError(error, 'Move to another file');
  }
}

/** The icon of a kind of declaration in the member list. */
function kindIcon(kind: string): string {
  return /function/.test(kind) ? 'symbol-function' : /class/.test(kind) ? 'symbol-class' : /interface/.test(kind) ? 'symbol-interface' : /type/.test(kind) ? 'symbol-type-parameter' : /enum/.test(kind) ? 'symbol-enum' : 'symbol-variable';
}

/** Project modules ordered by folder distance from the source, plus options for a new or browsed file. */
async function pickTarget(projects: ProjectService, source: string, root: string | undefined, recent: readonly string[], firstName: string, flow: Flow): Promise<StepResult<string>> {
  const files = projectSourceFiles(projects.load(source, root).program)
    .map((sf) => normalizePath(sf.fileName))
    .filter((f) => pathKey(f) !== pathKey(source));
  const distance = (file: string) => path.posix.relative(path.posix.dirname(source), path.posix.dirname(file)).split('/').filter(Boolean).length;
  // Test files last: code rarely moves into a test.
  const isTest = (file: string) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/](__tests__|tests?)[\\/]/.test(file);
  files.sort((a, b) => Number(isTest(a)) - Number(isTest(b)) || distance(a) - distance(b) || a.localeCompare(b));

  type Item = vscode.QuickPickItem & { file?: string; action?: 'new' | 'browse' };
  const item = (file: string): Item => ({ label: path.basename(file), description: [vscode.workspace.asRelativePath(path.dirname(file)), distance(file) === 0 ? 'same folder' : '', isTest(file) ? 'test' : ''].filter(Boolean).join(' · '), file });
  // Modules moved to recently come first: moving several things to one place is usually done in a row.
  const keys = new Set(files.map(pathKey));
  const recentFiles = recent.filter((f) => keys.has(pathKey(f)));
  const recentKeys = new Set(recentFiles.map(pathKey));
  const items: Item[] = [
    ...(recentFiles.length ? [{ label: 'Recently used', kind: vscode.QuickPickItemKind.Separator }, ...recentFiles.map((f, i) => ({ ...item(f), description: `${item(f).description}${i === 0 ? ' · last used' : ''}` })), { label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
    { label: '$(new-file) New module…', action: 'new' },
    { label: '$(folder-opened) Browse…', action: 'browse' },
    { label: 'Project modules', kind: vscode.QuickPickItemKind.Separator },
    ...files.filter((f) => !recentKeys.has(pathKey(f))).map(item),
  ];
  const result = await pickStep(flow, 2, items, { what: 'which file', placeholder: 'Type to search by name or folder; files in the same folder come first', active: items.find((i) => i.file) });
  if (result === BACK || result === undefined) return result;
  const picked = result[0];
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
  // A name without an extension gets the source's; an existing file is fine (the code is added to it), and said so.
  const withExtension = (value: string) => (/\.[cm]?[jt]sx?$/i.test(value.trim()) ? value.trim() : value.trim() ? `${value.trim()}${extension}` : '');
  const name = await inputStep(flow, 2, {
    what: 'new file',
    prompt: `Path relative to ${vscode.workspace.asRelativePath(path.dirname(source))}; the extension is added when left out`,
    // Named after the first declaration moved, which is usually what the new file is about.
    value: `${firstName}${extension}`,
    valueSelection: [0, firstName.length],
    normalize: withExtension,
    validate: (value) => (!value || /[<>:"|?*]/.test(value) ? 'Enter a file name such as utils.ts.' : undefined),
  });
  if (name === BACK || name === undefined) return name;
  const file = normalizePath(path.resolve(path.dirname(source), name));
  if (fs.existsSync(file)) void vscode.window.setStatusBarMessage(`${path.basename(file)} already exists: the declarations are added to it`, 4000);
  return file;
}
