import * as vscode from 'vscode';
import { featureName, showHelp } from './editFlow';
import { icon } from './webviewStyle';

/**
 * The shared look of the Edit features that open a panel (Change parameters, Search by shape): a header with an icon
 * tile, the feature's name, what it works on, a line on what it does, a status pill and a help button; rounded
 * fields; sections that fold and remember it; a bar of keyboard shortcuts that folds; and the main buttons in a bar
 * that stays at the bottom. A banner shows when the file changes underneath.
 */
export const editPanelCss = `
  body { padding: 0 20px 0; }
  .ep-head { display: flex; align-items: flex-start; gap: 12px; margin: 0 -20px 18px; padding: 18px 20px 16px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .25)); }
  .ep-tile { flex: none; display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent); color: var(--vscode-textLink-foreground); }
  .ep-titles { flex: 1; min-width: 0; }
  .ep-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .ep-head h1 { margin: 0; font-size: 1.2em; font-weight: 600; }
  .ep-subject { padding: 1px 8px; border-radius: 6px; border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .35)); background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, .12));
    color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: .92em; overflow-wrap: anywhere; }
  .ep-desc { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
  .ep-desc:empty { display: none; }
  .ep-status { flex: none; display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 3px 10px; border-radius: 999px; font-size: .9em; white-space: nowrap;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .3)); background: var(--vscode-editorWidget-background, rgba(128, 128, 128, .1)); color: var(--vscode-descriptionForeground); }
  .ep-status[hidden] { display: none; }
  .ep-status .ep-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .7; }
  .ep-status.ep-changed { color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 55%, transparent); }
  .ep-status.ep-changed .ep-dot { background: var(--vscode-charts-orange, #d18616); opacity: 1; }
  .ep-head > .icon-only { margin-top: 2px; }
  .ep-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; padding: 8px 12px; border-radius: 8px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700); background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, .12)); }
  .ep-banner[hidden] { display: none; }
  .ep-banner .ep-banner-text { flex: 1; min-width: 160px; }
  /* Rounded fields and buttons, as in the rest of the panel. */
  button { min-height: 30px; padding: 5px 14px; border-radius: 6px; }
  button.icon-only { min-height: 26px; padding: 4px; border-radius: 6px; }
  button.ep-ghost { background: transparent; border-color: transparent; }
  button.ep-ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .31)); }
  button.ep-outline { background: transparent; border-color: var(--vscode-widget-border, rgba(128, 128, 128, .45)); color: var(--vscode-foreground); }
  button.ep-outline:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .31)); }
  input[type=text], input[type=search], textarea, select { border-radius: 6px; padding: 7px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128, 128, 128, .35))); }
  input[type=text]:focus, input[type=search]:focus, textarea:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .ep-label { display: block; margin: 0 0 6px; font-weight: 600; color: var(--vscode-foreground); }
  .ep-section { display: flex; align-items: center; gap: 8px; margin: 0; font-size: .85em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .ep-count { padding: 0 6px; border-radius: 5px; border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .35)); font-size: .95em; letter-spacing: 0; color: var(--vscode-foreground); }
  .ep-card { border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .3)); border-radius: 8px; background: var(--vscode-editorWidget-background, rgba(128, 128, 128, .06)); }
  .ep-collapsible { cursor: pointer; user-select: none; }
  .ep-collapsible::before { content: '▾'; display: inline-block; width: 1em; color: var(--vscode-descriptionForeground); transition: transform .1s; }
  .ep-collapsible.ep-folded::before { transform: rotate(-90deg); }
  .ep-folded-away { display: none !important; }
  /* The keyboard shortcuts fold into one bar above the buttons. */
  .ep-keys-bar { margin: 18px -20px 0; border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .25)); }
  .ep-keys-toggle { display: flex; width: 100%; gap: 8px; justify-content: flex-start; min-height: 34px; padding: 6px 20px; border: 0; border-radius: 0; background: transparent; color: var(--vscode-descriptionForeground); }
  .ep-keys-toggle:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .ep-keys-toggle .ep-spacer { flex: 1; }
  .ep-keys-toggle .ep-chev { transition: transform .1s; }
  .ep-keys-toggle[aria-expanded="true"] .ep-chev { transform: rotate(180deg); }
  .ep-keys { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 0; padding: 2px 20px 12px; color: var(--vscode-descriptionForeground); font-size: .92em; }
  .ep-keys[hidden] { display: none; }
  .ep-keys span { display: inline-flex; align-items: center; gap: 6px; }
  .ep-keys kbd { padding: 1px 6px; border: 1px solid var(--vscode-keybindingLabel-border, rgba(128, 128, 128, .4)); border-bottom-width: 2px; border-radius: 4px;
    background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, .17)); color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground)); font-family: inherit; font-size: .95em; }
  /* The main buttons stay in view at the bottom while the panel scrolls. */
  .actions.ep-sticky { position: sticky; bottom: 0; z-index: 2; margin: 0 -20px; padding: 14px 20px; border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, .25));
    background: var(--vscode-editor-background); }
  .ep-keys-bar + .actions.ep-sticky { margin-top: 0; }
  @media (forced-colors: active) { .ep-banner, .ep-subject, .ep-status, .ep-card { border: 1px solid CanvasText; } }
`;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * The header: an icon tile, the feature's name, its subject, a line on what it does, a status pill the page can fill
 * with window.epSetStatus(text, changed), and the help button (F1).
 */
export function editPanelHead(command: string, subject?: string, iconName: Parameters<typeof icon>[0] = 'apply', description = ''): string {
  return `<header class="ep-head"><span class="ep-tile">${icon(iconName)}</span><div class="ep-titles"><div class="ep-title-row"><h1 id="epTitle">${escape(featureName(command))}</h1>${subject ? `<span class="ep-subject" id="epSubject">${escape(subject)}</span>` : ''}</div><p class="ep-desc">${escape(description)}</p></div><span class="ep-status" id="epStatus" role="status" hidden><span class="ep-dot"></span><span id="epStatusText"></span></span><button class="icon-only" id="epHelp" title="What this does (F1)" aria-label="What this does (F1)">${icon('help')}</button></header>
<div class="ep-banner" id="epBanner" role="alert" hidden><span class="ep-banner-text" id="epBannerText"></span><button id="epReload" class="primary">${icon('reset')}<span>Reload</span></button><button id="epDismiss">Dismiss</button></div>`;
}

/** The panel's keys, such as [['Ctrl+Enter', 'preview'], ['Esc', 'close']], in a bar that shows them on request. */
export function editPanelKeys(keys: [string, string][]): string {
  return `<section class="ep-keys-bar"><button class="ep-keys-toggle" id="epKeysToggle" aria-expanded="false" aria-controls="epKeys">${icon('keyboard')}<span>Keyboard shortcuts</span><span class="ep-spacer"></span><span id="epKeysWord">Show</span><span class="ep-chev">${icon('chevron')}</span></button>
<p class="ep-keys" id="epKeys" aria-label="Keyboard shortcuts" hidden>${keys.map(([k, what]) => `<span><kbd>${escape(k)}</kbd>${escape(what)}</span>`).join('')}</p></section>`;
}

/**
 * The page side: help on the button and F1; the file-changed banner; the status pill; the shortcuts bar; and h2
 * headings marked ep-collapsible fold what follows them up to the next heading. Folding is remembered per feature.
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
    const save = () => { try { localStorage.setItem(storeKey, JSON.stringify([...folded])); } catch { /* without storage, folding lasts until the panel closes */ } };
    window.epSetStatus = (text, changed) => {
      const pill = document.getElementById('epStatus');
      if (!pill) return;
      pill.hidden = !text;
      pill.classList.toggle('ep-changed', !!changed);
      document.getElementById('epStatusText').textContent = text || '';
    };
    const keysToggle = document.getElementById('epKeysToggle');
    if (keysToggle) {
      const keys = document.getElementById('epKeys');
      const show = (open) => {
        keys.hidden = !open;
        keysToggle.setAttribute('aria-expanded', String(open));
        document.getElementById('epKeysWord').textContent = open ? 'Hide' : 'Show';
      };
      show(folded.has('#keys'));
      keysToggle.addEventListener('click', () => {
        folded.has('#keys') ? folded.delete('#keys') : folded.add('#keys');
        save();
        show(folded.has('#keys'));
      });
    }
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
        save();
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
