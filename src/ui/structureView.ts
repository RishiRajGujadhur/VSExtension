import * as path from 'path';
import * as vscode from 'vscode';
import { hashText, pathKey } from '../analysis/paths';
import { filterReport, reportMarkdown } from '../structure/markdown';
import { Report, ReportLocation, ReportNode, Tone, forEachReportNode, titleParts } from '../structure/report';
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

const stateKey = 'tsStructure.lastReport';

/** Shows analysis reports as a tree with history, filtering, result navigation and editor highlights. */
/** Settings each kind of report depends on: changing one marks the shown report as out of date. */
const scope = ['tsStructure.include', 'tsStructure.exclude'];
const settingsOf: Record<string, string[]> = {
  argumentFlow: ['tsStructure.argumentFlow'],
  assertionAudit: [...scope, 'tsStructure.typeAssertion'],
  deadExports: [...scope, 'tsStructure.deadExports'],
  duplicates: [...scope, 'tsStructure.duplicates'],
  inspectCode: [...scope, 'tsStructure.inspections.severity', 'tsStructure.customInspections', 'tsStructure.missingAwait', 'tsStructure.typeAssertion'],
  mutations: scope,
  structuralSearch: scope,
};

export class StructureView implements vscode.TreeDataProvider<ReportNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<ReportNode>;
  private history: Entry[] = [];
  private position = -1;
  private filter = '';
  /** Top-level groups hidden with Show Groups…, by label. */
  private hidden = new Set<string>();
  private roots: ReportNode[] = [];
  private readonly parents = new Map<ReportNode, ReportNode | undefined>();
  private located: ReportNode[] = [];
  private cursor = -1;
  private stale = false;
  private settingsChanged = false;
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsStructure.highlightResults')) {
          this.highlight();
        }
        const kind = this.report?.kind;
        if (kind && !this.settingsChanged && (settingsOf[kind] ?? []).some((key) => e.affectsConfiguration(key))) {
          this.settingsChanged = true;
          this.updateMessage();
        }
      }),
      ...Object.values(this.decorations),
    ];
  }

  async show(report: Report, rerun?: Rerun): Promise<void> {
    // A new report drops any history ahead of the current one, like browser navigation.
    const config = vscode.workspace.getConfiguration('tsStructure.results');
    const historySize = Math.max(1, config.get('historySize', 20));
    this.history = [...this.history.slice(0, this.position + 1), { report, rerun }].slice(-historySize);
    this.position = this.history.length - 1;
    this.filter = '';
    this.hidden.clear();
    this.render();
    void this.memento?.update(stateKey, report);
    if (config.get('focusView', true)) {
      await vscode.commands.executeCommand('tsStructure.report.focus');
    } else if (!this.view.visible) {
      void vscode.window.setStatusBarMessage(`$(list-tree) ${titleParts(report).heading} is ready in the TypeScript Structure view`, 5000);
    }
    const focused = this.located.find((node) => node.focus);
    if (focused) {
      this.cursor = this.located.indexOf(focused);
      // Best effort: the tree may already show a newer report (or other groups) by the time this runs.
      await Promise.resolve(this.view.reveal(focused, { select: true, focus: false, expand: true })).catch(() => undefined);
    }
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
      this.hidden.clear();
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
      this.render(true);
    }
  }

  /** Chooses which top-level groups to show, such as only Calls and Writes of a usage search. */
  async chooseGroups(labels?: string[]): Promise<void> {
    const groups = (this.report?.roots ?? []).filter((r) => r.children?.length).map((r) => r.label);
    if (groups.length === 0) {
      return;
    }
    const chosen =
      labels ??
      (
        await vscode.window.showQuickPick(
          groups.map((label) => ({ label, picked: !this.hidden.has(label) })),
          { title: 'Show Groups', canPickMany: true, placeHolder: 'Groups to show in the report' },
        )
      )?.map((item) => item.label);
    if (chosen) {
      this.hidden = new Set(groups.filter((g) => !chosen.includes(g)));
      this.render(true);
    }
  }

  /** Shows the current report; `kept` is for a new filter or set of groups on the same report, which keeps its banners. */
  private render(kept = false): void {
    const report = this.report;
    this.roots = report ? filterReport(report.roots, this.filter).filter((r) => !this.hidden.has(r.label)) : [];
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
    if (!kept) {
      this.stale = false;
      this.settingsChanged = false;
      // A report from the history, or restored after a reload, may already be out of date.
      for (const document of vscode.workspace.textDocuments) {
        this.checkStale(document);
      }
    }
    // VS Code capitalizes every word of a view title, which mangles names like cart.ts, so the subject goes in the message.
    this.view.title = titleParts(report).heading;
    this.view.description = [this.filter ? `filtered: “${this.filter}”` : '', this.hidden.size ? `${this.hidden.size} hidden` : ''].filter(Boolean).join(' · ') || undefined;
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
      ...(report ? [summaryLine(report)] : []),
      ...(this.stale ? ['Files changed since this analysis ran; re-run it to refresh the results.'] : []),
      ...(this.settingsChanged && !this.stale ? ['Settings changed since this analysis ran; re-run it to apply them.'] : []),
      ...(report?.warnings ?? []),
      ...(report && this.roots.length === 0 ? [this.filter ? `No rows match “${this.filter}”.` : 'Nothing found.'] : []),
    ];
    this.view.message = messages.length ? messages.join('\n') : undefined;
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

  /** Expands every row, three levels deep at a time (the most a tree view reveals at once). */
  async expandAll(): Promise<void> {
    const expand = async (nodes: readonly ReportNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (node.children?.length) {
          await Promise.resolve(this.view.reveal(node, { expand: 3, select: false, focus: false })).catch(() => undefined);
          if (depth % 3 === 2) {
            await expand(node.children, depth + 1);
          } else {
            await expand(node.children.filter((c) => c.children?.length), depth + 1);
          }
        }
      }
    };
    await expand(this.roots, 0);
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

/** "total · 3 definitions, 1 check · 12 ms": what the report is about, its summary and how long it took. */
function summaryLine(report: Report): string {
  const timing = report.durationMs === undefined ? '' : report.durationMs < 1000 ? `${report.durationMs} ms` : `${(report.durationMs / 1000).toFixed(1)} s`;
  return [titleParts(report).subject, report.description, timing].filter(Boolean).join(' · ');
}
