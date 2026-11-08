import * as vscode from 'vscode';
import { actionCatalog, actionTabs, mostUsed } from '../structure/actionCatalog';
import { featureOf } from '../structure/features';
import { commandIcons } from '../structure/icons';
import { Keybinding, shortcuts } from '../structure/keys';
import { isFeatureEnabled } from './features';
import { webviewPage, webviewRoots } from './webviewPage';

const usageKey = 'tsStructure.actionUsage';

/** Counts a use of an action, for the Most Used section; Analyze or Refactor This counts too. */
export function recordActionUse(memento: vscode.Memento, command: string): void {
  const usage = memento.get<Record<string, number>>(usageKey) ?? {};
  usage[command] = (usage[command] ?? 0) + 1;
  void memento.update(usageKey, usage);
}

/**
 * The Actions view at the top of the Code X-Ray sidebar: every analysis and edit, searchable, in Analyze and Edit
 * tabs, with the most used ones first and the rest by category. Running one acts on the editor's cursor.
 */
export class ActionsView implements vscode.WebviewViewProvider {
  static readonly viewType = 'tsStructure.actions';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly keybindings: readonly Keybinding[],
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ActionsView.viewType, this),
      // Turning a feature on or off shows or hides its actions.
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tsStructure.features') && this.post()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    view.webview.html = html(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (message: { type: string; command?: string }) => {
      if (message.type === 'ready') {
        this.post();
      } else if (message.type === 'run' && message.command && (actionCatalog.some((a) => a.command === message.command) || footer.some((f) => f.command === message.command))) {
        if (actionCatalog.some((a) => a.command === message.command)) {
          recordActionUse(this.memento, message.command);
          this.post();
        }
        await vscode.commands.executeCommand(message.command);
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.post());
  }

  private post(): void {
    if (!this.view) return;
    const keys = shortcuts(this.keybindings);
    const actions = actionCatalog
      .filter((a) => {
        const feature = featureOf(a.command);
        return !feature || isFeatureEnabled(feature.id);
      })
      .map((a) => ({ ...a, icon: a.icon ?? commandIcons[a.command] ?? 'symbol-misc', key: keys.get(a.command) }));
    const usage = this.memento.get<Record<string, number>>(usageKey) ?? {};
    const mostUsedByTab = Object.fromEntries(actionTabs.map((t) => [t.id, mostUsed(usage, actions.filter((a) => a.tab === t.id).map((a) => a.command))]));
    void this.view.webview.postMessage({ type: 'actions', actions, tabs: actionTabs, mostUsed: mostUsedByTab, usedOnce: Object.values(usage).some((n) => n > 0), footer });
  }
}

/** Links under the list: help to find the right action, and settings. */
const footer = [
  { command: 'tsStructure.howDoI', label: 'How Do I…?', icon: 'question' },
  { command: 'tsStructure.guideMe', label: 'Guide Me', icon: 'book' },
  { command: 'tsStructure.editKeybindings', label: 'Shortcuts', icon: 'keyboard' },
  { command: 'tsStructure.configureFeatures', label: 'Features…', icon: 'extensions' },
];

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return webviewPage(webview, extensionUri, { title: 'Actions', styles: ['actions.css'], scripts: ['actions.js'], body: `<div id="tabs" role="tablist" aria-label="Kinds of actions"></div>
<div class="search">
  <i class="codicon codicon-search" aria-hidden="true"></i>
  <input id="search" type="search" placeholder="Search actions…" aria-label="Search actions" aria-controls="list">
</div>
<div id="list" role="region" aria-live="polite" aria-label="Actions"></div>
<nav id="footer" aria-label="Help and settings"></nav>` });
}
