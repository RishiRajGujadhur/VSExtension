import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath } from '../analysis/paths';
import { Match, PlaceholderConstraint, SearchScope, SearchSpec, bindingSummary, searchReport, compilePattern, structuralReplace, structuralSearch } from '../search/structuralSearch';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';
import { CustomInspectionConfig, inspectionId } from '../search/customInspections';
import { Severity } from '../inspect/inspection';
import { StructureView } from './structureView';
import { isExcluded } from './exclude';
import { plural } from '../structure/report';
import { SearchPreset, searchTemplates } from '../search/templates';

export type Scope = 'project' | 'file' | 'selection';

const historyKey = 'tsStructure.searchHistory';
const maxHistory = 15;

type Message =
  | { type: 'search'; spec: SearchSpec; scope: Scope }
  | { type: 'open'; index: number }
  | { type: 'validate'; spec: SearchSpec }
  | { type: 'copyKeybinding'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'replace'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'previewReplace'; spec: SearchSpec; scope: Scope; template: string }
  | { type: 'saveInspection'; spec: SearchSpec; template: string; message: string; severity: Severity };

/** Structural Search Builder: a pattern editor with typed placeholder constraints and live results. */
export class StructuralSearchPanel {
  private static current: StructuralSearchPanel | undefined;
  private matches: Match[] = [];
  /** The file the search was opened from; scope "file" and project loading use it. */
  private anchor: string;

  static open(
    context: vscode.ExtensionContext,
    projects: ProjectService,
    view: StructureView,
    initial?: { pattern?: string; anchor?: string; inspection?: CustomInspectionConfig; preset?: SearchPreset & { run?: boolean; preview?: boolean } },
  ): StructuralSearchPanel {
    const anchor = initial?.anchor ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!anchor) {
      throw new Error('Open a TypeScript or JavaScript file first, so the search knows which project to use.');
    }
    if (StructuralSearchPanel.current) {
      StructuralSearchPanel.current.anchor = anchor;
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
    const panel = vscode.window.createWebviewPanel('tsStructure.structuralSearch', 'Structural Search', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    StructuralSearchPanel.current = new StructuralSearchPanel(context, panel, projects, view, anchor);
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

  protected scopeOf(scope: Scope): SearchScope {
    if (scope === 'selection') {
      // The selection in the editor the builder was opened from, as it is now.
      const editor = vscode.window.visibleTextEditors.find((e) => normalizePath(e.document.uri.fsPath) === normalizePath(this.anchor));
      if (!editor || editor.selection.isEmpty) {
        throw new Error(`Select the code to search in ${vscode.workspace.asRelativePath(this.anchor)} first.`);
      }
      return { files: [this.anchor], range: { start: editor.document.offsetAt(editor.selection.start), end: editor.document.offsetAt(editor.selection.end) } };
    }
    return scope === 'file' ? { files: [this.anchor] } : { isExcluded };
  }

  protected folder(): string | undefined {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.anchor))?.uri.fsPath;
  }

  protected async receive(message: Message): Promise<void> {
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
        const config: CustomInspectionConfig = {
          id: inspectionId(message.message, configs.map((c) => c.id)),
          pattern: spec.pattern,
          constraints: spec.constraints?.length ? spec.constraints : undefined,
          message: message.message.trim(),
          severity: message.severity,
          replacement: message.template.trim() || undefined,
        };
        await saveCustomInspections([...configs, config]);
        void this.panel.webview.postMessage({ type: 'status', text: `Saved inspection '${config.id}'. It now runs on open files.` });
      } catch (error) {
        void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'previewReplace') {
      // Computed in a copy of the project, so nothing is written.
      try {
        const project = this.projects.createVirtualProject(this.anchor, this.folder());
        const result = structuralReplace(project, clean(message.spec), message.template, this.scopeOf(message.scope));
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
        const result = structuralReplace(project, clean(message.spec), message.template, this.scopeOf(message.scope));
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
        const program = this.projects.createVirtualProject(this.anchor, this.folder()).program();
        this.matches = structuralSearch(program, clean(message.spec), this.scopeOf(message.scope));
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
          const again = this.projects.createVirtualProject(this.anchor, this.folder()).program();
          return searchReport(structuralSearch(again, clean(message.spec), this.scopeOf(message.scope)), message.spec, this.folder());
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

async function manageCustomInspections(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): Promise<void> {
  const configs = customInspectionConfigs();
  if (configs.length === 0) {
    const choice = await vscode.window.showInformationMessage('No custom inspections yet. Build one from a structural search pattern.', 'Open Structural Search');
    if (choice) {
      await vscode.commands.executeCommand('tsStructure.structuralSearch');
    }
    return;
  }
  const picked = await vscode.window.showQuickPick(
    configs.map((config) => ({
      label: `${config.enabled === false ? '$(circle-slash)' : '$(pass)'} ${config.id}`,
      description: config.pattern.replace(/\s+/g, ' '),
      detail: `${config.severity ?? 'warning'} · ${config.message}${config.replacement ? ' · has fix' : ''}`,
      config,
    })),
    { title: 'Custom Inspections', placeHolder: 'Select an inspection to edit, enable, disable or delete' },
  );
  if (!picked) {
    return;
  }
  const toggle = picked.config.enabled === false ? 'Enable' : 'Disable';
  const action = await vscode.window.showQuickPick(['Edit in Structural Search', toggle, 'Delete'], { title: picked.config.id });
  if (action === 'Edit in Structural Search') {
    StructuralSearchPanel.open(context, projects, view, { inspection: picked.config });
  } else if (action === 'Delete') {
    await saveCustomInspections(configs.filter((c) => c !== picked.config));
  } else if (action) {
    await saveCustomInspections(configs.map((c) => (c === picked.config ? { ...c, enabled: c.enabled === false } : c)));
  }
}

export function registerStructuralSearch(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tsStructure.manageCustomInspections', async () => {
      try {
        await manageCustomInspections(context, projects, view);
      } catch (error) {
        reportError(error, 'Custom Inspections');
      }
    }),
    // Takes an optional saved search, so a keybinding can run one: { pattern, constraints, replacement, scope, run }.
    vscode.commands.registerCommand('tsStructure.structuralSearch', (preset?: SearchPreset & { run?: boolean; preview?: boolean }) => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
      try {
        StructuralSearchPanel.open(context, projects, view, {
          pattern: preset?.pattern ? undefined : selected,
          anchor: editor ? normalizePath(editor.document.uri.fsPath) : undefined,
          preset: preset?.pattern ? preset : undefined,
        });
      } catch (error) {
        reportError(error, 'Structural Search');
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
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; cursor: pointer; margin-right: 6px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
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
</style>
</head>
<body>
  <div class="row">
    <select id="templates"><option value="">Start from an example…</option></select>
    <select id="history"><option value="">Recent searches…</option></select>
  </div>
  <h2>Pattern</h2>
  <p class="hint">Write code with <code>$name$</code> placeholders. <code>$name*$</code> matches any number of arguments, elements or statements; reusing a name requires the same code; <code>$_$</code> matches anything.</p>
  <textarea id="pattern" spellcheck="false" placeholder="$list$.forEach($callback$)"></textarea>
  <div id="patternProblem" class="error"></div>
  <h2>Placeholder constraints</h2>
  <p class="hint">Regular expressions. <em>Type</em> is tested against the matched expression's type, such as <code>^Promise&lt;</code> or <code>string|number</code>.</p>
  <table id="constraints"><thead><tr><th>Placeholder</th><th>Type</th><th>Text</th><th>Invert</th></tr></thead><tbody></tbody></table>
  <div class="row">
    <label>Scope <select id="scope"><option value="project">Whole project</option><option value="file">Current file</option><option value="selection">Selection in the editor</option></select></label>
    <button id="search" title="Ctrl+Enter in the pattern">Search</button>
    <span id="count" class="hint"></span>
    <button id="copyKeybinding" class="secondary" title="Copy this search as a keybindings.json entry that runs it">Copy as Keybinding</button>
  </div>
  <h2>Replace with</h2>
  <p class="hint">Optional. Use the same placeholders; <code>$name*$</code> inserts the whole matched list. The result is type-checked before anything is written, and changes open in the Refactor Preview.</p>
  <textarea id="template" spellcheck="false" placeholder="for (const item of $list$) $callback$(item)"></textarea>
  <div class="row">
    <button id="previewReplace" class="secondary" title="Show each match with its replacement, without changing any file">Preview Replacements</button>
    <button id="replace" class="secondary" title="Ctrl+Enter in the replacement">Replace All…</button>
  </div>
  <h2>Save as inspection</h2>
  <p class="hint">Runs the pattern on open files and reports each match in the Problems panel. The replacement above becomes its quick fix. <code>$name$</code> in the message is filled in from the match.</p>
  <div class="row">
    <input id="message" type="text" style="flex: 1; min-width: 200px" placeholder="Prefer for…of over $list$.forEach()">
    <select id="severity"><option value="warning">Warning</option><option value="error">Error</option><option value="info">Information</option><option value="hint">Hint</option></select>
    <button id="saveInspection" class="secondary">Save as Inspection</button>
  </div>
  <div id="error" class="error"></div>
  <h2 id="summary"></h2>
  <ul id="results"></ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = vscode.getState() || { pattern: ${JSON.stringify(pattern)}, constraints: {}, scope: 'project' };
  if (${JSON.stringify(pattern)}) state.pattern = ${JSON.stringify(pattern)};
  $('pattern').value = state.pattern || '';
  $('template').value = state.template || '';
  $('scope').value = state.scope || 'project';

  const templates = ${JSON.stringify(searchTemplates)};
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
    state.constraints = {};
    for (const c of p.constraints || []) state.constraints[c.name] = c;
    save();
    renderConstraints();
  }
  $('templates').addEventListener('change', () => {
    const t = templates[Number($('templates').value)];
    if (t) loadPreset(t);
    $('templates').value = '';
  });
  $('history').addEventListener('change', () => {
    const h = recent[Number($('history').value)];
    if (h) loadPreset(h);
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
  $('scope').addEventListener('change', save);
  $('template').addEventListener('input', save);
  $('copyKeybinding').addEventListener('click', () => {
    vscode.postMessage({ type: 'copyKeybinding', spec: spec(), scope: $('scope').value, template: $('template').value });
  });
  $('saveInspection').addEventListener('click', () => {
    $('error').textContent = '';
    vscode.postMessage({ type: 'saveInspection', spec: spec(), template: $('template').value, message: $('message').value, severity: $('severity').value });
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
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'prefill') { $('pattern').value = message.pattern; save(); renderConstraints(); }
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
      for (const item of message.items) {
        const li = document.createElement('li');
        li.innerHTML = '<div><code class="before"></code></div><div><code class="after"></code></div><div class="where"></div>';
        li.querySelector('.before').textContent = '− ' + item.before;
        li.querySelector('.after').textContent = '+ ' + item.after;
        li.querySelector('.where').textContent = item.where;
        list.appendChild(li);
      }
      $('summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (message.type === 'load') loadPreset({ ...message.inspection, message: message.inspection.message || '', severity: message.inspection.severity || 'warning' });
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
      if (message.count > 0) $('summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const list = $('results');
      list.innerHTML = '';
      for (const item of message.items) {
        const li = document.createElement('li');
        li.innerHTML = '<code></code><div class="where"></div><div class="bindings"></div>';
        li.querySelector('code').textContent = item.text;
        li.querySelector('.where').textContent = item.where;
        li.querySelector('.bindings').textContent = item.bindings;
        li.addEventListener('click', () => vscode.postMessage({ type: 'open', index: item.index }));
        list.appendChild(li);
      }
    }
    if (message.type && message.type.startsWith('status')) { $('error').textContent = ''; $('summary').textContent = message.text; }
  });
  renderConstraints();
  function applyPreset(p) {
    loadPreset(p);
    if (p.scope) { $('scope').value = p.scope; save(); }
    if (p.preview) $('previewReplace').click();
    else if (p.run) $('search').click();
  }
  const initialPreset = ${JSON.stringify(preset ?? null).replace(/</g, '\\u003c')};
  if (initialPreset) applyPreset(initialPreset);
</script>
</body>
</html>`;
}
