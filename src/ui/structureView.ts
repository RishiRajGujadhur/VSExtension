import * as path from 'path';
import * as vscode from 'vscode';
import { hashText, pathKey } from '../analysis/paths';
import { filterReport, reportMarkdown } from '../structure/markdown';
import { Report, ReportLocation, ReportNode, Tone, forEachReportNode, titleParts } from '../structure/report';
import { currentHash } from '../resultsView';
import { countResults, limitReport } from '../structure/scope';
import { countFixes, rowFix } from '../structure/fixes';
import { reportIcons } from '../structure/icons';

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

/** Before 0.11 only the last report was kept, under this key. */
const legacyStateKey = 'tsStructure.lastReport';
const historyKey = 'tsStructure.reportHistory';
/** Reports kept across reloads; older ones are only kept for the session, to keep workspace state small. */
const persistedReports = 10;

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
  /** Limit Results to Scope: only rows in some folders, files or lines. */
  private limit: { label: string; inside: (location: ReportLocation) => boolean } | undefined;
  /** The current report's file hashes by path key, for the checks on every edit. */
  private hashIndex: { report?: Report; byKey: Map<string, string> } = { byKey: new Map() };
  /** Top-level groups hidden with Show Groups…, by label. */
  private hidden = new Set<string>();
  private roots: ReportNode[] = [];
  private readonly parents = new Map<ReportNode, ReportNode | undefined>();
  private located: ReportNode[] = [];
  private cursor = -1;
  private stale = false;
  private settingsChanged = false;
  /** Rows acted on from the view since the report was shown, such as "fixed", by rowKey. */
  private done = new Map<string, string>();
  private readonly decorations = {
    read: vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center }),
    write: vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center }),
    definition: vscode.window.createTextEditorDecorationType({ border: '1px solid', borderColor: new vscode.ThemeColor('editor.wordHighlightTextBorder'), fontWeight: 'bold' }),
  };

  constructor(private readonly memento?: vscode.Memento) {
    this.view = vscode.window.createTreeView('tsStructure.report', { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
    const saved = memento?.get<{ reports: Report[]; position: number }>(historyKey);
    const legacy = memento?.get<Report>(legacyStateKey);
    const reports = saved?.reports ?? (legacy ? [legacy] : []);
    if (reports.length > 0) {
      this.history = reports.map((report) => ({ report }));
      this.position = Math.min(Math.max(saved?.position ?? 0, 0), reports.length - 1);
      this.render();
    }
  }

  /** Saves the history, so Back, Forward and Show Analysis History work after a reload. */
  private persist(): void {
    const start = Math.max(0, this.history.length - persistedReports);
    const reports = this.history.slice(start).map((entry) => entry.report);
    void this.memento?.update(historyKey, reports.length ? { reports, position: Math.max(0, this.position - start) } : undefined);
    void this.memento?.update(legacyStateKey, undefined);
  }

  get report(): Report | undefined {
    return this.history[this.position]?.report;
  }

  /** Disposables for editor and document listeners. */
  listeners(): vscode.Disposable[] {
    return [
      vscode.window.onDidChangeVisibleTextEditors(() => this.highlight()),
      vscode.workspace.onDidChangeTextDocument((e) => this.checkStale(e.document)),
      vscode.workspace.onDidSaveTextDocument((document) => this.rerunOnSave(document)),
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
    this.limit = undefined;
    this.hidden.clear();
    this.render();
    this.persist();
    if (config.get('focusView', true)) {
      await vscode.commands.executeCommand('tsStructure.report.focus');
    } else if (!this.view.visible) {
      void vscode.window.setStatusBarMessage(`$(${reportIcons[report.kind] ?? 'list-tree'}) ${titleParts(report).heading} is ready in the TypeScript Structure view`, 5000);
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
    this.limit = undefined;
    this.render();
    this.persist();
  }

  go(delta: number): void {
    const next = this.position + delta;
    if (next >= 0 && next < this.history.length) {
      this.position = next;
      this.filter = '';
      this.limit = undefined;
      this.hidden.clear();
      this.render();
      this.persist();
    }
  }

  private rerunTimer: NodeJS.Timeout | undefined;

  /** With `tsStructure.results.rerunOnSave`, saving a file the report covers refreshes it, once per burst of saves. */
  private rerunOnSave(document: vscode.TextDocument): void {
    const entry = this.history[this.position];
    if (!entry?.rerun || !this.stale || !this.findHash(document.uri.fsPath) || !vscode.workspace.getConfiguration('tsStructure.results').get('rerunOnSave', false)) {
      return;
    }
    clearTimeout(this.rerunTimer);
    this.rerunTimer = setTimeout(() => void this.rerun(), 300);
  }

  /** Lists every report in the history, newest first, and shows the one picked. */
  async pickHistory(): Promise<void> {
    if (this.history.length === 0) {
      void vscode.window.showInformationMessage('No analyses have run yet.');
      return;
    }
    const items = this.history
      .map((entry, index) => {
        const { heading, subject } = titleParts(entry.report);
        return {
          label: `${index === this.position ? '$(arrow-right) ' : ''}$(${reportIcons[entry.report.kind] ?? 'list-tree'}) ${heading}`,
          description: subject,
          detail: [entry.report.description, entry.rerun ? undefined : 'from an earlier session'].filter(Boolean).join(' · ') || undefined,
          index,
        };
      })
      .reverse();
    const picked = await vscode.window.showQuickPick(items, { title: 'Analysis History', placeHolder: 'Show an earlier report', matchOnDescription: true, matchOnDetail: true });
    if (picked) {
      this.go(picked.index - this.position);
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
      this.persist();
    }
  }

  async setFilter(): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'Filter Analysis Results', value: this.filter, placeHolder: 'Text in a row label or description, or file:name for rows in matching files; empty to clear' });
    if (value !== undefined) {
      this.filter = value;
      this.render(true);
    }
  }

  /** Escape in the view: back to every row, without the text filter, scope limit or hidden groups. */
  clearFilters(): void {
    this.filter = '';
    this.limit = undefined;
    this.hidden.clear();
    this.render(true);
  }

  /** Shows only the rows inside a scope, or all of them again without one. Kept when the report is re-run. */
  limitTo(limit: { label: string; inside: (location: ReportLocation) => boolean } | undefined): void {
    this.limit = limit;
    this.render(true);
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
    const limited = report && this.limit ? limitReport(report.roots, this.limit.inside) : report?.roots;
    this.roots = limited ? filterReport(limited, this.filter).filter((r) => !this.hidden.has(r.label)) : [];
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
      this.done.clear();
      this.stale = false;
      this.settingsChanged = false;
      // A report from the history, or restored after a reload, may already be out of date.
      for (const document of vscode.workspace.textDocuments) {
        this.checkStale(document);
      }
    }
    // VS Code capitalizes every word of a view title, which mangles names like cart.ts, so the subject goes in the message.
    this.view.title = titleParts(report).heading;
    this.view.description = [this.limit ? `in ${this.limit.label}` : '', this.filter ? `filtered: “${this.filter}”` : '', this.hidden.size ? `${this.hidden.size} hidden` : ''].filter(Boolean).join(' · ') || undefined;
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
    void vscode.commands.executeCommand('setContext', 'tsStructure.limited', !!this.limit);
    void vscode.commands.executeCommand('setContext', 'tsStructure.narrowed', !!this.filter || !!this.limit || this.hidden.size > 0);
    void vscode.commands.executeCommand('setContext', 'tsStructure.reportKind', report?.kind);
    this.changed.fire();
    this.highlight();
  }

  private updateMessage(): void {
    const report = this.report;
    // The title's Re-run button turns into a warning while the results are out of date.
    void vscode.commands.executeCommand('setContext', 'tsStructure.stale', this.stale || this.settingsChanged);
    const messages = [
      ...(report ? [summaryLine(report)] : []),
      ...(this.stale ? ['Files changed since this analysis ran; re-run it to refresh the results.'] : []),
      ...(this.settingsChanged && !this.stale ? ['Settings changed since this analysis ran; re-run it to apply them.'] : []),
      ...(report && this.limit ? [`Showing ${countResults(this.roots)} of ${countResults(report.roots)} results, those in ${this.limit.label}.`] : []),
      ...(report?.warnings ?? []),
      ...(report && this.roots.length === 0 ? [this.filter ? `No rows match “${this.filter}”.` : this.limit ? `Nothing in ${this.limit.label}.` : 'Nothing found.'] : []),
    ];
    this.view.message = messages.length ? messages.join('\n') : undefined;
  }

  private checkStale(document: vscode.TextDocument): void {
    const expected = this.findHash(document.uri.fsPath);
    if (!this.stale && expected && expected !== hashText(document.getText())) {
      this.stale = true;
      this.updateMessage();
    }
  }

  private findHash(fileName: string): string | undefined {
    const report = this.report;
    if (this.hashIndex.report !== report) {
      this.hashIndex = { report, byKey: new Map(Object.entries(report?.fileHashes ?? {}).map(([file, hash]) => [pathKey(file), hash])) };
    }
    return this.hashIndex.byKey.get(pathKey(fileName));
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

  /**
   * Marks rows as done without re-running the analysis: the row and every row under it that `which`
   * accepts, such as the fixable ones after Fix All. Their buttons for that action go away.
   */
  markDone(node: ReportNode, note: string, which: (n: ReportNode) => boolean = () => true): void {
    const mark = (n: ReportNode): void => {
      if (which(n)) {
        this.done.set(rowKey(n), note);
      }
      (n.children ?? []).forEach(mark);
    };
    mark(node);
    this.changed.fire();
  }

  isDone(node: ReportNode): boolean {
    return this.done.has(rowKey(node));
  }

  markFixed(node: ReportNode): void {
    this.markDone(node, 'fixed', (n) => !!rowFix(n));
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
    } else if (node.action?.kind === 'explain') {
      item.command = { command: 'tsStructure.report.about', title: 'About This Analysis' };
    }
    const done = this.done.get(rowKey(node));
    if (done) {
      item.description = [done, node.description].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor(toneColors.ok));
    }
    // A group with several fixes below it gets Fix All; a row already acted on loses its buttons.
    const fixAll = !done && !rowFix(node) && node.children?.length && countFixes(node, (n) => this.isDone(n)) > 1 ? 'fixAll' : '';
    item.contextValue = [node.location ? 'location' : '', node.action && !done ? `action:${node.action.kind}` : '', fixAll].filter(Boolean).join(' ');
    return item;
  }

  /** Expands every row that has children. */
  async expandAll(): Promise<void> {
    const expand = async (nodes: readonly ReportNode[]): Promise<void> => {
      for (const node of nodes) {
        if (node.children?.length) {
          await Promise.resolve(this.view.reveal(node, { expand: true, select: false, focus: false })).catch(() => undefined);
          await expand(node.children);
        }
      }
    };
    await expand(this.roots);
  }

  /** A row as text: its label, description and location, with its children indented below it. */
  rowText(node: ReportNode, indent = ''): string {
    const where = node.location ? ` (${vscode.workspace.asRelativePath(node.location.file)}:${node.location.line + 1})` : '';
    const line = `${indent}${node.label}${node.description ? ` — ${node.description}` : ''}${where}`;
    return [line, ...(node.children ?? []).map((c) => this.rowText(c, `${indent}  `))].join('\n');
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
    // Where you are in the results, since the view may be hidden while stepping from the editor.
    this.stepStatus?.dispose();
    this.stepStatus = vscode.window.setStatusBarMessage(`$(list-tree) Result ${this.cursor + 1} of ${this.located.length}: ${node.label}`, 4000);
  }

  private stepStatus: vscode.Disposable | undefined;

  /** Every shown row's location as `file:line`, one per line, for a ticket or another tool. */
  locations(): string[] {
    return [...new Set(this.located.map((n) => `${vscode.workspace.asRelativePath(n.location!.file)}:${n.location!.line + 1}`))];
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

/** A row's identity across re-renders, which copy rows when filtering or limiting. */
function rowKey(node: ReportNode): string {
  const where = node.location ? `${node.location.file}:${node.location.line}:${node.location.character}` : String(node.action?.file ?? '');
  return `${node.label} @ ${where}`;
}
