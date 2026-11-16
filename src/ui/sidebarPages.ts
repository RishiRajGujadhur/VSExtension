import * as vscode from 'vscode';
import { webviewPage, webviewRoots } from './webviewPage';

/**
 * The two sidebar views' pages, and a light stand-in that opens them as soon as the extension starts, while the rest of
 * the extension (TypeScript and every feature) loads. Once loaded, each view's real provider takes over the page already open.
 */

export const actionsViewType = 'tsStructure.actions';
export const resultViewType = 'tsStructure.valuePath';

const options = (extensionUri: vscode.Uri): vscode.WebviewOptions => ({ enableScripts: true, localResourceRoots: webviewRoots(extensionUri) });

export function actionsPage(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return webviewPage(webview, extensionUri, { title: 'Actions', styles: ['actions.css'], scripts: ['actions.js'], body: `<div class="top">
<div id="tabs" role="tablist" aria-label="Kinds of actions"></div>
<div class="search">
  <i class="codicon codicon-search" aria-hidden="true"></i>
  <input id="search" type="search" placeholder="Search actions or shortcuts (/)" aria-label="Search actions" aria-controls="list" aria-describedby="found">
  <button id="clear" class="clear" title="Clear Search (Escape)" aria-label="Clear search" hidden><i class="codicon codicon-close" aria-hidden="true"></i></button>
</div>
<div id="found" class="visually-hidden" role="status" aria-live="polite"></div>
</div>
<div id="tip-hint" class="hint" hidden></div>
<div id="list" aria-label="Actions"></div>
<nav id="footer" aria-label="Help and settings"></nav>
<div id="tip" role="tooltip" hidden></div>
<div id="menu" role="menu" hidden></div>` });
}

export function resultPage(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return webviewPage(webview, extensionUri, { title: 'Result', styles: ['valuePath.css'], scripts: ['valuePath.js'], body: '<main id="card"></main>' });
}

/**
 * Opens the page in the view, unless it is already open there (VS Code keeps the page when the same HTML is set again).
 * Then asks the page to say it is ready again, in case it did before anyone was listening.
 */
export function openPage(view: vscode.WebviewView, extensionUri: vscode.Uri, page: (webview: vscode.Webview, extensionUri: vscode.Uri) => string): void {
  const html = page(view.webview, extensionUri);
  if (view.webview.html !== html) {
    view.webview.options = options(extensionUri);
    view.webview.html = html;
  }
}

/** Asks an open page to send 'ready' again: it may have done so before its provider was listening. */
export function greet(view: vscode.WebviewView): void {
  void Promise.resolve(view.webview.postMessage({ type: 'hello' })).then(undefined, () => undefined);
}

/** The sidebar views' stand-in until the extension has loaded. */
export class EarlyViews {
  private readonly views = new Map<string, vscode.WebviewView>();
  private readonly providers = new Map<string, vscode.WebviewViewProvider>();
  private firstOpened!: () => void;
  /** Settles once a view has been opened. */
  readonly opened = new Promise<void>((resolve) => (this.firstOpened = resolve));

  constructor(context: vscode.ExtensionContext) {
    const pages: [string, typeof actionsPage][] = [[actionsViewType, actionsPage], [resultViewType, resultPage]];
    for (const [viewType, page] of pages) {
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(viewType, {
          resolveWebviewView: (view, resolveContext, token) => {
            const provider = this.providers.get(viewType);
            if (provider) return provider.resolveWebviewView(view, resolveContext, token);
            openPage(view, context.extensionUri, page);
            this.views.set(viewType, view);
            view.onDidDispose(() => this.views.get(viewType) === view && this.views.delete(viewType));
            this.firstOpened();
          },
        }),
      );
    }
  }

  /** The real provider for a view, from now on; a page already open is handed to it. */
  hand(viewType: string, provider: vscode.WebviewViewProvider): void {
    this.providers.set(viewType, provider);
    const view = this.views.get(viewType);
    this.views.delete(viewType);
    if (view) {
      const cancelled = new vscode.CancellationTokenSource();
      void provider.resolveWebviewView(view, { state: undefined }, cancelled.token);
    }
  }
}
