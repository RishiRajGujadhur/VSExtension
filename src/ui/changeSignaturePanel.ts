import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { FunctionInfo, SignatureSpec, changeSignature, describeFunction } from '../refactor/changeSignature';
import { applyRefactor, reportError } from './applyRefactor';

interface Row {
  originalIndex: number | null;
  name: string;
  type: string;
  initializer: string;
  optional: boolean;
  callValue: string;
}

type Message =
  | { type: 'submit'; preview: boolean; name: string; returnType: string; rows: Row[] }
  | { type: 'cancel' };

/** Opens the Change Signature dialog for the function at the cursor. */
export async function openChangeSignature(context: vscode.ExtensionContext, projects: ProjectService, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const offset = document.offsetAt(editor.selection.active);
  const fallbackRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  let info: FunctionInfo;
  try {
    info = describeFunction(projects.createVirtualProject(document.uri.fsPath, fallbackRoot), document.uri.fsPath, offset);
  } catch (error) {
    reportError(error, 'Change Signature');
    return;
  }
  const version = document.version;

  const panel = vscode.window.createWebviewPanel('tsStructure.changeSignature', `Change Signature: ${info.name}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = html(panel.webview, info);
  panel.webview.onDidReceiveMessage(
    async (message: Message) => {
      if (message.type === 'cancel') {
        panel.dispose();
        return;
      }
      if (document.version !== version) {
        void vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(document.uri)} changed. Run Change Signature again.`);
        return;
      }
      const spec: SignatureSpec = {
        name: message.name.trim(),
        returnType: info.typed ? message.returnType.trim() : undefined,
        parameters: message.rows.map((row) => {
          const original = row.originalIndex !== null ? info.parameters[row.originalIndex] : undefined;
          return {
            originalIndex: row.originalIndex ?? undefined,
            name: row.name.trim(),
            type: original && row.type.trim() === original.type ? undefined : row.type.trim(),
            initializer: original && row.initializer.trim() === original.initializer ? undefined : row.initializer.trim(),
            optional: row.optional,
            callValue: row.callValue.trim(),
          };
        }),
      };
      try {
        const result = changeSignature(projects.createVirtualProject(document.uri.fsPath, fallbackRoot), document.uri.fsPath, offset, spec);
        if (await applyRefactor(result, message.preview)) {
          panel.dispose();
        }
      } catch (error) {
        reportError(error, 'Change Signature');
      }
    },
    undefined,
    context.subscriptions,
  );
}

function html(webview: vscode.Webview, info: FunctionInfo): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const rows: Row[] = info.parameters.map((p, i) => ({
    originalIndex: i,
    name: p.name,
    type: p.type,
    initializer: p.initializer,
    optional: p.optional,
    callValue: '',
  }));
  const state = JSON.stringify({ info, rows }).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 16px; }
  h2 { font-size: 1.1em; margin: 0 0 12px; }
  label { display: block; margin-bottom: 10px; }
  label span { display: block; opacity: .8; margin-bottom: 3px; }
  input[type=text] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font-family: var(--vscode-editor-font-family); }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
  input:disabled { opacity: .5; }
  .top { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 8px; }
  th { text-align: left; font-weight: normal; opacity: .8; padding: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 3px 4px; vertical-align: middle; }
  tr.new td:first-child { border-left: 2px solid var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.icon { padding: 2px 7px; }
  button:disabled { opacity: .4; cursor: default; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  .spacer { flex: 1; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
  .hint { opacity: .75; font-size: .92em; }
  .problems { color: var(--vscode-errorForeground); min-height: 1em; margin: 4px 0 0; }
</style>
</head>
<body>
<h2 id="title"></h2>
<div class="top">
  <label><span>Name</span><input type="text" id="name"></label>
  <label id="returnLabel"><span>Return type (empty for none)</span><input type="text" id="returnType"></label>
</div>
<table>
  <thead><tr><th>Name</th><th class="typed">Type</th><th>Default value</th><th>Value for existing callers</th><th class="typed">Optional</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<button id="add">+ Add parameter</button>
<p class="hint">Existing parameters keep the argument each caller passes. For a new parameter, the value for existing callers is inserted at every call site; leave it empty when the parameter is optional or has a default value.</p>
<pre id="preview"></pre>
<p id="problems" class="problems" role="alert"></p>
<div class="actions">
  <button class="primary" id="previewBtn" title="Ctrl+Enter">Preview Changes</button>
  <button id="apply" title="Ctrl+Shift+Enter">Refactor</button>
  <span class="spacer"></span>
  <button id="cancel">Cancel</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const { info, rows } = ${state};
  const $ = (id) => document.getElementById(id);
  $('title').textContent = 'Change signature of ' + info.kind + ' ' + info.name;
  $('name').value = info.name;
  $('returnType').value = info.returnType;
  if (!info.typed) {
    $('returnLabel').style.display = 'none';
    document.querySelectorAll('.typed').forEach((el) => (el.style.display = 'none'));
  }

  function input(row, key, placeholder, disabled) {
    const el = document.createElement('input');
    el.type = 'text';
    el.value = row[key];
    el.placeholder = placeholder || '';
    el.disabled = !!disabled;
    el.addEventListener('input', () => { row[key] = el.value; update(); });
    const td = document.createElement('td');
    td.appendChild(el);
    return td;
  }
  function button(text, title, disabled, onClick) {
    const b = document.createElement('button');
    b.className = 'icon';
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }
  function render() {
    const body = $('rows');
    body.innerHTML = '';
    rows.forEach((row, i) => {
      const original = row.originalIndex === null ? null : info.parameters[row.originalIndex];
      const tr = document.createElement('tr');
      if (!original) tr.className = 'new';
      tr.appendChild(input(row, 'name', 'name', original && !original.renamable));
      const typeCell = input(row, 'type', 'type');
      typeCell.className = 'typed';
      if (!info.typed) typeCell.style.display = 'none';
      tr.appendChild(typeCell);
      tr.appendChild(input(row, 'initializer', 'none'));
      tr.appendChild(input(row, 'callValue', original ? '(keeps the passed argument)' : 'e.g. undefined, 0, "text"', !!original));
      const optCell = document.createElement('td');
      optCell.className = 'typed';
      if (!info.typed) optCell.style.display = 'none';
      const opt = document.createElement('input');
      opt.type = 'checkbox';
      opt.checked = row.optional;
      opt.addEventListener('change', () => { row.optional = opt.checked; update(); });
      optCell.appendChild(opt);
      tr.appendChild(optCell);
      const tools = document.createElement('td');
      tools.style.whiteSpace = 'nowrap';
      tools.appendChild(button('↑', 'Move up', i === 0, () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); render(); }));
      tools.appendChild(button('↓', 'Move down', i === rows.length - 1, () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); render(); }));
      tools.appendChild(button('✕', 'Remove', false, () => { rows.splice(i, 1); render(); }));
      tr.appendChild(tools);
      body.appendChild(tr);
    });
    update();
  }
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  /** What stops the refactoring, checked as you type so the buttons say why they are off. */
  function problems() {
    const found = [];
    if (!identifier.test($('name').value.trim())) found.push('The function name is not a valid identifier.');
    const seen = new Set();
    rows.forEach((r) => {
      const original = r.originalIndex === null ? null : info.parameters[r.originalIndex];
      const name = r.name.trim();
      // Destructured parameters keep their pattern and can't be renamed.
      if (original && !original.renamable) return;
      if (!identifier.test(name)) found.push('"' + name + '" is not a valid parameter name.');
      else if (seen.has(name)) found.push('Two parameters are named "' + name + '".');
      seen.add(name);
      if (!original && !r.optional && !r.initializer.trim() && !r.callValue.trim()) found.push('New parameter "' + name + '" needs a value for existing callers' + (info.typed ? ', a default value, or to be optional.' : ' or a default value.'));
    });
    return found;
  }
  function update() {
    const found = problems();
    $('problems').textContent = found.join(' ');
    $('previewBtn').disabled = $('apply').disabled = found.length > 0;
    const params = rows.map((r) => {
      const original = r.originalIndex === null ? null : info.parameters[r.originalIndex];
      const rest = original && original.rest ? '...' : '';
      const q = info.typed && r.optional && !r.initializer && !rest ? '?' : '';
      const type = info.typed && r.type ? ': ' + r.type : '';
      const init = r.initializer ? ' = ' + r.initializer : '';
      return rest + r.name + q + type + init;
    });
    const ret = info.typed && $('returnType').value.trim() ? ': ' + $('returnType').value.trim() : '';
    $('preview').textContent = $('name').value + '(' + params.join(', ') + ')' + ret;
  }
  function submit(preview) {
    if (problems().length) return;
    vscode.postMessage({ type: 'submit', preview, name: $('name').value, returnType: $('returnType').value, rows });
  }
  $('add').addEventListener('click', () => {
    rows.push({ originalIndex: null, name: 'param' + (rows.length + 1), type: info.typed ? 'unknown' : '', initializer: '', optional: false, callValue: 'undefined' });
    render();
  });
  $('name').addEventListener('input', update);
  $('returnType').addEventListener('input', update);
  $('previewBtn').addEventListener('click', () => submit(true));
  $('apply').addEventListener('click', () => submit(false));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  // Ctrl+Enter previews, Ctrl+Shift+Enter refactors, Escape cancels, Alt+Up/Down moves the parameter being edited.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit(!e.shiftKey);
    } else if (e.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const cell = e.target.closest && e.target.closest('td');
      const tr = cell && cell.parentElement;
      const i = tr ? Array.prototype.indexOf.call($('rows').children, tr) : -1;
      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (i < 0 || to < 0 || to >= rows.length) return;
      e.preventDefault();
      const column = Array.prototype.indexOf.call(tr.children, cell);
      rows.splice(to, 0, rows.splice(i, 1)[0]);
      render();
      const input = $('rows').children[to].children[column].querySelector('input');
      if (input) input.focus();
    }
  });
  render();
  $('name').focus();
</script>
</body>
</html>`;
}
