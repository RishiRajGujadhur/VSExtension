import * as vscode from 'vscode';
import { featureName, showHelp } from './editFlow';
import { icon } from './webviewStyle';

/**
 * The shared look of the Edit features that open a panel (Change signature, Search by shape): a header with the
 * feature's name, what it works on and a help button; sections that fold and remember it; the main buttons in a bar
 * that stays at the bottom; a line of keys; and a banner when the file changes underneath.
 */
export const editPanelCss = `
  .ep-head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .3)); }
  .ep-head h1 { margin: 0; font-size: 1.15em; font-weight: 600; }
  .ep-head .ep-subject { padding: 1px 8px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .ep-head .ep-spacer { flex: 1; }
  .ep-head .ep-icon { display: inline-flex; color: var(--vscode-textLink-foreground); }
  .ep-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 12px; padding: 6px 10px; border-radius: 4px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700); background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, .12)); }
  .ep-banner[hidden] { display: none; }
  .ep-banner .ep-banner-text { flex: 1; min-width: 160px; }
  .ep-collapsible { cursor: pointer; user-select: none; }
  .ep-collapsible::before { content: '▾'; display: inline-block; width: 1em; color: var(--vscode-descriptionForeground); transition: transform .1s; }
  .ep-collapsible.ep-folded::before { transform: rotate(-90deg); }
  .ep-folded-away { display: none !important; }
  .ep-keys { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 10px 0 0; color: var(--vscode-descriptionForeground); font-size: .9em; }
  .ep-keys kbd { padding: 0 4px; border: 1px solid var(--vscode-keybindingLabel-border, rgba(128, 128, 128, .4)); border-bottom-width: 2px; border-radius: 3px; font-family: inherit; font-size: .95em; }
  /* The main buttons stay in view at the bottom while the panel scrolls. */
  .actions.ep-sticky { position: sticky; bottom: 0; z-index: 2; margin: 14px -16px -12px; padding: 10px 16px; border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .3));
    background: var(--vscode-editor-background); }
  @media (forced-colors: active) { .ep-banner, .ep-head .ep-subject { border: 1px solid CanvasText; } }
`;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The header: the feature's name, its subject, and the help button (F1). */
export function editPanelHead(command: string, subject?: string, iconName: Parameters<typeof icon>[0] = 'apply'): string {
  return `<header class="ep-head"><span class="ep-icon">${icon(iconName)}</span><h1 id="epTitle">${escape(featureName(command))}</h1>${subject ? `<span class="ep-subject" id="epSubject">${escape(subject)}</span>` : ''}<span class="ep-spacer"></span><button class="icon-only" id="epHelp" title="What this does (F1)" aria-label="What this does (F1)">${icon('help')}</button></header>
<div class="ep-banner" id="epBanner" role="alert" hidden><span class="ep-banner-text" id="epBannerText"></span><button id="epReload" class="primary">${icon('reset')}<span>Reload</span></button><button id="epDismiss">Dismiss</button></div>`;
}

/** A line of the panel's keys, such as [['Ctrl+Enter', 'preview'], ['Esc', 'close']]. */
export function editPanelKeys(keys: [string, string][]): string {
  return `<p class="ep-keys" aria-label="Keys">${keys.map(([k, what]) => `<span><kbd>${escape(k)}</kbd> ${escape(what)}</span>`).join('')}</p>`;
}

/**
 * The page side: help on the button and F1; the file-changed banner; and h2 headings marked ep-collapsible fold
 * what follows them up to the next heading, remembered in the page's state.
 */
export const editPanelScript = `
  (function () {
    const api = window.__epApi || (window.__epApi = acquireVsCodeApi());
    const help = () => api.postMessage({ type: 'help' });
    document.getElementById('epHelp')?.addEventListener('click', help);
    document.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); help(); } });
    const banner = document.getElementById('epBanner');
    document.getElementById('epDismiss')?.addEventListener('click', () => (banner.hidden = true));
    document.getElementById('epReload')?.addEventListener('click', () => api.postMessage({ type: 'reload' }));
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'stale') {
        document.getElementById('epBannerText').textContent = event.data.text;
        banner.hidden = false;
      }
      if (event.data && event.data.type === 'fresh') banner.hidden = true;
    });
    // Kept apart from the page's own state, which pages replace whole.
    const storeKey = 'epFolded:' + (document.getElementById('epTitle')?.textContent || '');
    let folded;
    try { folded = new Set(JSON.parse(localStorage.getItem(storeKey) || '[]')); } catch { folded = new Set(); }
    document.querySelectorAll('h2.ep-collapsible').forEach((h) => {
      const key = h.id || h.textContent.trim();
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      const apply = () => {
        const isFolded = folded.has(key);
        h.classList.toggle('ep-folded', isFolded);
        h.setAttribute('aria-expanded', String(!isFolded));
        for (let n = h.nextElementSibling; n && !(n.tagName === 'H2'); n = n.nextElementSibling) n.classList.toggle('ep-folded-away', isFolded);
      };
      const toggle = (e) => {
        if (e.target.closest && e.target.closest('.help')) return;
        folded.has(key) ? folded.delete(key) : folded.add(key);
        try { localStorage.setItem(storeKey, JSON.stringify([...folded])); } catch { /* without storage, folding lasts until the panel closes */ }
        apply();
      };
      h.addEventListener('click', toggle);
      h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
      apply();
    });
  })();
`;

/** The extension side: help, and a banner when the document the panel works on changes. */
export function attachEditPanel(panel: vscode.WebviewPanel, command: string, document?: vscode.TextDocument, onReload?: () => void): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [
    panel.webview.onDidReceiveMessage((message: { type: string }) => {
      if (message.type === 'help') void showHelp(command);
      else if (message.type === 'reload') onReload?.();
    }),
  ];
  if (document) {
    let warned = false;
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (warned || e.document !== document || !e.contentChanges.length) return;
        warned = true;
        void panel.webview.postMessage({ type: 'stale', text: `${vscode.workspace.asRelativePath(document.uri)} changed since this opened. Reload to work on the code as it is now.` });
      }),
    );
  }
  const all = vscode.Disposable.from(...subscriptions);
  panel.onDidDispose(() => all.dispose());
  return all;
}
