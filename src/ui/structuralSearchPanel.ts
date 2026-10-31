import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath } from '../analysis/paths';
import { Match, PlaceholderConstraint, SearchScope, SearchSpec, bindingSummary, searchReport, structuralSearch } from '../search/structuralSearch';
import { reportError } from './applyRefactor';
import { StructureView } from './structureView';

export type Scope = 'project' | 'file';

type Message =
  | { type: 'search'; spec: SearchSpec; scope: Scope }
  | { type: 'open'; index: number };

/** Structural Search Builder: a pattern editor with typed placeholder constraints and live results. */
export class StructuralSearchPanel {
  private static current: StructuralSearchPanel | undefined;
  private matches: Match[] = [];
  /** The file the search was opened from; scope "file" and project loading use it. */
  private anchor: string;

  static open(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView, initial?: { pattern?: string; anchor?: string }): StructuralSearchPanel {
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
      return StructuralSearchPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('tsStructure.structuralSearch', 'Structural Search', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    StructuralSearchPanel.current = new StructuralSearchPanel(context, panel, projects, view, anchor);
    panel.webview.html = html(panel.webview, initial?.pattern ?? '');
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

  protected scopeOf(scope: Scope): SearchScope {
    return scope === 'file' ? { files: [this.anchor] } : {};
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
    if (message.type === 'search') {
      try {
        const program = this.projects.createVirtualProject(this.anchor, this.folder()).program();
        this.matches = structuralSearch(program, clean(message.spec), this.scopeOf(message.scope));
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

export function registerStructuralSearch(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tsStructure.structuralSearch', () => {
      const editor = vscode.window.activeTextEditor;
      const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
      try {
        StructuralSearchPanel.open(context, projects, view, { pattern: selected, anchor: editor ? normalizePath(editor.document.uri.fsPath) : undefined });
      } catch (error) {
        reportError(error, 'Structural Search');
      }
    }),
  );
}

function html(webview: vscode.Webview, pattern: string): string {
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
</style>
</head>
<body>
  <h2>Pattern</h2>
  <p class="hint">Write code with <code>$name$</code> placeholders. <code>$name*$</code> matches any number of arguments, elements or statements; reusing a name requires the same code; <code>$_$</code> matches anything.</p>
  <textarea id="pattern" spellcheck="false" placeholder="$list$.forEach($callback$)"></textarea>
  <h2>Placeholder constraints</h2>
  <p class="hint">Regular expressions. <em>Type</em> is tested against the matched expression's type, such as <code>^Promise&lt;</code> or <code>string|number</code>.</p>
  <table id="constraints"><thead><tr><th>Placeholder</th><th>Type</th><th>Text</th><th>Invert</th></tr></thead><tbody></tbody></table>
  <div class="row">
    <label>Scope <select id="scope"><option value="project">Whole project</option><option value="file">Current file</option></select></label>
    <button id="search">Search</button>
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
  $('scope').value = state.scope || 'project';

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
        });
      }
      body.appendChild(tr);
    }
  }
  function save() {
    state.pattern = $('pattern').value;
    state.scope = $('scope').value;
    vscode.setState(state);
  }
  function spec() {
    const names = placeholders($('pattern').value);
    return { pattern: $('pattern').value, constraints: names.map((name) => ({ name, ...(state.constraints[name] || {}) })) };
  }
  $('pattern').addEventListener('input', () => { save(); renderConstraints(); });
  $('scope').addEventListener('change', save);
  $('search').addEventListener('click', () => {
    $('error').textContent = '';
    $('summary').textContent = 'Searching…';
    vscode.postMessage({ type: 'search', spec: spec(), scope: $('scope').value });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'prefill') { $('pattern').value = message.pattern; save(); renderConstraints(); }
    if (message.type === 'error') { $('summary').textContent = ''; $('error').textContent = message.message; }
    if (message.type === 'results') {
      $('summary').textContent = message.count + (message.count === 1 ? ' match' : ' matches') + (message.count > message.items.length ? ' (first ' + message.items.length + ' shown)' : '');
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
</script>
</body>
</html>`;
}
