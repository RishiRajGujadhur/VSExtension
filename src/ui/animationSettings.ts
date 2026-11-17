import * as vscode from 'vscode';

/**
 * The animation settings (Code X-Ray Settings › Animations): button effects in the Actions view, and the moving grid
 * and flowing lines of the charts. Every page starts with them on its body (see webviewPage) and the pages that
 * follow them are told when they change.
 */
const section = 'tsStructure.animations';

export interface Animations {
  /** The effects hovering or clicking an action plays. */
  buttons: boolean;
  /** The charts' animated grid and flowing lines. */
  charts: boolean;
}

export function animations(): Animations {
  const config = vscode.workspace.getConfiguration(section);
  return { buttons: config.get('buttons', false), charts: config.get('charts', true) };
}

/** The body attributes a page starts with, such as data-animations-charts="off". */
export function animationAttributes(): string {
  const { buttons, charts } = animations();
  return `data-animations-buttons="${buttons ? 'on' : 'off'}" data-animations-charts="${charts ? 'on' : 'off'}"`;
}

const followers = new Set<vscode.Webview>();
let listener: vscode.Disposable | undefined;

/** Tells the page in this panel or view of every change to the animation settings, until it is closed. */
export function followAnimations(host: { readonly webview: vscode.Webview; onDidDispose: vscode.Event<void> }): void {
  followers.add(host.webview);
  host.onDidDispose(() => followers.delete(host.webview));
  // One listener for all pages, for the extension's lifetime.
  listener ??= vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(section)) return;
    const message = { type: 'animations', ...animations() };
    for (const webview of followers) void Promise.resolve(webview.postMessage(message)).then(undefined, () => undefined);
  });
}
