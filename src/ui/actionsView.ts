import * as vscode from 'vscode';
import { ActionLayout, actionCatalog, actionId, actionTabs, changeLayout, LayoutChange, mostUsed, normalizeLayout, sectionIds } from '../structure/actionCatalog';
import { graphCategories } from '../structure/actionCatalog';
import { fittingAt } from './analysisActions';
import { languageSelector } from './refactorCommands';
import { pickGraph, runEntry } from './graphSwitch';
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

const entryOf = (id: unknown) => (typeof id === 'string' ? actionCatalog.find((a) => actionId(a) === id) : undefined);
const isAction = (id: unknown): id is string => !!entryOf(id);

/**
 * The Actions view at the top of the Code X-Ray sidebar: every analysis and edit, searchable, in Analyze and Edit
 * tabs, with pinned and most used ones first and the rest by category. Actions can be pinned, reordered and hidden;
 * the arrangement is kept in global state and synced with Settings Sync. Running one acts on the editor's cursor.
 */
export class ActionsView implements vscode.WebviewViewProvider {
  static readonly viewType = 'tsStructure.actions';
  private view: vscode.WebviewView | undefined;
  private userKeybindings: vscode.Uri | undefined;
  /** keybindings.json as last read; read again only when the file changes. */
  private userBindingsCache: ReturnType<typeof parseKeybindingsJson> | undefined;

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
    const refresh = () => {
      this.userBindingsCache = undefined;
      void this.post();
    };
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
      // The Graph Explorer: the Actions view on its Graphs tab.
      vscode.commands.registerCommand('tsStructure.graphExplorer', async () => {
        this.pendingTab = 'graphs';
        await vscode.commands.executeCommand('tsStructure.actions.focus');
        this.sendTab();
      }),
      vscode.commands.registerCommand('tsStructure.openGraph', () => pickGraph()),
      // The graphs that fit the symbol at the cursor, shown at the top of the Graphs tab.
      vscode.window.onDidChangeTextEditorSelection(() => this.cursorSoon()),
      vscode.window.onDidChangeActiveTextEditor(() => this.cursorSoon()),
    );
  }

  private pendingTab: string | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;

  private sendTab(): void {
    if (this.view && this.pendingTab) {
      void this.view.webview.postMessage({ type: 'tab', id: this.pendingTab });
      this.pendingTab = undefined;
    }
  }

  /** What fits the cursor, a moment after it stops moving, while the view is visible. */
  private cursorSoon(): void {
    clearTimeout(this.cursorTimer);
    if (!this.view?.visible) return;
    this.cursorTimer = setTimeout(() => this.sendCursor(), 250);
  }

  private sendCursor(): void {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    const source = !!editor && vscode.languages.match(languageSelector, editor.document) > 0;
    const fits = source ? fittingAt(editor!.document, editor!.document.offsetAt(editor!.selection.active)) : [];
    void this.view.webview.postMessage({ type: 'cursor', fits, hasEditor: source });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    view.webview.html = html(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (message: { type: string; id?: unknown; command?: unknown; change?: LayoutChange }) => {
      if (message.type === 'ready') {
        void this.post().then(() => {
          this.sendCursor();
          this.sendTab();
        });
      } else if (message.type === 'run' && entryOf(message.id)) {
        const entry = entryOf(message.id)!;
        recordActionUse(this.memento, actionId(entry));
        void this.post();
        // A graph of the Graphs tab: the report it makes is drawn as a chart.
        await runEntry(entry);
      } else if (message.type === 'run' && footer.some((f) => f.command === message.command)) {
        await vscode.commands.executeCommand(message.command as string);
      } else if (message.type === 'layout' && message.change && typeof message.change === 'object') {
        this.change(message.change);
      } else if (message.type === 'changeShortcut' && typeof message.command === 'string' && actionCatalog.some((a) => a.command === message.command)) {
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@command:${message.command}`);
      } else if (message.type === 'copyId' && typeof message.command === 'string' && actionCatalog.some((a) => a.command === message.command)) {
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
    if (this.userBindingsCache) return this.userBindingsCache;
    try {
      this.userBindingsCache = parseKeybindingsJson(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.userKeybindings)));
    } catch {
      this.userBindingsCache = [];
    }
    return this.userBindingsCache;
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
      .map((a) => ({ ...a, id: actionId(a), icon: a.icon ?? commandIcons[a.command] ?? 'symbol-misc', key: keys.get(a.command) }));
    const usage = this.memento.get<Record<string, number>>(usageKey) ?? {};
    // Most Used leaves out what is already pinned, and what is hidden.
    const candidates = (tab: string) => actions.filter((a) => a.tab === tab && !layout.pinned.includes(a.id) && !layout.hidden.includes(a.id)).map((a) => a.id);
    const mostUsedByTab = Object.fromEntries(actionTabs.map((t) => [t.id, mostUsed(usage, candidates(t.id))]));
    void this.view.webview.postMessage({ type: 'actions', actions, tabs: actionTabs, mostUsed: mostUsedByTab, usage, usedOnce: Object.values(usage).some((n) => n > 0), footer, layout, categories: graphCategories });
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
