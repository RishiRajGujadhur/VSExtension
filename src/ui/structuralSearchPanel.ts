import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath } from '../analysis/paths';
import { Match, PlaceholderConstraint, Replacement, SearchScope, SearchSpec, bindingSummary, searchReport, compilePattern, structuralReplace, structuralSearch } from '../search/structuralSearch';
import { applyRefactor, reportError } from './applyRefactor';
import { languageSelector, previewEnabled } from './refactorCommands';
import { buttonCss, helpTip, icon } from './webviewStyle';
import { CustomInspectionConfig, includePattern, inspectionId } from '../search/customInspections';
import { Severity } from '../inspect/inspection';
import { StructureView } from './structureView';
import { isExcluded } from './exclude';
import { plural } from '../structure/report';
import { SearchPreset, searchTemplates } from '../search/templates';
import { registerCommand } from './features';
import { pathKey } from '../analysis/paths';
import { changedFiles, openSourceFiles } from './analysisScope';

export type Scope = 'project' | 'file' | 'selection' | 'folder' | 'open' | 'changed';

const historyKey = 'tsStructure.searchHistory';
const maxHistory = 15;

type Message =
  | { type: 'search'; spec: SearchSpec; scope: Scope }
  | { type: 'open'; index: number }
  | { type: 'validate'; spec: SearchSpec }
  | { type: 'copyKeybinding'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'replace'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'previewReplace'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'replaceOne'; index: number }
  | { type: 'openReplacement'; index: number }
  | { type: 'fromSelection' }
  | { type: 'pickFolder'; previous: Scope }
  | { type: 'saveInspection'; spec: SearchSpec; template: string; message: string; severity: Severity; include: string; editing?: string };

/** Structural Search Builder: a pattern editor with typed placeholder constraints and live results. */
export class StructuralSearchPanel {
  private static current: StructuralSearchPanel | undefined;
  private matches: Match[] = [];
  /** The last preview, so a single listed replacement can be applied. */
  private preview?: { spec: SearchSpec; template: string; replacements: Replacement[] };
  /** The file the search was opened from; scope "file" and project loading use it. */
  private anchor: string;
  /** The folder picked in the Explorer, for scope `folder`. */
  private folderRoot: string | undefined;

  static open(
    context: vscode.ExtensionContext,
    projects: ProjectService,
    view: StructureView,
    initial?: { pattern?: string; anchor?: string; inspection?: CustomInspectionConfig; preset?: SearchPreset & { run?: boolean; preview?: boolean }; folder?: string },
  ): StructuralSearchPanel {
    const anchor = initial?.anchor ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!anchor) {
      throw new Error('Open a TypeScript or JavaScript file first, so the search knows which project to use.');
    }
    if (StructuralSearchPanel.current) {
      StructuralSearchPanel.current.anchor = anchor;
      StructuralSearchPanel.current.folderRoot = initial?.folder ?? StructuralSearchPanel.current.folderRoot;
      StructuralSearchPanel.current.panel.reveal();
      if (initial?.pattern) {
        void StructuralSearchPanel.current.panel.webview.postMessage({ type: 'prefill', pattern: initial.pattern });
      }
      if (initial?.inspection) {
        void StructuralSearchPanel.current.panel.webview.postMessage({ type: 'load', inspection: initial.inspection });
      }
      if (initial?.preset) {
        void StructuralSearchPanel.current.panel.webview.postMessage({ type: 'preset', preset: initial.preset });
      }
      return StructuralSearchPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('tsStructure.structuralSearch', 'Search by shape', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    StructuralSearchPanel.current = new StructuralSearchPanel(context, panel, projects, view, anchor);
    StructuralSearchPanel.current.folderRoot = initial?.folder;
    // A preset is part of the page, since messages posted before its script runs are lost.
    panel.webview.html = html(panel.webview, initial?.pattern ?? '', initial?.preset);
    void StructuralSearchPanel.current.postHistory();
    if (initial?.inspection) {
      void panel.webview.postMessage({ type: 'load', inspection: initial.inspection });
    }
    return StructuralSearchPanel.current;
  }

  private constructor(
    readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    readonly projects: ProjectService,
    readonly view: StructureView,
    anchor: string,
  ) {
    this.anchor = anchor;
    panel.onDidDispose(() => (StructuralSearchPanel.current = undefined), undefined, context.subscriptions);
    panel.webview.onDidReceiveMessage((m: Message) => this.receive(m), undefined, context.subscriptions);
  }

  private history(): SearchPreset[] {
    return this.context.globalState.get<SearchPreset[]>(historyKey, []);
  }

  postHistory(): Thenable<boolean> {
    return this.panel.webview.postMessage({ type: 'history', items: this.history() });
  }

  /** Remembers a search that ran, most recent first and without duplicates. */
  private async remember(spec: SearchSpec, replacement?: string): Promise<void> {
    const entry: SearchPreset = { pattern: spec.pattern, constraints: spec.constraints?.length ? spec.constraints : undefined, replacement: replacement || undefined };
    const rest = this.history().filter((h) => h.pattern !== entry.pattern);
    await this.context.globalState.update(historyKey, [entry, ...rest].slice(0, maxHistory));
    await this.postHistory();
  }

  protected async scopeOf(scope: Scope): Promise<SearchScope> {
    if (scope === 'selection') {
      // The selection in the editor the builder was opened from, as it is now.
      const editor = vscode.window.visibleTextEditors.find((e) => normalizePath(e.document.uri.fsPath) === normalizePath(this.anchor));
      if (!editor || editor.selection.isEmpty) {
        throw new Error(`Select the code to search in ${vscode.workspace.asRelativePath(this.anchor)} first.`);
      }
      return { files: [this.anchor], range: { start: editor.document.offsetAt(editor.selection.start), end: editor.document.offsetAt(editor.selection.end) } };
    }
    if (scope === 'folder' && this.folderRoot) {
      const root = pathKey(this.folderRoot);
      return { isExcluded: (f) => isExcluded(f) || !pathKey(f).startsWith(`${root}/`) };
    }
    if (scope === 'open') {
      const files = openSourceFiles();
      if (files.length === 0) {
        throw new Error('No TypeScript or JavaScript files are open.');
      }
      return { files, isExcluded };
    }
    if (scope === 'changed') {
      const files = await changedFiles(this.anchor);
      if (!files) {
        throw new Error('Searching changed files needs Git, and this project is not in a Git repository.');
      }
      if (files.length === 0) {
        throw new Error('No files have changed since the last commit.');
      }
      return { files, isExcluded };
    }
    return scope === 'file' ? { files: [this.anchor] } : { isExcluded };
  }

  protected folder(): string | undefined {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.anchor))?.uri.fsPath;
  }

  protected async receive(message: Message): Promise<void> {
    if (message.type === 'pickFolder') {
      const start = this.folderRoot ?? this.folder();
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: start ? vscode.Uri.file(start) : undefined, openLabel: 'Search Here', title: 'Folder to search' });
      if (picked?.[0]) {
        this.folderRoot = picked[0].fsPath;
      }
      const preset = picked?.[0] ? { scope: 'folder', folderLabel: vscode.workspace.asRelativePath(picked[0]) } : { scope: message.previous };
      void this.panel.webview.postMessage({ type: 'preset', preset });
      return;
    }
    if (message.type === 'fromSelection') {
      // The editor the builder came from first, else any editor with code selected.
      const editors = [...vscode.window.visibleTextEditors].sort((a, b) => Number(pathKey(b.document.uri.fsPath) === pathKey(this.anchor)) - Number(pathKey(a.document.uri.fsPath) === pathKey(this.anchor)));
      const editor = editors.find((e) => !e.selection.isEmpty && vscode.languages.match(languageSelector, e.document) > 0);
      if (!editor) {
        void this.panel.webview.postMessage({ type: 'status', text: 'Select code in an editor first.' });
        return;
      }
      void this.panel.webview.postMessage({ type: 'prefill', pattern: editor.document.getText(editor.selection).trim() });
      return;
    }
    if (message.type === 'openReplacement') {
      const target = this.preview?.replacements[message.index];
      if (target) {
        const document = await vscode.workspace.openTextDocument(target.file);
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(document.positionAt(target.start), document.positionAt(target.end)) });
      }
      return;
    }
    if (message.type === 'open') {
      const match = this.matches[message.index];
      if (match) {
        const document = await vscode.workspace.openTextDocument(match.sourceFile.fileName);
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(document.positionAt(match.start), document.positionAt(match.end)),
        });
      }
      return;
    }
    if (message.type === 'copyKeybinding') {
      const spec = clean(message.spec);
      const args: SearchPreset & { run: boolean } = { pattern: spec.pattern, constraints: spec.constraints?.length ? spec.constraints : undefined, replacement: message.template.trim() || undefined, scope: message.scope, run: true };
      await vscode.env.clipboard.writeText(JSON.stringify({ key: '', command: 'tsStructure.structuralSearch', args }, null, 2));
      void this.panel.webview.postMessage({ type: 'status', text: 'Copied a keybinding for this search. Paste it into keybindings.json and fill in "key".' });
      return;
    }
    if (message.type === 'validate') {
      // Checked as the pattern is typed, so mistakes show before searching.
      let problem: string | undefined;
      try {
        if (message.spec.pattern.trim()) {
          compilePattern(clean(message.spec));
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      void this.panel.webview.postMessage({ type: 'validation', problem });
      return;
    }
    if (message.type === 'saveInspection') {
      try {
        const spec = clean(message.spec);
        compilePattern(spec);
        if (!message.message.trim()) {
          throw new Error('Enter the message to show on each match.');
        }
        const configs = customInspectionConfigs();
        // Opened from an existing inspection: save over it instead of adding a copy.
        const existing = message.editing ? configs.find((c) => c.id === message.editing) : undefined;
        const config: CustomInspectionConfig = {
          ...existing,
          id: existing?.id ?? inspectionId(message.message, configs.map((c) => c.id)),
          pattern: spec.pattern,
          constraints: spec.constraints?.length ? spec.constraints : undefined,
          message: message.message.trim(),
          severity: message.severity,
          replacement: message.template.trim() || undefined,
          include: message.include.trim() || undefined,
        };
        await saveCustomInspections(existing ? configs.map((c) => (c === existing ? config : c)) : [...configs, config]);
        // How much it will flag right away, so an overly broad pattern is noticed before it fills the Problems panel.
        const include = config.include ? includePattern(config.include) : undefined;
        const program = this.projects.analysisProject(this.anchor, this.folder()).program();
        const count = structuralSearch(program, spec, { isExcluded: (f) => isExcluded(f) || (!!include && !include.test(f.replace(/\\/g, '/'))) }).length;
        void this.panel.webview.postMessage({
          type: 'status',
          text: `${existing ? 'Updated' : 'Saved'} inspection '${config.id}'. It matches ${plural(count, 'place')} in the project now and runs on open files; Inspect Code… lists them all.`,
        });
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'replaceOne') {
      const target = this.preview?.replacements[message.index];
      if (!this.preview || !target) {
        return;
      }
      try {
        // The same replacement, limited to the one match's range.
        const project = this.projects.createVirtualProject(this.anchor, this.folder());
        const result = structuralReplace(project, this.preview.spec, this.preview.template, { files: [target.file], range: { start: target.start, end: target.end } });
        if (result.matches === 0) {
          void this.panel.webview.postMessage({ type: 'status', text: 'That match has changed since the preview; preview again.' });
          return;
        }
        await applyRefactor(result, previewEnabled());
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'previewReplace') {
      // Computed in a copy of the project, so nothing is written.
      try {
        const project = this.projects.createVirtualProject(this.anchor, this.folder());
        const result = structuralReplace(project, clean(message.spec), message.template, await this.scopeOf(message.scope));
        this.preview = { spec: clean(message.spec), template: message.template, replacements: result.replacements };
        void this.panel.webview.postMessage({
          type: 'preview',
          items: result.replacements.slice(0, 200).map((r) => ({
            where: `${vscode.workspace.asRelativePath(r.file)}:${r.line}`,
            before: r.before.replace(/\s+/g, ' ').slice(0, 120),
            after: r.after.replace(/\s+/g, ' ').slice(0, 120),
          })),
          count: result.matches,
          conflicts: result.conflicts.map((c) => c.message),
        });
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'replace') {
      try {
        const project = this.projects.createVirtualProject(this.anchor, this.folder());
        const result = structuralReplace(project, clean(message.spec), message.template, await this.scopeOf(message.scope));
        void this.remember(clean(message.spec), message.template);
        if (result.matches === 0) {
          void this.panel.webview.postMessage({ type: 'status', text: 'No matches to replace.' });
          return;
        }
        const files = result.changes.length;
        void this.panel.webview.postMessage({
          type: 'status',
          text: `Replacing ${plural(result.matches, 'match', 'matches')} in ${plural(files, 'file')}${result.conflicts.length ? `; ${plural(result.conflicts.length, 'new type error')}` : ', type-checks cleanly'}.`,
        });
        await applyRefactor(result, previewEnabled());
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'search') {
      try {
        const program = this.projects.analysisProject(this.anchor, this.folder()).program();
        this.matches = structuralSearch(program, clean(message.spec), await this.scopeOf(message.scope));
        // The count in the tab, so it shows while another editor is in front.
        const files = new Set(this.matches.map((m) => m.sourceFile.fileName)).size;
        this.panel.title = `Search by shape (${this.matches.length}${files > 1 ? ` in ${files} files` : ''})`;
        void this.remember(clean(message.spec));
        void this.panel.webview.postMessage({
          type: 'results',
          count: this.matches.length,
          items: this.matches.slice(0, 200).map((m, index) => ({
            index,
            text: m.sourceFile.text.slice(m.start, m.end).replace(/\s+/g, ' ').slice(0, 120),
            where: `${vscode.workspace.asRelativePath(m.sourceFile.fileName)}:${m.sourceFile.getLineAndCharacterOfPosition(m.start).line + 1}`,
            bindings: bindingSummary(m),
          })),
        });
        await this.view.show(searchReport(this.matches, message.spec, this.folder()), async () => {
          const again = this.projects.analysisProject(this.anchor, this.folder()).program();
          return searchReport(structuralSearch(again, clean(message.spec), await this.scopeOf(message.scope)), message.spec, this.folder());
        });
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/** Drops empty constraint fields the form sends. */
export function clean(spec: SearchSpec): SearchSpec {
  const constraints: PlaceholderConstraint[] = (spec.constraints ?? [])
    .map((c) => ({ name: c.name, type: c.type?.trim() || undefined, text: c.text?.trim() || undefined, negate: !!c.negate }))
    .filter((c) => c.type || c.text);
  return { pattern: spec.pattern, constraints };
}

export function customInspectionConfigs(): CustomInspectionConfig[] {
  return vscode.workspace.getConfiguration('tsStructure').get<CustomInspectionConfig[]>('customInspections', []);
}

async function saveCustomInspections(configs: CustomInspectionConfig[]): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('tsStructure').update('customInspections', configs, target);
}

/** Custom inspections in one list, with buttons to edit, enable or disable and delete each, and a way to add one. */
async function manageCustomInspections(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): Promise<void> {
  type Item = vscode.QuickPickItem & { config?: CustomInspectionConfig };
  const editButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit in Search by shape' };
  const deleteButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };
  const toggleButton = (config: CustomInspectionConfig) =>
    config.enabled === false ? { iconPath: new vscode.ThemeIcon('pass'), tooltip: 'Turn on' } : { iconPath: new vscode.ThemeIcon('circle-slash'), tooltip: 'Turn off' };
  const items = (): Item[] => [
    ...[...customInspectionConfigs()].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false) || a.id.localeCompare(b.id)).map((config) => ({
      label: `${config.enabled === false ? '$(circle-slash)' : '$(pass)'} ${config.id}`,
      description: config.pattern.replace(/\s+/g, ' '),
      detail: `${config.severity ?? 'warning'} · ${config.message}${config.replacement ? ' · has fix' : ''}${config.include ? ` · ${config.include}` : ''}`,
      buttons: [editButton, toggleButton(config), deleteButton],
      config,
    })),
    { label: '$(add) New check from a search by shape…', detail: 'Write a pattern, then Save as your own check: it warns as you type, with your message and fix' },
  ];
  const pick = vscode.window.createQuickPick<Item>();
  const count = customInspectionConfigs().length;
  pick.title = `Your own checks${count ? ` (${count})` : ''}`;
  pick.placeholder = count ? 'Enter edits the selected check; the buttons turn it on or off, or delete it' : 'No checks yet: start one from a search by shape';
  pick.items = items();
  pick.onDidTriggerItemButton(async ({ item, button }) => {
    const config = item.config!;
    if (button === editButton) {
      pick.hide();
      StructuralSearchPanel.open(context, projects, view, { inspection: config });
      return;
    }
    const configs = customInspectionConfigs();
    if (button === deleteButton) {
      // Deleting can't be undone from here: ask first.
      const sure = await vscode.window.showWarningMessage(`Delete your check '${config.id}'?`, { modal: true, detail: `${config.message}\nPattern: ${config.pattern}` }, 'Delete');
      if (sure !== 'Delete') return;
    }
    await saveCustomInspections(
      button === deleteButton ? configs.filter((c) => c.id !== config.id) : configs.map((c) => (c.id === config.id ? { ...c, enabled: c.enabled === false } : c)),
    );
    void vscode.window.setStatusBarMessage(button === deleteButton ? `Deleted your check '${config.id}'` : config.enabled === false ? `Turned on '${config.id}'` : `Turned off '${config.id}'`, 4000);
    pick.items = items();
  });
  pick.onDidAccept(() => {
    const config = pick.selectedItems[0]?.config;
    pick.hide();
    if (config) {
      StructuralSearchPanel.open(context, projects, view, { inspection: config });
    } else {
      void vscode.commands.executeCommand('tsStructure.structuralSearch');
    }
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

export function registerStructuralSearch(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  context.subscriptions.push(
    registerCommand('tsStructure.editCustomInspection', (id: string) => {
      const config = customInspectionConfigs().find((c) => c.id === id);
      if (config) {
        StructuralSearchPanel.open(context, projects, view, { inspection: config, anchor: vscode.window.activeTextEditor?.document.uri.fsPath });
      }
    }),
    registerCommand('tsStructure.disableCustomInspection', async (id: string) => {
      await saveCustomInspections(customInspectionConfigs().map((c) => (c.id === id ? { ...c, enabled: false } : c)));
      void vscode.window.setStatusBarMessage(`Turned off your check '${id}'. Your own checks… turns it back on.`, 5000);
    }),
    registerCommand('tsStructure.manageCustomInspections', async () => {
      try {
        await manageCustomInspections(context, projects, view);
      } catch (error) {
        reportError(error, 'Custom Inspections');
      }
    }),
    // Takes an optional saved search, so a keybinding can run one: { pattern, constraints, replacement, scope, run }.
    registerCommand('tsStructure.structuralSearchInFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        return;
      }
      const anchor = (await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'), '**/node_modules/**', 1))[0];
      if (!anchor) {
        void vscode.window.showInformationMessage('There are no TypeScript or JavaScript files there to search.');
        return;
      }
      try {
        StructuralSearchPanel.open(context, projects, view, {
          anchor: normalizePath(anchor.fsPath),
          folder: uri.fsPath,
          preset: { pattern: '', scope: 'folder', folderLabel: vscode.workspace.asRelativePath(uri) },
        });
      } catch (error) {
        reportError(error, 'Search by shape');
      }
    }),
    registerCommand('tsStructure.structuralSearch', (preset?: SearchPreset & { run?: boolean; preview?: boolean }) => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
      try {
        StructuralSearchPanel.open(context, projects, view, {
          pattern: preset?.pattern ? undefined : selected,
          anchor: editor ? normalizePath(editor.document.uri.fsPath) : undefined,
          preset: preset?.pattern ? preset : undefined,
        });
      } catch (error) {
        reportError(error, 'Search by shape');
      }
    }),
  );
}

function html(webview: vscode.Webview, pattern: string, preset?: SearchPreset & { run?: boolean; preview?: boolean }): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 16px; }
  h2 { font-size: 1.1em; margin: 18px 0 6px; font-weight: 600; }
  textarea, input, select { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; box-sizing: border-box; }
  textarea { width: 100%; min-height: 70px; resize: vertical; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 3px 6px 3px 0; font-weight: normal; }
  th { color: var(--vscode-descriptionForeground); }
  td input[type=text] { width: 100%; }
${buttonCss}
  .cheats { margin: 6px 0 10px; }
  .cheats summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .cheats ul { margin: 6px 0; padding-left: 18px; }
  .cheats li { margin: 3px 0; color: var(--vscode-descriptionForeground); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  li:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  [aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  button.link { display: inline; min-height: 0; padding: 0 2px; background: none; border: none; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); }
  button.link:hover { background: none; text-decoration: underline; }
  .hint { color: var(--vscode-descriptionForeground); margin: 4px 0; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  code { font-family: var(--vscode-editor-font-family); }
  .where, .bindings { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .before { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .after { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .tools { margin: 4px 0; }
  .tools button { padding: 2px 8px; font-size: 0.9em; }
  .where a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <h1 class="visually-hidden">Search by shape</h1>
  <div class="row">
    <select id="templates" aria-label="Start from an example"><option value="">Start from an example…</option></select>
    <select id="history" aria-label="Recent searches"><option value="">Recent searches…</option></select>
  </div>
  <h2 id="patternHeading">Pattern${helpTip('Code to find, matched by its syntax, so spacing, quotes and comments do not matter. $name$ stands for any expression or statement.')}</h2>
  <p class="hint" id="patternHint">Write code with <code>$name$</code> placeholders. <code>$name*$</code> matches any number of arguments, elements or statements; reusing a name requires the same code; <code>$_$</code> matches anything.</p>
  <textarea id="pattern" spellcheck="false" placeholder="$list$.forEach($callback$)" aria-labelledby="patternHeading" aria-describedby="patternHint patternProblem"></textarea>
  <details class="cheats"><summary>Syntax examples</summary>
    <ul>
      <li><button class="link" data-pattern="$obj$.$method$($args*$)">$obj$.$method$($args*$)</button> any method call with any arguments</li>
      <li><button class="link" data-pattern="if ($cond$) { $body*$ }">if ($cond$) { $body*$ }</button> an if with any statements</li>
      <li><button class="link" data-pattern="$x$ === $x$">$x$ === $x$</button> the same code on both sides</li>
      <li><button class="link" data-pattern="await $_$">await $_$</button> any awaited expression</li>
      <li><button class="link" data-pattern="&lt;$Tag$ $props*$ /&gt;">&lt;$Tag$ $props*$ /&gt;</button> any self-closing JSX element</li>
      <li><button class="link" data-pattern="console.log($args*$)">console.log($args*$)</button> every console.log left in the code</li>
      <li><button class="link" data-pattern="$a$ == null">$a$ == null</button> loose null checks</li>
      <li><button class="link" data-pattern="JSON.parse(JSON.stringify($x$))">JSON.parse(JSON.stringify($x$))</button> deep copies that structuredClone() could do</li>
    </ul>
  </details>
  <div class="row tools">
    <button id="makePlaceholder" title="Replace the text selected in the pattern, and every copy of it, with a placeholder (Alt+P)">${icon('add')}<span>Make placeholder</span></button>
    <button id="fromSelection" title="Use the code selected in the editor as the pattern">${icon('copy')}<span>From editor selection</span></button>
    <button id="clear" title="Empty the pattern, constraints, replacement and results">${icon('close')}<span>Clear</span></button>
  </div>
  <div id="patternProblem" class="error" aria-live="polite"></div>
  <h2>Placeholder constraints${helpTip('Optional regular expressions per placeholder. Type is tested against the TypeScript type of what it matched; Text against its source. Invert keeps matches that do not fit.')}</h2>
  <p class="hint">Regular expressions. <em>Type</em> is tested against the matched expression's type, such as <code>^Promise&lt;</code> or <code>string|number</code>.</p>
  <table id="constraints"><caption class="visually-hidden">Constraints for each placeholder</caption><thead><tr><th scope="col">Placeholder</th><th scope="col">Type</th><th scope="col">Text</th><th scope="col">Invert</th></tr></thead><tbody></tbody></table>
  <div class="row">
    <label>Scope <select id="scope"><option value="project">Whole project</option><option value="file">Current file</option><option value="selection">Selection in the editor</option><option value="open">Open editors</option><option value="changed">Changed files</option><option value="pickFolder">Choose folder…</option></select></label>
    <button id="search" class="primary" title="Ctrl+Enter in the pattern">${icon('search')}<span>Search</span></button>
    <span id="count" class="hint" role="status" aria-live="polite"></span>
    <button id="copyKeybinding" title="Copy this search as a keybindings.json entry that runs it">${icon('copy')}<span>Copy as keybinding</span></button>
  </div>
  <h2 id="templateHeading">Replace with${helpTip('Code that replaces each match, using the same placeholders. Leave it empty to only search.')}</h2>
  <p class="hint" id="templateHint">Optional. Use the same placeholders; <code>$name*$</code> inserts the whole matched list. The result is type-checked before anything is written, and changes open in the Refactor Preview.</p>
  <textarea id="template" spellcheck="false" placeholder="for (const item of $list$) $callback$(item)" aria-labelledby="templateHeading" aria-describedby="templateHint templateProblem"></textarea>
  <div id="templateProblem" class="error" aria-live="polite"></div>
  <div class="row">
    <button id="copyPattern" title="Start the replacement from the pattern, to edit only what changes">${icon('copy')}<span>Copy pattern</span></button>
    <button id="previewReplace" title="Show each match with its replacement, without changing any file">${icon('preview')}<span>Preview replacements</span></button>
    <button id="replace" title="Ctrl+Enter in the replacement">${icon('replace')}<span>Replace all…</span></button>
  </div>
  <h2>Save as inspection${helpTip('Keeps the pattern as your own inspection: matches are underlined in open files and listed in the Problems panel, with the replacement as a quick fix.')}</h2>
  <p class="hint">Runs the pattern on open files and reports each match in the Problems panel. The replacement above becomes its quick fix. <code>$name$</code> in the message is filled in from the match.</p>
  <div class="row">
    <input id="message" type="text" style="flex: 1; min-width: 200px" placeholder="Prefer for…of over $list$.forEach()" aria-label="Inspection message" aria-describedby="messageProblem">
    <input id="include" type="text" style="width: 160px" placeholder="all files, or src/**" title="Only inspect files whose path matches this glob, such as src/** or **/*.tsx" aria-label="Files to inspect, as a glob such as src/**">
    <select id="severity" aria-label="Severity"><option value="warning">Warning</option><option value="error">Error</option><option value="info">Information</option><option value="hint">Hint</option></select>
    <button id="saveInspection">${icon('save')}<span>Save as your own check</span></button>
  </div>
  <div class="row tools" id="messagePlaceholders"></div>
  <div id="messageProblem" class="error" aria-live="polite"></div>
  <div id="error" class="error" role="alert"></div>
  <h2 id="summary"></h2>
  <ul id="results" aria-labelledby="summary"></ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = vscode.getState() || { pattern: ${JSON.stringify(pattern)}, constraints: {}, scope: 'project' };
  if (${JSON.stringify(pattern)}) state.pattern = ${JSON.stringify(pattern)};
  $('pattern').value = state.pattern || '';
  $('template').value = state.template || '';
  $('scope').value = state.scope || 'project';
  // A folder from an earlier session is not in the list any more.
  if (!$('scope').value) $('scope').value = 'project';

  const templates = ${JSON.stringify(searchTemplates)};
  // Syntax examples fill the pattern box.
  document.querySelectorAll('.cheats button[data-pattern]').forEach((b) => b.addEventListener('click', () => {
    const box = document.getElementById('pattern');
    box.value = b.dataset.pattern;
    box.dispatchEvent(new Event('input'));
    box.focus();
  }));
  let recent = [];
  for (const [i, t] of templates.entries()) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = t.title;
    $('templates').appendChild(option);
  }
  function loadPreset(p) {
    $('pattern').value = p.pattern;
    $('template').value = p.replacement || '';
    if (p.message !== undefined) $('message').value = p.message;
    if (p.severity) $('severity').value = p.severity;
    $('include').value = p.include || '';
    state.constraints = {};
    for (const c of p.constraints || []) state.constraints[c.name] = c;
    save();
    renderConstraints();
    renderMessageTools();
  }
  // Starting from an example or a past search makes a new inspection, not an edit of the open one.
  function startNew() {
    state.editing = undefined;
    $('saveInspection').querySelector('span').textContent = 'Save as Inspection';
  }
  $('templates').addEventListener('change', () => {
    const t = templates[Number($('templates').value)];
    if (t) { startNew(); loadPreset(t); }
    $('templates').value = '';
  });
  $('history').addEventListener('change', () => {
    const h = recent[Number($('history').value)];
    if (h) { startNew(); loadPreset(h); }
    $('history').value = '';
  });
  function placeholders(text) {
    const names = [];
    for (const m of text.matchAll(/\\$([A-Za-z_]\\w*)(\\*?)\\$/g)) if (m[1] !== '_' && !names.includes(m[1])) names.push(m[1]);
    return names;
  }
  function renderConstraints() {
    const body = $('constraints').querySelector('tbody');
    body.innerHTML = '';
    for (const name of placeholders($('pattern').value)) {
      const c = state.constraints[name] || {};
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>$' + name + '$</code></td><td><input type="text" data-k="type"></td><td><input type="text" data-k="text"></td><td><input type="checkbox" data-k="negate"></td>';
      const labels = { type: 'Type pattern for $' + name + '$', text: 'Text pattern for $' + name + '$', negate: 'Invert the constraints of $' + name + '$' };
      for (const field of tr.querySelectorAll('input')) field.setAttribute('aria-label', labels[field.dataset.k]);
      for (const input of tr.querySelectorAll('input')) {
        const key = input.dataset.k;
        if (input.type === 'checkbox') input.checked = !!c[key]; else input.value = c[key] || '';
        input.addEventListener('input', () => {
          state.constraints[name] = { ...(state.constraints[name] || {}), [key]: input.type === 'checkbox' ? input.checked : input.value };
          save();
          validate();
        });
      }
      body.appendChild(tr);
    }
  }
  function save() {
    state.pattern = $('pattern').value;
    state.scope = $('scope').value;
    state.template = $('template').value;
    vscode.setState(state);
  }
  function spec() {
    const names = placeholders($('pattern').value);
    return { pattern: $('pattern').value, constraints: names.map((name) => ({ name, ...(state.constraints[name] || {}) })) };
  }
  let validateTimer;
  const validate = () => {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => vscode.postMessage({ type: 'validate', spec: spec() }), 300);
  };
  $('pattern').addEventListener('input', () => { save(); renderConstraints(); validate(); });
  // Ctrl+Enter (Cmd+Enter on macOS) runs the search from the pattern box, or the replacement from its box.
  const onSubmit = (id, button) => $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $(button).click();
    }
  });
  onSubmit('pattern', 'search');
  onSubmit('template', 'replace');
  // Choosing a folder happens in a dialog; the list shows the previous scope until a folder is picked.
  let lastScope = $('scope').value;
  $('scope').addEventListener('change', () => {
    if ($('scope').value === 'pickFolder') {
      $('scope').value = lastScope;
      vscode.postMessage({ type: 'pickFolder', previous: lastScope });
      return;
    }
    lastScope = $('scope').value;
    save();
  });
  // Placeholders in the replacement must come from the pattern; a typo would otherwise be inserted literally.
  function checkTemplate() {
    const known = placeholders($('pattern').value);
    const unknown = placeholders($('template').value).filter((name) => !known.includes(name));
    $('templateProblem').textContent = unknown.length ? 'Not in the pattern: ' + unknown.map((n) => '$' + n + '$').join(', ') : '';
  }
  $('template').addEventListener('input', () => { save(); checkTemplate(); });
  $('pattern').addEventListener('input', checkTemplate);
  // The message can quote what each placeholder matched: one click inserts it, and a name not in the pattern is flagged.
  function renderMessageTools() {
    const known = placeholders($('pattern').value);
    const tools = $('messagePlaceholders');
    tools.innerHTML = '';
    if (known.length) {
      const label = document.createElement('span');
      label.className = 'hint';
      label.textContent = 'Insert in the message:';
      tools.appendChild(label);
    }
    for (const name of known) {
      const chip = document.createElement('button');
      chip.className = 'secondary';
      chip.textContent = '$' + name + '$';
      chip.addEventListener('click', () => {
        const input = $('message');
        const at = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, at) + '$' + name + '$' + input.value.slice(input.selectionEnd ?? at);
        input.focus();
        input.selectionStart = input.selectionEnd = at + name.length + 2;
        checkMessage();
      });
      tools.appendChild(chip);
    }
    checkMessage();
  }
  function checkMessage() {
    const known = placeholders($('pattern').value);
    const unknown = placeholders($('message').value).filter((name) => !known.includes(name));
    $('messageProblem').textContent = unknown.length ? 'Not in the pattern: ' + unknown.map((n) => '$' + n + '$').join(', ') : '';
  }
  $('message').addEventListener('input', checkMessage);
  $('pattern').addEventListener('input', renderMessageTools);
  // Selected code in the pattern becomes $name$ (named after it when it is an identifier), everywhere it occurs.
  function makePlaceholder() {
    const box = $('pattern');
    const selected = box.value.slice(box.selectionStart, box.selectionEnd).trim();
    if (!selected) {
      $('patternProblem').textContent = 'Select the code in the pattern to turn into a placeholder.';
      return;
    }
    const used = placeholders(box.value);
    let name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(selected) ? selected : 'x';
    for (let i = 2; used.includes(name); i++) name = name.replace(/[0-9]*$/, '') + i;
    box.value = box.value.split(selected).join('$' + name + '$');
    box.focus();
    save(); renderConstraints(); renderMessageTools(); checkTemplate(); validate();
  }
  $('makePlaceholder').addEventListener('click', makePlaceholder);
  $('pattern').addEventListener('keydown', (event) => {
    if (event.altKey && event.code === 'KeyP') { event.preventDefault(); makePlaceholder(); }
  });
  $('fromSelection').addEventListener('click', () => vscode.postMessage({ type: 'fromSelection' }));
  $('clear').addEventListener('click', () => {
    startNew();
    $('pattern').value = '';
    $('template').value = '';
    $('message').value = '';
    $('include').value = '';
    state.constraints = {};
    $('results').innerHTML = '';
    $('summary').textContent = '';
    $('count').textContent = '';
    $('error').textContent = '';
    $('patternProblem').textContent = '';
    save(); renderConstraints(); renderMessageTools(); checkTemplate();
    $('pattern').focus();
  });
  $('copyPattern').addEventListener('click', () => {
    $('template').value = $('pattern').value;
    $('template').focus();
    save(); checkTemplate();
  });
  $('copyKeybinding').addEventListener('click', () => {
    vscode.postMessage({ type: 'copyKeybinding', spec: spec(), scope: $('scope').value, template: $('template').value });
  });
  $('saveInspection').addEventListener('click', () => {
    $('error').textContent = '';
    vscode.postMessage({ type: 'saveInspection', spec: spec(), template: $('template').value, message: $('message').value, severity: $('severity').value, include: $('include').value, editing: state.editing });
  });
  $('previewReplace').addEventListener('click', () => {
    $('error').textContent = '';
    $('summary').textContent = 'Computing replacements…';
    vscode.postMessage({ type: 'previewReplace', spec: spec(), scope: $('scope').value, template: $('template').value });
  });
  $('replace').addEventListener('click', () => {
    $('error').textContent = '';
    $('summary').textContent = 'Computing replacements…';
    vscode.postMessage({ type: 'replace', spec: spec(), scope: $('scope').value, template: $('template').value });
  });
  $('search').addEventListener('click', () => {
    $('error').textContent = '';
    $('count').textContent = 'Searching…';
    $('summary').textContent = 'Searching…';
    vscode.postMessage({ type: 'search', spec: spec(), scope: $('scope').value });
  });
  /** A result row that Tab reaches and Enter or Space opens, like a click. */
  function keyboardOpen(li, label) {
    li.tabIndex = 0;
    li.setAttribute('aria-label', label + '. Press Enter to open it.');
    li.addEventListener('keydown', (event) => {
      if (event.target === li && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        li.click();
      }
    });
  }
  const scrollBehavior = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'prefill') { $('pattern').value = message.pattern; save(); renderConstraints(); renderMessageTools(); checkTemplate(); validate(); }
    if (message.type === 'preset') applyPreset(message.preset);
    if (message.type === 'validation') $('patternProblem').textContent = message.problem || '';
    if (message.type === 'preview') {
      $('summary').textContent = message.count + (message.count === 1 ? ' replacement' : ' replacements') + (message.conflicts.length ? ', ' + message.conflicts.length + ' new type error' + (message.conflicts.length === 1 ? '' : 's') : ', type-checks cleanly');
      $('count').textContent = '';
      const list = $('results');
      list.innerHTML = '';
      for (const problem of message.conflicts) {
        const li = document.createElement('li');
        li.className = 'error';
        li.textContent = problem;
        list.appendChild(li);
      }
      for (const [index, item] of message.items.entries()) {
        const li = document.createElement('li');
        li.innerHTML = '<div><code class="before"></code></div><div><code class="after"></code></div><div class="where"><span></span> · <a href="#">Replace this one</a></div>';
        li.querySelector('.before').textContent = '− ' + item.before;
        li.querySelector('.after').textContent = '+ ' + item.after;
        li.querySelector('.where span').textContent = item.where;
        li.querySelector('a').addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          vscode.postMessage({ type: 'replaceOne', index });
        });
        // Clicking the match opens it, as in the search results.
        li.addEventListener('click', () => vscode.postMessage({ type: 'openReplacement', index }));
        keyboardOpen(li, 'Replace ' + item.before + ' with ' + item.after + ', at ' + item.where);
        list.appendChild(li);
      }
      $('summary').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
    if (message.type === 'load') {
      loadPreset({ ...message.inspection, message: message.inspection.message || '', severity: message.inspection.severity || 'warning' });
      state.editing = message.inspection.id;
      $('saveInspection').querySelector('span').textContent = 'Update Inspection';
      save();
    }
    if (message.type === 'history') {
      recent = message.items;
      const select = $('history');
      select.innerHTML = '<option value="">Recent searches…</option>';
      for (const [i, h] of recent.entries()) {
        const option = document.createElement('option');
        option.value = String(i);
        // Inside this template literal a regex escape needs a double backslash to reach the page.
        option.textContent = h.pattern.replace(/\\s+/g, ' ').slice(0, 80);
        select.appendChild(option);
      }
    }
    if (message.type === 'error') { $('summary').textContent = ''; $('count').textContent = ''; $('error').textContent = message.message; }
    if (message.type === 'results') {
      $('summary').textContent = message.count + (message.count === 1 ? ' match' : ' matches') + (message.count > message.items.length ? ' (first ' + message.items.length + ' shown)' : '');
      // The count by the button answers "did it match?" without scrolling; the list is brought into view.
      $('count').textContent = message.count === 0 ? 'No matches' : message.count === 1 ? '1 match' : message.count + ' matches';
      if (message.count > 0) $('summary').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      const list = $('results');
      list.innerHTML = '';
      for (const item of message.items) {
        const li = document.createElement('li');
        li.innerHTML = '<code></code><div class="where"></div><div class="bindings"></div>';
        li.querySelector('code').textContent = item.text;
        li.querySelector('.where').textContent = item.where;
        li.querySelector('.bindings').textContent = item.bindings;
        li.addEventListener('click', () => vscode.postMessage({ type: 'open', index: item.index }));
        keyboardOpen(li, item.text + ', at ' + item.where + (item.bindings ? ', ' + item.bindings : ''));
        list.appendChild(li);
      }
    }
    if (message.type && message.type.startsWith('status')) { $('error').textContent = ''; $('summary').textContent = message.text; }
  });
  renderConstraints();
  renderMessageTools();
  function applyPreset(p) {
    if (p.folderLabel) {
      // A folder picked in the Explorer becomes a scope of its own.
      let option = document.querySelector('#scope option[value="folder"]');
      if (!option) {
        option = document.createElement('option');
        option.value = 'folder';
        $('scope').appendChild(option);
      }
      option.textContent = 'Folder ' + p.folderLabel;
    }
    if (p.pattern) loadPreset(p);
    if (p.scope) { $('scope').value = p.scope; lastScope = $('scope').value; save(); }
    if (p.preview) $('previewReplace').click();
    else if (p.run) $('search').click();
  }
  const initialPreset = ${JSON.stringify(preset ?? null).replace(/</g, '\\u003c')};
  if (initialPreset) applyPreset(initialPreset);
</script>
</body>
</html>`;
}
