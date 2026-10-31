import * as path from 'path';
import * as vscode from 'vscode';
import { Report, ReportLocation, ReportNode, Tone } from '../structure/report';
import { currentHash } from '../resultsView';

const toneColors: Record<Tone, string> = {
  error: 'problemsErrorIcon.foreground',
  warning: 'problemsWarningIcon.foreground',
  info: 'problemsInfoIcon.foreground',
  ok: 'testing.iconPassed',
};

/** Shows the latest analysis report as a tree; every analysis in the extension renders here. */
export class StructureView implements vscode.TreeDataProvider<ReportNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private current: Report | undefined;
  private rerunCurrent: (() => Thenable<Report | undefined>) | undefined;
  readonly view: vscode.TreeView<ReportNode>;

  constructor() {
    this.view = vscode.window.createTreeView('tsStructure.report', { treeDataProvider: this, showCollapseAll: true });
  }

  get report(): Report | undefined {
    return this.current;
  }

  async show(report: Report, rerun?: () => Thenable<Report | undefined>): Promise<void> {
    this.current = report;
    this.rerunCurrent = rerun;
    this.render();
    await vscode.commands.executeCommand('tsStructure.report.focus');
  }

  clear(): void {
    this.current = undefined;
    this.rerunCurrent = undefined;
    this.render();
  }

  async rerun(): Promise<void> {
    const report = await this.rerunCurrent?.();
    if (report) {
      await this.show(report, this.rerunCurrent);
    }
  }

  private render(): void {
    const report = this.current;
    this.view.title = report ? report.title : 'Analysis';
    this.view.description = report?.description;
    this.view.message = report?.warnings.length ? report.warnings.join(' ') : report && report.roots.length === 0 ? 'Nothing found.' : undefined;
    void vscode.commands.executeCommand('setContext', 'tsStructure.hasReport', !!report);
    this.changed.fire();
  }

  getChildren(node?: ReportNode): ReportNode[] {
    return node ? (node.children ?? []) : (this.current?.roots ?? []);
  }

  getTreeItem(node: ReportNode): vscode.TreeItem {
    const state = node.children?.length
      ? node.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, state);
    item.description = node.description;
    item.tooltip = node.tooltip ? new vscode.MarkdownString(node.tooltip) : undefined;
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon, node.tone ? new vscode.ThemeColor(toneColors[node.tone]) : undefined);
    }
    if (node.location) {
      item.command = { command: 'tsStructure.openLocation', title: 'Open', arguments: [node.location] };
    }
    item.contextValue = [node.location ? 'location' : '', node.action ? `action:${node.action.kind}` : ''].filter(Boolean).join(' ');
    return item;
  }

  /** Opens a row's location unless its file changed after the analysis, which would make the position unreliable. */
  async open(location: ReportLocation, sideBySide = false): Promise<void> {
    const expected = this.current?.fileHashes[location.file];
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
    await vscode.window.showTextDocument(uri, { selection, preview: true, viewColumn: sideBySide ? vscode.ViewColumn.Beside : undefined });
  }
}
