import * as vscode from 'vscode';
import { ActionLayout, actionCatalog, actionTabs, changeLayout, LayoutChange, mostUsed, normalizeLayout, sectionIds } from '../structure/actionCatalog';
import { featureOf } from '../structure/features';
import { commandIcons } from '../structure/icons';
import { effectiveKeybindings, Keybinding, parseKeybindingsJson, shortcuts } from '../structure/keys';
import { isFeatureEnabled } from './features';
import { webviewPage, webviewRoots } from './webviewPage';

const usageKey = 'tsStructure.actionUsage';
const layoutKey = 'tsStructure.actionsLayout';

/** Counts a use of an action, for the Most Used section; Analyze or Refactor This counts too. */
export function recordActionUse(memento: vscode.Memento, command: string): void {
  const usage = memento.get<Record<string, number>>(usageKey) ?? {};
  usage[command] = (usage[command] ?? 0) + 1;
  void memento.update(usageKey, usage);
}

const isAction = (command: unknown): command is string => typeof command === 'string' && actionCatalog.some((a) => a.command === command);

/**
 * The Actions view at the top of the Code X-Ray sidebar: every analysis and edit, searchable, in Analyze and Edit
 * tabs, with pinned and most used ones first and the rest by category. Actions can be pinned, reordered and hidden;
 * the arrangement is kept in global state and synced with Settings Sync. Running one acts on the editor's cursor.
 */
export class ActionsView implements vscode.WebviewViewProvider {
  static readonly viewType = 'tsStructure.actions';
  private view: vscode.WebviewView | undefined;
  private userKeybindings: vscode.Uri | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly keybindings: readonly Keybinding[],
  ) {}

  register(context: vscode.ExtensionContext): void {
    // keybindings.json sits in the User folder, two above this extension's global storage.
    this.userKeybindings = vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'keybindings.json');
    context.globalState.setKeysForSync([usageKey, layoutKey]);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(this.userKeybindings, '..'), 'keybindings.json'));
    const refresh = () => this.post();
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ActionsView.viewType, this),
      // Turning a feature on or off shows or hides its actions.
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tsStructure.features') && this.post()),
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh),
      vscode.commands.registerCommand('tsStructure.actions.collapseAll', () => this.toggleAllSections()),
      vscode.commands.registerCommand('tsStructure.actions.toggleDescriptions', () => this.change({ kind: 'compact', value: !this.layout().compact })),
      vscode.commands.registerCommand('tsStructure.actions.toggleMostUsed', () => this.change({ kind: 'hideMostUsed', value: !this.layout().hideMostUsed })),
      vscode.commands.registerCommand('tsStructure.actions.showHidden', () => this.change({ kind: 'showAll' })),
      vscode.commands.registerCommand('tsStructure.actions.reset', () => this.reset()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    view.webview.html = html(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (message: { type: string; command?: unknown; change?: LayoutChange }) => {
      if (message.type === 'ready') {
        this.post();
      } else if (message.type === 'run' && (isAction(message.command) || footer.some((f) => f.command === message.command))) {
        const command = message.command as string;
        if (isAction(command)) {
          recordActionUse(this.memento, command);
          this.post();
        }
        await vscode.commands.executeCommand(command);
      } else if (message.type === 'layout' && message.change && typeof message.change === 'object') {
        this.change(message.change);
      } else if (message.type === 'changeShortcut' && isAction(message.command)) {
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@command:${message.command}`);
      } else if (message.type === 'copyId' && isAction(message.command)) {
        await vscode.env.clipboard.writeText(message.command);
        void vscode.window.setStatusBarMessage(`Copied ${message.command}`, 3000);
      } else if (message.type === 'reset') {
        await this.reset();
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.post());
  }

  private layout(): ActionLayout {
    return normalizeLayout(this.memento.get(layoutKey));
  }

  private change(change: LayoutChange): void {
    void this.memento.update(layoutKey, changeLayout(this.layout(), change)).then(() => this.post());
  }

  /** Folds every section, or unfolds them all when all are folded. */
  private toggleAllSections(): void {
    const layout = this.layout();
    const ids = [sectionIds.pinned, sectionIds.mostUsed, sectionIds.hidden, ...new Set(actionCatalog.map((a) => `category:${a.category}`))];
    const allFolded = ids.every((id) => layout.collapsed.includes(id));
    this.change({ kind: 'setCollapsed', ids: allFolded ? [] : ids });
  }

  private async reset(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Reset the Actions view? Pinned and hidden actions, folded sections and the Most Used counts all go back to the start.',
      { modal: true },
      'Reset',
    );
    if (choice !== 'Reset') return;
    await this.memento.update(layoutKey, undefined);
    await this.memento.update(usageKey, undefined);
    this.post();
  }

  /** The user's keybindings.json, or nothing when there is none or it can't be read. */
  private async userBindings() {
    if (!this.userKeybindings) return [];
    try {
      return parseKeybindingsJson(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.userKeybindings)));
    } catch {
      return [];
    }
  }

  private async post(): Promise<void> {
    if (!this.view) return;
    const keys = shortcuts(effectiveKeybindings(this.keybindings, await this.userBindings()));
    const layout = this.layout();
    const actions = actionCatalog
      .filter((a) => {
        const feature = featureOf(a.command);
        return !feature || isFeatureEnabled(feature.id);
      })
      .map((a) => ({ ...a, icon: a.icon ?? commandIcons[a.command] ?? 'symbol-misc', key: keys.get(a.command) }));
    const usage = this.memento.get<Record<string, number>>(usageKey) ?? {};
    // Most Used leaves out what is already pinned, and what is hidden.
    const candidates = (tab: string) => actions.filter((a) => a.tab === tab && !layout.pinned.includes(a.command) && !layout.hidden.includes(a.command)).map((a) => a.command);
    const mostUsedByTab = Object.fromEntries(actionTabs.map((t) => [t.id, mostUsed(usage, candidates(t.id))]));
    void this.view.webview.postMessage({ type: 'actions', actions, tabs: actionTabs, mostUsed: mostUsedByTab, usage, usedOnce: Object.values(usage).some((n) => n > 0), footer, layout });
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
