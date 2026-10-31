import * as path from 'path';
import * as vscode from 'vscode';
import { hashText, pathKey } from '../analysis/paths';
import { filterReport, reportMarkdown } from '../structure/markdown';
import { Report, ReportLocation, ReportNode, Tone, forEachReportNode } from '../structure/report';
import { currentHash } from '../resultsView';

const toneColors: Record<Tone, string> = {
  error: 'problemsErrorIcon.foreground',
  warning: 'problemsWarningIcon.foreground',
  info: 'problemsInfoIcon.foreground',
  ok: 'testing.iconPassed',
};

type Rerun = () => Thenable<Report | undefined>;

interface Entry {
  report: Report;
  rerun?: Rerun;
}

const maxHistory = 20;
const stateKey = 'tsStructure.lastReport';

/** Shows analysis reports as a tree with history, filtering, result navigation and editor highlights. */
export class StructureView implements vscode.TreeDataProvider<ReportNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<ReportNode>;
  private history: Entry[] = [];
  private position = -1;
  private filter = '';
  private roots: ReportNode[] = [];
  private readonly parents = new Map<ReportNode, ReportNode | undefined>();
  private located: ReportNode[] = [];
  private cursor = -1;
  private stale = false;
  private readonly decorations = {
    read: vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center }),
    write: vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center }),
    definition: vscode.window.createTextEditorDecorationType({ border: '1px solid', borderColor: new vscode.ThemeColor('editor.wordHighlightTextBorder'), fontWeight: 'bold' }),
  };

  constructor(private readonly memento?: vscode.Memento) {
    this.view = vscode.window.createTreeView('tsStructure.report', { treeDataProvider: this, showCollapseAll: true });
    const saved = memento?.get<Report>(stateKey);
    if (saved) {
      this.history = [{ report: saved }];
      this.position = 0;
      this.render();
    }
  }

  get report(): Report | undefined {
    return this.history[this.position]?.report;
  }

  /** Disposables for editor and document listeners. */
  listeners(): vscode.Disposable[] {
    return [
      vscode.window.onDidChangeVisibleTextEditors(() => this.highlight()),
      vscode.workspace.onDidChangeTextDocument((e) => this.checkStale(e.document)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tsStructure.highlightResults') && this.highlight()),
      ...Object.values(this.decorations),
    ];
  }

  async show(report: Report, rerun?: Rerun): Promise<void> {
    // A new report drops any history ahead of the current one, like browser navigation.
    this.history = [...this.history.slice(0, this.position + 1), { report, rerun }].slice(-maxHistory);
    this.position = this.history.length - 1;
    this.filter = '';
    this.render();
    void this.memento?.update(stateKey, report);
    await vscode.commands.executeCommand('tsStructure.report.focus');
  }

  clear(): void {
    this.history = [];
    this.position = -1;
    this.filter = '';
    this.render();
    void this.memento?.update(stateKey, undefined);
  }

  go(delta: number): void {
    const next = this.position + delta;
    if (next >= 0 && next < this.history.length) {
      this.position = next;
      this.filter = '';
      this.render();
    }
  }

  async rerun(): Promise<void> {
    const entry = this.history[this.position];
    if (!entry?.rerun) {
      void vscode.window.showInformationMessage('This report was restored from an earlier session; run the analysis again from the editor.');
      return;
    }
    const report = await entry.rerun();
    if (report) {
      // Replace the entry in place: a refreshed report is not a new step in the history.
      this.history[this.position] = { report, rerun: entry.rerun };
      this.render();
      void this.memento?.update(stateKey, report);
    }
  }

  async setFilter(): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'Filter Analysis Results', value: this.filter, placeHolder: 'Text in a row label or description; empty to clear' });
    if (value !== undefined) {
      this.filter = value;
      this.render();
    }
  }

  private render(): void {
    const report = this.report;
    this.roots = report ? filterReport(report.roots, this.filter) : [];
    this.parents.clear();
    this.located = [];
    this.cursor = -1;
    const index = (nodes: readonly ReportNode[], parent?: ReportNode) => {
      for (const node of nodes) {
        this.parents.set(node, parent);
        if (node.location) {
          this.located.push(node);
        }
        index(node.children ?? [], node);
      }
    };
    index(this.roots);
    this.stale = false;
    this.view.title = report ? report.title : 'Analysis';
    const timing = report?.durationMs !== undefined ? ` · ${report.durationMs < 1000 ? `${report.durationMs} ms` : `${(report.durationMs / 1000).toFixed(1)} s`}` : '';
    this.view.description = report ? `${this.filter ? `filtered: “${this.filter}” · ` : ''}${report.description ?? ''}${timing}` : undefined;
    this.updateMessage();
    let problems = 0;
    forEachReportNode(report?.roots ?? [], (node) => {
      if ((node.tone === 'error' || node.tone === 'warning') && !node.children?.length) {
        problems++;
      }
    });
    this.view.badge = problems ? { value: problems, tooltip: `${problems} rows need attention` } : undefined;
    void vscode.commands.executeCommand('setContext', 'tsStructure.hasReport', !!report);
    void vscode.commands.executeCommand('setContext', 'tsStructure.canGoBack', this.position > 0);
    void vscode.commands.executeCommand('setContext', 'tsStructure.canGoForward', this.position < this.history.length - 1);
    void vscode.commands.executeCommand('setContext', 'tsStructure.filtered', !!this.filter);
    this.changed.fire();
    this.highlight();
  }

  private updateMessage(): void {
    const report = this.report;
    const messages = [
      ...(this.stale ? ['Files changed since this analysis ran; re-run it to refresh the results.'] : []),
      ...(report?.warnings ?? []),
      ...(report && this.roots.length === 0 ? [this.filter ? `No rows match “${this.filter}”.` : 'Nothing found.'] : []),
    ];
    this.view.message = messages.length ? messages.join(' ') : undefined;
  }

  private checkStale(document: vscode.TextDocument): void {
    const expected = this.report?.fileHashes[document.uri.fsPath.replace(/\\/g, '/')] ?? this.findHash(document.uri.fsPath);
    if (!this.stale && expected && expected !== hashText(document.getText())) {
      this.stale = true;
      this.updateMessage();
    }
  }

  private findHash(fileName: string): string | undefined {
    const key = pathKey(fileName);
    const entry = Object.entries(this.report?.fileHashes ?? {}).find(([file]) => pathKey(file) === key);
    return entry?.[1];
  }

  /** Marks the report's locations in visible editors, colored by how each one uses the analyzed value. */
  private highlight(): void {
    const enabled = vscode.workspace.getConfiguration('tsStructure').get('highlightResults', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges: Record<keyof typeof this.decorations, vscode.Range[]> = { read: [], write: [], definition: [] };
      if (enabled && this.report && !this.stale) {
        const key = pathKey(editor.document.uri.fsPath);
        forEachReportNode(this.report.roots, (node) => {
          if (node.role && node.location && pathKey(node.location.file) === key) {
            ranges[node.role].push(new vscode.Range(node.location.line, node.location.character, node.location.endLine, node.location.endCharacter));
          }
        });
      }
      for (const role of Object.keys(ranges) as (keyof typeof this.decorations)[]) {
        editor.setDecorations(this.decorations[role], ranges[role]);
      }
    }
  }

  getChildren(node?: ReportNode): ReportNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getParent(node: ReportNode): ReportNode | undefined {
    return this.parents.get(node);
  }

  getTreeItem(node: ReportNode): vscode.TreeItem {
    const state = node.children?.length
      ? node.expanded || this.filter
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, state);
    item.description = node.description;
    const where = node.location ? `\n\n${vscode.workspace.asRelativePath(node.location.file)}:${node.location.line + 1}` : '';
    item.tooltip = new vscode.MarkdownString(`${node.tooltip ?? node.label}${where}`);
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon, node.tone ? new vscode.ThemeColor(toneColors[node.tone]) : undefined);
    }
    if (node.location) {
      item.command = { command: 'tsStructure.openLocation', title: 'Open', arguments: [node.location] };
    }
    item.contextValue = [node.location ? 'location' : '', node.action ? `action:${node.action.kind}` : ''].filter(Boolean).join(' ');
    return item;
  }

  /** Opens the next (or previous) row with a location, revealing it in the tree. */
  async step(delta: 1 | -1): Promise<void> {
    if (this.located.length === 0) {
      return;
    }
    this.cursor = (this.cursor + delta + this.located.length) % this.located.length;
    const node = this.located[this.cursor];
    await this.view.reveal(node, { select: true, focus: false, expand: true });
    await this.open(node.location!);
  }

  markdown(): string | undefined {
    const report = this.report;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return report ? reportMarkdown(report, root, this.roots) : undefined;
  }

  /** Opens a row's location unless its file changed after the analysis, which would make the position unreliable. */
  async open(location: ReportLocation, sideBySide = false): Promise<void> {
    const expected = this.findHash(location.file);
    const uri = vscode.Uri.file(location.file);
    if (expected && currentHash(uri) !== expected) {
      const choice = await vscode.window.showWarningMessage(
        `${path.basename(location.file)} has changed since the analysis ran, so this result may point to the wrong place.`,
        'Re-run Analysis',
        'Open Anyway',
      );
      if (choice === 'Re-run Analysis') {
        await this.rerun();
        return;
      }
      if (choice !== 'Open Anyway') {
        return;
      }
    }
    const selection = new vscode.Range(location.line, location.character, location.endLine, location.endCharacter);
    await vscode.window.showTextDocument(uri, { selection, preview: !sideBySide, viewColumn: sideBySide ? vscode.ViewColumn.Beside : undefined });
  }
}
