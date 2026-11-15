import * as vscode from 'vscode';
import { remedies, showProblem } from './problems';
import { ProjectService } from '../analysis/project';
import { FunctionInfo, SignatureSpec, changeSignature, describeFunction } from '../refactor/changeSignature';
import { applyRefactor, reportError } from './applyRefactor';
import { buttonCss, helpTip, icon } from './webviewStyle';
import { attachEditPanel, editPanelCss, editPanelHead, editPanelKeys, editPanelScript } from './editPanelKit';
import { featureName, finished } from './editFlow';

const command = 'tsStructure.changeSignature';
/** The open panel for each function, so running it again on the same function brings that panel back. */
const openPanels = new Map<string, vscode.WebviewPanel>();

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
  | { type: 'cancel'; dirty?: boolean }
  | { type: 'copy'; text: string }
  | { type: 'title'; name: string }
  | { type: 'help' }
  | { type: 'reload' };

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
  const key = `${document.uri.toString()}#${info.name}#${info.location.line}`;
  const already = openPanels.get(key);
  if (already) {
    already.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel('tsStructure.changeSignature', `${featureName(command)}: ${info.name}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  openPanels.set(key, panel);
  panel.onDidDispose(() => openPanels.delete(key));
  panel.webview.html = html(panel.webview, info);
  // Help, and a banner when the file changes; Reload opens the dialog again on the code as it is now.
  attachEditPanel(panel, command, document, async () => {
    panel.dispose();
    const fresh = await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, selection: new vscode.Range(document.positionAt(offset), document.positionAt(offset)) });
    await openChangeSignature(context, projects, fresh);
  });
  panel.webview.onDidReceiveMessage(
    async (message: Message) => {
      if (message.type === 'help' || message.type === 'reload') return;
      if (message.type === 'title') {
        // The tab follows the name being typed.
        panel.title = `${featureName(command)}: ${message.name.trim() || info.name}`;
        return;
      }
      if (message.type === 'copy') {
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Copied the new signature', 3000);
        return;
      }
      if (message.type === 'cancel') {
        if (message.dirty && (await vscode.window.showWarningMessage('Discard your changes to the signature?', { modal: true }, 'Discard')) !== 'Discard') {
          return;
        }
        panel.dispose();
        return;
      }
      if (document.version !== version) {
        void showProblem(`${vscode.workspace.asRelativePath(document.uri)} changed while Change Signature was open.`, [remedies.runAgain('tsStructure.changeSignature')], 'warning');
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
          const files = new Set(result.changes.map((c) => c.file)).size;
          void finished(command, `updated ${spec.name}${files > 1 ? ` and its calls in ${files - 1} other file${files === 2 ? '' : 's'}` : ''}.`, { file: document.uri.fsPath, changed: files });
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  input[type=text] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-editor-font-family); }
  input:disabled { opacity: .55; }
${buttonCss}
${editPanelCss}
  .top { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px 20px; margin-bottom: 22px; }
  .field-head { display: flex; align-items: baseline; gap: 8px; }
  .field-head .ep-label { flex: 1; }
  .field-note { color: var(--vscode-descriptionForeground); font-size: .9em; }
  .top input[type=text] { padding: 9px 12px; font-size: var(--vscode-editor-font-size, 13px); }
  .params-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .params-head .ep-section { flex: 1; }
  /* The parameter table sits in a rounded card; a narrow panel scrolls it sideways instead of squeezing it. */
  .table-card { overflow-x: auto; }
  table { width: 100%; min-width: 740px; border-collapse: collapse; table-layout: fixed; }
  th { text-align: left; font-weight: 500; color: var(--vscode-descriptionForeground); padding: 9px 6px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .25)); white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 12px; }
  th:last-child, td:last-child { padding-right: 12px; text-align: right; }
  th.center, td.center { text-align: center; }
  td { padding: 8px 6px; vertical-align: middle; background: var(--vscode-editor-background); }
  tbody tr + tr td { border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .18)); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td input[type=text] { min-width: 0; padding: 6px 9px; }
  tr.new td:first-child { box-shadow: inset 3px 0 0 var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  input.type { color: var(--vscode-charts-green, #89d185); }
  td.order { white-space: nowrap; }
  td.order button.icon-only { padding: 3px; opacity: .6; }
  td.order button.icon-only:hover:not(:disabled) { opacity: 1; }
  td.order button:disabled { opacity: .2; }
  .locked { display: flex; align-items: center; gap: 6px; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .3));
    color: var(--vscode-descriptionForeground); font-style: italic; white-space: nowrap; overflow: hidden; cursor: default; }
  .locked span { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .locked .icon { flex: none; opacity: .7; }
  /* Optional is a switch. */
  input.switch { appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 18px; margin: 0; border-radius: 9px; cursor: pointer; vertical-align: middle;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .45)); transition: background .15s; }
  input.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-foreground); transition: transform .15s; }
  input.switch:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  input.switch:checked::after { transform: translateX(16px); background: var(--vscode-button-foreground); }
  input.switch:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  td.tools { white-space: nowrap; }
  .problems button.link { display: inline; min-height: 0; padding: 0; border: 0; background: none; color: var(--vscode-errorForeground); text-decoration: underline; cursor: pointer; font: inherit; }
  .undo-line { color: var(--vscode-descriptionForeground); margin: 8px 0 0; }
  .undo-line[hidden] { display: none; }
  .undo-line button.link { min-height: 0; padding: 0 2px; border: 0; background: none; color: var(--vscode-textLink-foreground); font: inherit; }
  input[aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .problems { color: var(--vscode-errorForeground); margin: 8px 0 0; }
  .problems:empty { display: none; }
  /* The signature as it will read, colored like code. */
  .sig-card { margin-top: 18px; overflow: hidden; }
  .sig-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .25)); font-weight: 600; }
  .sig-head > .icon { color: var(--vscode-textLink-foreground); }
  .sig-head .title { flex: 1; }
  .sig-head button { min-height: 26px; padding: 3px 10px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .sig-body { margin: 0; padding: 14px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .sig-line { display: block; }
  .sig-line.before { opacity: .55; text-decoration: line-through; text-decoration-color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .sig-tag { display: inline-block; width: 4.2em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: .85em; text-decoration: none; }
  .tk-kw { color: var(--vscode-charts-purple, #b180d7); }
  .tk-fn { color: var(--vscode-charts-yellow, #cca700); }
  .tk-param { color: var(--vscode-symbolIcon-variableForeground, #75beff); }
  .tk-type { color: var(--vscode-charts-green, #89d185); }
  .tk-punct { color: var(--vscode-descriptionForeground); }
  .summary { margin: 10px 0 0; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
${editPanelHead(command, `${info.kind} ${info.name}`, 'sliders', 'Change the name, parameters and return type; every call is updated to match.')}
<datalist id="types">${[...new Set(['string', 'number', 'boolean', 'unknown', 'void', 'undefined', 'null', 'string[]', 'number[]', 'Record<string, unknown>', 'Promise<void>', ...info.parameters.map((p) => p.type).filter(Boolean), info.returnType].filter(Boolean))].map((t) => `<option value="${t.replace(/"/g, '&quot;')}">`).join('')}</datalist>
<div class="top">
  <div><div class="field-head"><label class="ep-label" for="name">${info.kind === 'method' ? 'Method' : 'Function'} name</label></div><input type="text" id="name" spellcheck="false"></div>
  <div id="returnLabel"><div class="field-head"><label class="ep-label" for="returnType">Return type</label><span class="field-note">empty for inferred / void</span></div><input type="text" id="returnType" spellcheck="false" placeholder="e.g. void, Promise&lt;void&gt;, boolean" list="types"></div>
</div>
<div class="params-head">
  <h2 class="ep-section" id="paramsHeading">Parameters <span class="ep-count" id="paramCount">0</span></h2>
  <button id="add" class="ep-outline" title="Add a parameter (Ctrl+Shift+A)">${icon('add')}<span>Add parameter</span></button>
</div>
<div class="table-card ep-card">
<table aria-labelledby="paramsHeading">
  <colgroup><col style="width: 70px"><col><col class="typed"><col><col style="width: 21%"><col class="typed" style="width: 78px"><col style="width: 84px"></colgroup>
  <thead><tr><th scope="col">Order</th><th scope="col">Name</th><th scope="col" class="typed">Type</th><th scope="col">Default value${helpTip('Used when a caller leaves the argument out, as in (size = 20). Callers that pass a value are not affected.')}</th><th scope="col">Call-site value${helpTip('Only for new parameters: this text is inserted as the argument at every existing call, so they keep compiling. Existing parameters keep the argument each caller passes. Leave it empty for an optional parameter or one with a default value.')}</th><th scope="col" class="typed center">Optional${helpTip('Adds ? to the parameter, so callers may leave it out and it is undefined then.')}</th><th scope="col">Actions</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<p id="problems" class="problems" role="status" aria-live="polite"></p>
<p id="undoLine" class="undo-line" hidden></p>
<section class="sig-card ep-card" aria-labelledby="sigTitle">
  <div class="sig-head">${icon('code')}<span class="title" id="sigTitle">Resulting signature</span><button id="copy" class="ep-ghost" title="Copy the new signature">${icon('copy')}<span>Copy signature</span></button></div>
  <pre class="sig-body" id="preview" aria-live="polite"></pre>
</section>
<p id="summary" class="summary" aria-live="polite"></p>
${editPanelKeys([['Ctrl+Enter', 'Preview changes'], ['Ctrl+Shift+Enter', 'Apply refactor'], ['Enter', 'Next row'], ['Alt+↑/↓', 'Reorder row'], ['Ctrl+D', 'Duplicate'], ['Ctrl+Del', 'Remove'], ['Ctrl+Shift+A', 'Add parameter'], ['F1', 'Help'], ['Esc', 'Cancel']])}
<div class="actions ep-sticky">
  <button id="reset" class="ep-outline" title="Back to the signature the function has now">${icon('reset')}<span>Reset</span></button>
  <button id="cancel" class="ep-ghost" title="Close without changing anything (Escape)"><span>Cancel</span></button>
  <span class="spacer"></span>
  <button id="previewBtn" class="ep-outline" aria-describedby="problems" title="Review every change before it is applied (Ctrl+Enter)">${icon('preview')}<span>Preview changes</span></button>
  <button class="primary" id="apply" aria-describedby="problems" title="Apply the changes now (Ctrl+Shift+Enter)">${icon('apply')}<span>Refactor</span></button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.__epApi = vscode;
  const { info, rows } = ${state};
  const initialRows = JSON.stringify(rows);
  const $ = (id) => document.getElementById(id);
  $('name').value = info.name;
  $('returnType').value = info.returnType;
  if (!info.typed) {
    $('returnLabel').style.display = 'none';
    document.querySelectorAll('.typed').forEach((el) => (el.tagName === 'COL' ? el.remove() : (el.style.display = 'none')));
  }

  const columns = { name: 'Name', type: 'Type', initializer: 'Default value', callValue: 'Value for existing callers' };
  function input(row, key, placeholder, disabled) {
    const el = document.createElement('input');
    el.type = 'text';
    const position = rows.indexOf(row) + 1;
    el.setAttribute('aria-label', columns[key] + ' of parameter ' + position + (key !== 'name' && row.name ? ' (' + row.name + ')' : ''));
    el.dataset.key = key;
    el.value = row[key];
    el.placeholder = placeholder || '';
    el.disabled = !!disabled;
    el.addEventListener('input', () => { row[key] = el.value; update(); });
    if (key === 'type') { el.setAttribute('list', 'types'); el.className = 'type'; }
    el.spellcheck = false;
    // A name typed with spaces or dashes becomes camelCase when you leave the field.
    if (key === 'name') el.addEventListener('blur', () => {
      const words = el.value.trim().split(/[\\s-]+/).filter(Boolean);
      if (words.length > 1) { el.value = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join(''); row[key] = el.value; update(); }
    });
    // Enter goes to the same field of the next row (Shift+Enter: the row above).
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const tr = el.closest('tr');
      const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
      const field = next && next.querySelector('input[data-key="' + key + '"]:not(:disabled)');
      if (field) { field.focus(); field.select(); } else if (!e.shiftKey) $('add').focus();
    });
    const td = document.createElement('td');
    td.appendChild(el);
    return td;
  }
  const icons = ${JSON.stringify({ up: icon('up'), down: icon('down'), remove: icon('remove'), copy: icon('duplicate'), lock: icon('lock') })};
  function button(text, title, disabled, onClick) {
    const b = document.createElement('button');
    b.className = 'icon-only';
    b.innerHTML = icons[text];
    b.setAttribute('aria-label', title);
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
      const label = ' parameter ' + (i + 1) + (row.name ? ' (' + row.name + ')' : '');
      const order = document.createElement('td');
      order.className = 'order';
      order.appendChild(button('up', 'Move up' + label + ' (Alt+Up)', i === 0, () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); render(); refocus(i - 1, 'up'); }));
      order.appendChild(button('down', 'Move down' + label + ' (Alt+Down)', i === rows.length - 1, () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); render(); refocus(i + 1, 'down'); }));
      tr.appendChild(order);
      tr.appendChild(input(row, 'name', 'name', original && !original.renamable));
      const typeCell = input(row, 'type', 'type');
      typeCell.className = 'typed';
      if (!info.typed) typeCell.style.display = 'none';
      tr.appendChild(typeCell);
      tr.appendChild(input(row, 'initializer', 'none'));
      if (original) {
        // An existing parameter keeps what each caller passes: nothing to type here.
        const kept = document.createElement('td');
        kept.innerHTML = '<div class="locked" title="Each existing call keeps the argument it passes"><span>(keep existing)</span>' + icons.lock + '</div>';
        tr.appendChild(kept);
      } else {
        tr.appendChild(input(row, 'callValue', 'e.g. undefined, 0, "text"'));
      }
      const optCell = document.createElement('td');
      optCell.className = 'typed center';
      if (!info.typed) optCell.style.display = 'none';
      const opt = document.createElement('input');
      opt.type = 'checkbox';
      opt.className = 'switch';
      opt.setAttribute('role', 'switch');
      opt.setAttribute('aria-label', 'Optional: parameter ' + (i + 1) + (row.name ? ' (' + row.name + ')' : ''));
      opt.checked = row.optional;
      opt.addEventListener('change', () => { row.optional = opt.checked; update(); });
      optCell.appendChild(opt);
      tr.appendChild(optCell);
      const tools = document.createElement('td');
      tools.className = 'tools';
      tools.appendChild(button('copy', 'Duplicate' + label + ' (Ctrl+D)', false, () => duplicate(i)));
      tools.appendChild(button('remove', 'Remove' + label + ' (Ctrl+Delete)', false, () => remove(i)));
      tr.appendChild(tools);
      body.appendChild(tr);
    });
    update();
  }
  /** A copy of the row below it, as a new parameter with a free name. */
  function duplicate(i) {
    const source = rows[i];
    let name = source.name + 'Copy';
    for (let n = 2; rows.some((r) => r.name === name); n++) name = source.name + 'Copy' + n;
    rows.splice(i + 1, 0, { originalIndex: null, name, type: source.type, initializer: source.initializer, optional: source.optional, callValue: 'undefined' });
    render();
    const field = $('rows').children[i + 1].querySelector('input');
    field.focus();
    field.select();
  }
  /** Removing a row says so, with Undo, until the next change. */
  let removed;
  function remove(i) {
    removed = { row: rows[i], index: i };
    rows.splice(i, 1);
    render();
    refocus(Math.min(i, rows.length - 1), 'name');
    const line = $('undoLine');
    line.textContent = 'Removed ' + (removed.row.name || 'a parameter') + '. ';
    const undo = document.createElement('button');
    undo.className = 'link';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
      rows.splice(removed.index, 0, removed.row);
      line.hidden = true;
      render();
      refocus(removed.index, 'name');
      removed = undefined;
    });
    line.append(undo);
    line.hidden = false;
  }
  /** After a row moves or goes away, focus the same kind of control on the row it went to, or Add Parameter. */
  function refocus(index, kind) {
    const tr = $('rows').children[index];
    const buttons = tr ? tr.querySelectorAll('button') : [];
    const target = !tr ? $('add') : kind === 'up' ? buttons[0] : kind === 'down' ? buttons[1] : kind === 'remove' ? buttons[2] : tr.querySelector('input');
    // A disabled button (first row moved to the top) cannot take focus; its row's name can.
    (target && !target.disabled ? target : tr ? tr.querySelector('input') : $('add')).focus();
  }
  const plainIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const reserved = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));
  const identifier = { test: (name) => plainIdentifier.test(name) && !reserved.has(name) };
  /** What stops the refactoring, checked as you type so the buttons say why they are off. */
  function problems() {
    const found = [];
    found.at = [];
    const add = (text, at) => { found.push(text); found.at.push(at); };
    if (!identifier.test($('name').value.trim())) add('The function name is not a valid identifier.', 'name');
    const seen = new Set();
    rows.forEach((r) => {
      const original = r.originalIndex === null ? null : info.parameters[r.originalIndex];
      const name = r.name.trim();
      // Destructured parameters keep their pattern and can't be renamed.
      if (original && !original.renamable) return;
      const at = rows.indexOf(r);
      if (reserved.has(name)) add('"' + name + '" is a reserved word and can\\'t be a parameter name.', at);
      else if (!identifier.test(name)) add('"' + name + '" is not a valid parameter name.', at);
      else if (seen.has(name)) add('Two parameters are named "' + name + '".', at);
      seen.add(name);
      if (!original && !r.optional && !r.initializer.trim() && !r.callValue.trim()) add('New parameter "' + name + '" needs a value for existing callers' + (info.typed ? ', a default value, or to be optional.' : ' or a default value.'), at + ':callValue');
    });
    return found;
  }
  function update() {
    const found = problems();
    const box = $('problems');
    box.textContent = '';
    found.forEach((text, n) => {
      // Each problem is a link to the field it is about.
      const link = document.createElement('button');
      link.className = 'link';
      link.textContent = text;
      link.addEventListener('click', () => {
        const at = found.at[n];
        if (at === 'name') return $('name').focus();
        const [row, key] = String(at).split(':');
        const tr = $('rows').children[Number(row)];
        const field = tr && tr.querySelector('input[data-key="' + (key || 'name') + '"]');
        if (field) { field.focus(); field.select(); }
      });
      box.append(link, ' ');
    });
    const markInvalid = (el, bad) => {
      el.setAttribute('aria-invalid', String(bad));
      if (bad) el.setAttribute('aria-describedby', 'problems');
      else el.removeAttribute('aria-describedby');
    };
    markInvalid($('name'), !identifier.test($('name').value.trim()));
    const names = rows.map((r) => r.name.trim());
    Array.prototype.forEach.call($('rows').children, (tr, i) => {
      const r = rows[i];
      const original = r && r.originalIndex !== null ? info.parameters[r.originalIndex] : null;
      const field = tr.querySelector('input[data-key="name"]');
      if (!field || !r || (original && !original.renamable)) return;
      markInvalid(field, !identifier.test(names[i]) || names.indexOf(names[i]) !== i);
    });
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
    const after = $('name').value + '(' + params.join(', ') + ')' + ret;
    afterText = after;
    const parts = rows.map((r) => {
      const original = r.originalIndex === null ? null : info.parameters[r.originalIndex];
      const rest = original && original.rest ? '...' : '';
      const q = info.typed && r.optional && !r.initializer && !rest ? '?' : '';
      return { name: rest + r.name + q, type: info.typed ? r.type : '', init: r.initializer };
    });
    const signature = colored($('name').value, parts, info.typed ? $('returnType').value.trim() : '');
    const sigBox = $('preview');
    sigBox.innerHTML = beforeHtml && beforeText !== after
      ? '<span class="sig-line before"><span class="sig-tag">Before</span>' + beforeHtml + '</span><span class="sig-line"><span class="sig-tag">After</span>' + signature + '</span>'
      : '<span class="sig-line">' + signature + '</span>';
    const summary = changeSummary();
    $('summary').textContent = summary === 'Nothing changed yet.' ? '' : summary;
    $('reset').disabled = !isDirty();
    $('paramCount').textContent = String(rows.length);
    const count = changeCount();
    if (typeof window.epSetStatus === 'function') window.epSetStatus(count ? count + (count === 1 ? ' change' : ' changes') : 'Nothing changed yet', count > 0);
  }
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tk = (kind, t) => '<span class="tk-' + kind + '">' + esc(t) + '</span>';
  /** The signature as HTML, colored like code: keyword, name, parameters, types. */
  function colored(name, parts, ret) {
    const head = (info.kind === 'method' ? '' : tk('kw', 'function') + ' ') + tk('fn', name) + tk('punct', '(');
    const list = parts.map((p) => tk('param', p.name) + (p.type ? tk('punct', ': ') + tk('type', p.type) : '') + (p.init ? tk('punct', ' = ') + esc(p.init) : '')).join(tk('punct', ', '));
    return head + list + tk('punct', ')') + (ret ? tk('punct', ': ') + tk('type', ret) : '');
  }
  /** How many things the edit changes, for the status pill. */
  function changeCount() {
    let n = 0;
    if ($('name').value.trim() !== info.name) n++;
    if (info.typed && $('returnType').value.trim() !== info.returnType) n++;
    const kept = rows.filter((r) => r.originalIndex !== null);
    kept.forEach((r) => {
      const p = info.parameters[r.originalIndex];
      if (r.name.trim() !== p.name) n++;
      if (r.type.trim() !== p.type) n++;
      if (r.initializer.trim() !== p.initializer) n++;
      if (r.optional !== p.optional) n++;
    });
    n += rows.filter((r) => r.originalIndex === null).length;
    n += info.parameters.filter((p, i) => !rows.some((r) => r.originalIndex === i)).length;
    const order = kept.map((r) => r.originalIndex);
    if (order.some((v, i) => i > 0 && v < order[i - 1])) n++;
    return n;
  }
  /** What the edit does, in words: renamed, added, removed and moved parameters, and the function's new name. */
  function changeSummary() {
    const parts = [];
    const newName = $('name').value.trim();
    if (newName && newName !== info.name) parts.push('renames ' + info.name + ' to ' + newName);
    const kept = rows.filter((r) => r.originalIndex !== null);
    const renamed = kept.filter((r) => r.name.trim() !== info.parameters[r.originalIndex].name).map((r) => info.parameters[r.originalIndex].name + ' → ' + r.name.trim());
    if (renamed.length) parts.push('renames ' + renamed.join(', '));
    const added = rows.filter((r) => r.originalIndex === null).map((r) => r.name.trim() || 'a parameter');
    if (added.length) parts.push('adds ' + added.join(', '));
    const removed = info.parameters.filter((p, i) => !rows.some((r) => r.originalIndex === i)).map((p) => p.name);
    if (removed.length) parts.push('removes ' + removed.join(', '));
    const order = kept.map((r) => r.originalIndex);
    if (order.some((v, i) => i > 0 && v < order[i - 1])) parts.push('reorders the parameters');
    if (info.typed && $('returnType').value.trim() !== info.returnType) parts.push('changes the return type');
    return parts.length ? 'This ' + parts.join('; ') + ', and updates every call.' : 'Nothing changed yet.';
  }
  function submit(preview) {
    if (problems().length) return;
    vscode.postMessage({ type: 'submit', preview, name: $('name').value, returnType: $('returnType').value, rows });
  }
  $('add').addEventListener('click', () => {
    rows.push({ originalIndex: null, name: 'param' + (rows.length + 1), type: info.typed ? 'unknown' : '', initializer: '', optional: false, callValue: 'undefined' });
    render();
    // Straight into naming the new parameter.
    const name = $('rows').lastElementChild.querySelector('input');
    name.focus();
    name.select();
  });
  $('name').addEventListener('input', () => { update(); vscode.postMessage({ type: 'title', name: $('name').value }); });
  $('returnType').addEventListener('input', update);
  $('previewBtn').addEventListener('click', () => submit(true));
  $('apply').addEventListener('click', () => submit(false));
  const isDirty = () => JSON.stringify(rows) !== initialRows || $('name').value !== info.name || $('returnType').value !== info.returnType;
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel', dirty: isDirty() }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: (info.kind === 'method' ? '' : 'function ') + afterText }));
  $('reset').addEventListener('click', () => {
    rows.splice(0, rows.length, ...JSON.parse(initialRows));
    $('name').value = info.name;
    $('returnType').value = info.returnType;
    render();
  });
  // Ctrl+Enter previews, Ctrl+Shift+Enter refactors, Escape cancels, Alt+Up/Down moves the parameter being edited.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit(!e.shiftKey);
    } else if (e.key === 'Escape') {
      vscode.postMessage({ type: 'cancel', dirty: isDirty() });
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'Delete' || e.key === 'd' || e.key === 'D')) {
      const tr = e.target.closest && e.target.closest('tr');
      const i = tr ? Array.prototype.indexOf.call($('rows').children, tr) : -1;
      if (i >= 0) {
        e.preventDefault();
        if (e.key === 'Delete') remove(i);
        else duplicate(i);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      $('add').click();
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
  let beforeText, beforeHtml, afterText = '';
  render();
  beforeText = afterText;
  beforeHtml = $('preview').querySelector('.sig-line').innerHTML;
  $('name').focus();
${editPanelScript}
  // The status pill exists once the kit has run.
  update();
</script>
</body>
</html>`;
}
