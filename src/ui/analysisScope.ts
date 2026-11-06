import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { isSourceFileName, pathKey } from '../analysis/paths';
import { ScopeSpec } from '../structure/scope';

/** Where an analysis looks, from the whole project down to the selection. */
export type ScopeKind = 'project' | 'folder' | 'pickFolder' | 'open' | 'changed' | 'file' | 'function' | 'selection';

export interface ChosenScope {
  kind: ScopeKind;
  /** Such as `src/cart` or `checkout()`, for report titles; absent for the whole project. */
  label?: string;
  spec: ScopeSpec;
}

const isScopeKind = (value: unknown): value is ScopeKind =>
  typeof value === 'string' && ['project', 'folder', 'pickFolder', 'open', 'changed', 'file', 'function', 'selection'].includes(value);

let memento: vscode.Memento | undefined;

/** Remembers the last scope of each analysis in the workspace, offered first the next time. */
export function rememberScopesIn(state: vscode.Memento): void {
  memento = state;
}

export interface ScopeRequest {
  /** Key for the remembered choice, such as `inspectCode`. */
  id: string;
  title: string;
  /** The scopes this analysis supports, in the order shown. */
  kinds: readonly ScopeKind[];
  editor?: vscode.TextEditor;
  /** Ask even when `tsStructure.askForScope` is off, for commands whose whole point is the scope. */
  alwaysAsk?: boolean;
  /** Labels in place of the default ones, such as "Copies of the Selection". */
  labels?: Partial<Record<ScopeKind, { label: string; description?: string }>>;
}

/**
 * Asks where to analyze, offering the scopes that make sense for the editor's state with the last
 * choice first. `arg` (a scope kind passed to the command) skips the question, and so does
 * turning off `tsStructure.askForScope`, which then analyzes the whole project.
 */
export async function chooseScope(request: ScopeRequest, arg?: unknown): Promise<ChosenScope | undefined> {
  if (isScopeKind(arg)) {
    return resolveScope(arg, request.editor);
  }
  if (!request.alwaysAsk && !vscode.workspace.getConfiguration('tsStructure').get('askForScope', true) && request.kinds.includes('project')) {
    return resolveScope('project', request.editor);
  }
  const last = memento?.get<ScopeKind>(`tsStructure.scope.${request.id}`);
  const items = scopeItems(request).map((item) => (item.scope === last ? { ...item, description: [item.description, 'last used'].filter(Boolean).join(' · ') } : item));
  if (items.length === 0) {
    return undefined;
  }
  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = request.title;
  picker.placeholder = 'Where to analyze';
  picker.items = items;
  picker.activeItems = items.filter((i) => i.scope === last).slice(0, 1);
  // Stop asking: analyses use the whole project from now on (tsStructure.askForScope).
  const stopAsking: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pinned'), tooltip: 'Always Analyze the Whole Project (stop asking)' };
  if (!request.alwaysAsk && request.kinds.includes('project')) {
    picker.buttons = [stopAsking];
  }
  const picked = await new Promise<(typeof items)[number] | undefined>((resolve) => {
    picker.onDidTriggerButton(() => {
      void vscode.workspace.getConfiguration('tsStructure').update('askForScope', false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('Analyses now use the whole project. Turn tsStructure.askForScope back on to choose again.');
      resolve(items.find((i) => i.scope === 'project'));
    });
    picker.onDidAccept(() => resolve(picker.selectedItems[0] ?? picker.activeItems[0]));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (!picked) {
    return undefined;
  }
  void memento?.update(`tsStructure.scope.${request.id}`, picked.scope);
  return resolveScope(picked.scope, request.editor);
}

function scopeItems(request: ScopeRequest): (vscode.QuickPickItem & { scope: ScopeKind })[] {
  const editor = request.editor;
  const file = editor?.document.uri.fsPath;
  const fn = editor ? enclosingFunction(editor) : undefined;
  const openCount = openSourceFiles().length;
  const defaults: Record<ScopeKind, { label: string; description?: string } | undefined> = {
    project: { label: '$(project) Whole Project', description: 'Every source file in the compiler project' },
    folder: file ? { label: '$(folder) Current Folder', description: folderLabel(path.dirname(file)) } : undefined,
    pickFolder: { label: '$(folder-opened) Choose Folders…' },
    open: openCount ? { label: '$(files) Open Editors', description: `${openCount} file${openCount === 1 ? '' : 's'}` } : undefined,
    changed: { label: '$(git-compare) Changed Files', description: 'Changed or added since the last commit' },
    file: file ? { label: '$(file-code) Current File', description: path.basename(file) } : undefined,
    function: fn ? { label: '$(symbol-function) Current Function', description: fn.name } : undefined,
    selection: editor && !editor.selection.isEmpty ? { label: '$(selection) Selection', description: lineLabel(editor.selection.start.line, editor.selection.end.line) } : undefined,
  };
  return request.kinds.flatMap((kind) => {
    const item = defaults[kind] && { ...defaults[kind], ...request.labels?.[kind] };
    return item ? [{ ...item, scope: kind }] : [];
  });
}

/** Turns a scope kind into the files or lines it covers; undefined when there is nothing to analyze. */
export async function resolveScope(kind: ScopeKind, editor?: vscode.TextEditor): Promise<ChosenScope | undefined> {
  const file = editor?.document.uri.fsPath;
  switch (kind) {
    case 'project':
      return { kind, spec: {} };
    case 'folder': {
      if (!file) {
        return undefined;
      }
      const folder = path.dirname(file);
      return { kind, label: folderLabel(folder), spec: { folders: [folder] } };
    }
    case 'pickFolder': {
      const start = file ? vscode.Uri.file(path.dirname(file)) : vscode.workspace.workspaceFolders?.[0]?.uri;
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: true, defaultUri: start, openLabel: 'Analyze', title: 'Folders to analyze' });
      if (!picked?.length) {
        return undefined;
      }
      return { kind, label: picked.map((u) => folderLabel(u.fsPath)).join(', '), spec: { folders: picked.map((u) => u.fsPath) } };
    }
    case 'open': {
      const files = openSourceFiles();
      if (files.length === 0) {
        void vscode.window.showInformationMessage('No TypeScript or JavaScript files are open.');
        return undefined;
      }
      return { kind, label: 'open editors', spec: { files } };
    }
    case 'changed': {
      const anchor = file ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const changed = anchor ? await changedFiles(anchor) : undefined;
      if (!changed) {
        void vscode.window.showErrorMessage('Changed files need a Git repository.');
        return undefined;
      }
      if (changed.length === 0) {
        void vscode.window.showInformationMessage('No files have changed since the last commit.');
        return undefined;
      }
      return { kind, label: 'changed files', spec: { files: changed } };
    }
    case 'file':
      return file ? { kind, label: path.basename(file), spec: { files: [file] } } : undefined;
    case 'function': {
      const fn = editor && enclosingFunction(editor);
      if (!editor || !fn) {
        void vscode.window.showInformationMessage('Place the cursor inside a function first.');
        return undefined;
      }
      return { kind, label: fn.name, spec: { lines: { file: editor.document.uri.fsPath, start: fn.start, end: fn.end } } };
    }
    case 'selection': {
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select the code to analyze first.');
        return undefined;
      }
      const { start, end } = editor.selection;
      // A selection ending at the start of a line does not include that line.
      const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
      return { kind, label: `${path.basename(editor.document.uri.fsPath)} ${lineLabel(start.line, last)}`, spec: { lines: { file: editor.document.uri.fsPath, start: start.line, end: last } } };
    }
  }
}

/** A folder relative to its workspace folder, such as `src/cart`; the workspace folder itself by its name. */
function folderLabel(folder: string): string {
  const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder));
  if (workspace && pathKey(workspace.uri.fsPath) === pathKey(folder)) {
    return workspace.name;
  }
  const relative = vscode.workspace.asRelativePath(vscode.Uri.file(folder), false);
  return path.isAbsolute(relative) ? path.basename(folder) : relative;
}

function lineLabel(start: number, end: number): string {
  return start === end ? `line ${start + 1}` : `lines ${start + 1}–${end + 1}`;
}

/** Source files open in editor tabs, including ones in the background. */
export function openSourceFiles(): string[] {
  const files = new Map<string, string>();
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
    if (uri?.scheme === 'file' && isSourceFileName(uri.fsPath)) {
      files.set(pathKey(uri.fsPath), uri.fsPath);
    }
  }
  return [...files.values()];
}

/** The innermost function around the cursor: its name and zero-based first and last lines. */
function enclosingFunction(editor: vscode.TextEditor): { name: string; start: number; end: number } | undefined {
  const document = editor.document;
  if (!isSourceFileName(document.uri.fsPath)) {
    return undefined;
  }
  const sourceFile = ts.createSourceFile(document.uri.fsPath, document.getText(), ts.ScriptTarget.Latest, true);
  const offset = document.offsetAt(editor.selection.active);
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(sourceFile) || offset > node.end) {
      return;
    }
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      found = node as ts.FunctionLikeDeclaration;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    return undefined;
  }
  return {
    name: `${functionName(found)}()`,
    start: sourceFile.getLineAndCharacterOfPosition(found.getStart(sourceFile)).line,
    end: sourceFile.getLineAndCharacterOfPosition(found.end).line,
  };
}

function functionName(fn: ts.FunctionLikeDeclaration): string {
  if (fn.name && !ts.isComputedPropertyName(fn.name)) {
    return fn.name.getText();
  }
  if (ts.isConstructorDeclaration(fn)) {
    return 'constructor';
  }
  // `const total = () => …` and `{ total: function () {…} }` take the name they are assigned to.
  const parent = fn.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && !ts.isComputedPropertyName(parent.name)) {
    return parent.name.getText();
  }
  return 'function';
}

/** Files changed, staged or added since the last commit in the file's Git repository; undefined outside Git. */
export async function changedFiles(fileName: string): Promise<string[] | undefined> {
  const cwd = isDirectory(fileName) ? fileName : path.dirname(fileName);
  // Run without blocking the extension host, which a large repository would otherwise do for a while.
  const git = (...args: string[]) =>
    new Promise<string>((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  try {
    const top = (await git('rev-parse', '--show-toplevel')).trim();
    // A repository without commits yet has nothing to diff against; then every file is new.
    const tracked = await git('diff', '--name-only', 'HEAD').catch(() => git('ls-files'));
    const untracked = await git('ls-files', '--others', '--exclude-standard');
    const files = new Map<string, string>();
    for (const relative of `${tracked}\n${untracked}`.split('\n').filter(Boolean)) {
      const absolute = path.join(top, relative);
      files.set(pathKey(absolute), absolute);
    }
    return [...files.values()];
  } catch {
    return undefined;
  }
}

function isDirectory(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}
