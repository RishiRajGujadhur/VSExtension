import * as vscode from 'vscode';
import { Report, ReportLocation } from '../structure/report';
import { ResultCard, resultCard } from '../structure/resultCard';
import { registerCommand } from './features';
import { webviewPage, webviewRoots } from './webviewPage';
import { StructureView } from './structureView';
import { menuAnalyses } from './diagramView';
import { activeFeature } from './activeFeature';

const shownContext = 'tsStructure.cardShown';
const listKey = 'tsStructure.results.asList';

/**
 * The result panel at the bottom of the Code X-Ray sidebar: every result drawn as a card, in the Results list's
 * place. A Value path shows its values on a timeline with what leads to each; any other result shows its groups as
 * steps with their rows. "Show as a list" brings back the Results list (with its filters, history and row menus)
 * and keeps it until "Show as card" in the list's title bar.
 */
export class ValuePathView implements vscode.WebviewViewProvider {
  static readonly viewType = 'tsStructure.valuePath';
  private view: vscode.WebviewView | undefined;
  private card: ResultCard | undefined;
  private asList: boolean;
  private stale = false;
  /** The panel's when-condition being set: the panel can only be focused once it is. */
  private contextSet: Promise<void> = Promise.resolve();

  constructor(private readonly extensionUri: vscode.Uri, private readonly results: StructureView, private readonly memento: vscode.Memento) {
    this.asList = memento.get<boolean>(listKey, false);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ValuePathView.viewType, this),
      this.results.onDidShowNewReport(() => {
        this.stale = false;
        this.follow(true);
      }),
      this.results.onDidChangeReport(() => this.follow(false)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const changed = e.document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
        if (!this.stale && this.card && e.contentChanges.length && Object.keys(this.results.report?.fileHashes ?? {}).some((f) => f.replace(/\\/g, '/').toLowerCase() === changed)) {
          this.stale = true;
          this.post();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tsStructure.actions.accentColor') && this.post()),
      // From the Results list's title bar: back to cards.
      registerCommand('tsStructure.report.showAsCard', async () => {
        await this.setList(false);
        this.follow(true);
      }),
    );
    this.follow(false);
  }

  private async setList(asList: boolean): Promise<void> {
    this.asList = asList;
    await this.memento.update(listKey, asList);
  }

  /** Shows the result on show as a card, unless the list was chosen. */
  private follow(fresh: boolean): void {
    const report: Report | undefined = this.results.report;
    this.card = report ? resultCard(report) : undefined;
    // Next steps: other analyses of the same subject (not the one that made this result), the main ones first.
    if (this.card && report && this.card.subjectAt) {
      const origin = activeFeature.originOf(report);
      const runs: Record<string, string> = { 'tsStructure.report.usagesHere': 'tsStructure.semanticUsages', 'tsStructure.report.dataFlowHere': 'tsStructure.dataFlow', 'tsStructure.report.nullabilityHere': 'tsStructure.nullability', 'tsStructure.report.mutationsHere': 'tsStructure.mutationTrackingVariable', 'tsStructure.report.racesHere': 'tsStructure.raceConditions', 'tsStructure.report.sideEffectsHere': 'tsStructure.sideEffects', 'tsStructure.report.exceptionsHere': 'tsStructure.exceptionFlow', 'tsStructure.report.argumentsHere': 'tsStructure.argumentFlow' };
      const sameKind: Record<string, string> = { dataFlow: 'tsStructure.dataFlow', nullability: 'tsStructure.nullability', usages: 'tsStructure.semanticUsages', variableMutations: 'tsStructure.mutationTrackingVariable', races: 'tsStructure.raceConditions', sideEffects: 'tsStructure.sideEffects', exceptions: 'tsStructure.exceptionFlow', argumentFlow: 'tsStructure.argumentFlow' };
      const current = origin ?? sameKind[report.kind];
      this.card.nextSteps = menuAnalyses().filter((a) => runs[a.command] !== current).sort((a, b) => Number(a.more) - Number(b.more)).slice(0, 3).map((a) => ({ command: a.command, label: a.label, icon: a.icon }));
    }
    if (this.view) {
      this.view.title = this.card?.heading ?? 'Result';
      // A count on the panel: values of a Value path, rows of any other result.
      const count = this.card ? (this.card.value ? this.card.value.values.length : (this.card.rows ?? []).reduce((n, r) => n + Math.max(1, r.children.length + r.more), 0)) : 0;
      this.view.badge = count ? { value: count, tooltip: `${count} ${this.card?.value ? (count === 1 ? 'value' : 'values') : count === 1 ? 'row' : 'rows'}` } : undefined;
    }
    const shown = !!this.card && !this.asList;
    this.contextSet = Promise.resolve(vscode.commands.executeCommand('setContext', shownContext, shown)).then(() => undefined, () => undefined);
    this.post();
    // A new result comes into view, as the Results list would.
    if (shown && fresh) this.reveal();
  }

  /** Brings the card panel into view, opening it when VS Code has closed its page. */
  private reveal(): void {
    const focusPanel = () => void this.contextSet.then(() => vscode.commands.executeCommand(`${ValuePathView.viewType}.focus`)).then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
    if (!this.view) return focusPanel();
    try {
      this.view.show(true);
    } catch {
      // Disposed between the check and the call.
      this.view = undefined;
      focusPanel();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    if (this.card) view.title = this.card.heading;
    view.webview.html = webviewPage(view.webview, this.extensionUri, { title: 'Result', styles: ['valuePath.css'], scripts: ['valuePath.js'], body: '<main id="card"></main>' });
    view.webview.onDidReceiveMessage(async (message: { type: string; location?: unknown; command?: unknown }) => {
      if (message.type === 'ready') {
        this.post();
      } else if (message.type === 'open' && isLocation(message.location)) {
        const where = message.location;
        await vscode.window.showTextDocument(vscode.Uri.file(where.file), { selection: new vscode.Range(where.line, where.character, where.endLine, where.endCharacter) });
      } else if (message.type === 'copy') {
        await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
      } else if (message.type === 'list') {
        // The Results list, with its filters, history and row menus, until Show as card.
        await this.setList(true);
        await vscode.commands.executeCommand('setContext', shownContext, false);
        await vscode.commands.executeCommand('tsStructure.report.focus');
      } else if (message.type === 'analyze' && typeof message.command === 'string' && this.card?.subjectAt) {
        // A Next step: the same command the Results view runs on a row, at the subject.
        const command = message.command as string;
        if (!menuAnalyses().some((a) => a.command === command)) return;
        const at = this.card.subjectAt;
        await vscode.commands.executeCommand(command, { file: at.file, line: at.line, character: at.character });
      } else if (message.type === 'chart') {
        await vscode.commands.executeCommand('tsStructure.report.showDiagram');
      } else if (message.type === 'rerun') {
        await vscode.commands.executeCommand('tsStructure.rerunAnalysis');
      } else if (message.type === 'next') {
        await vscode.commands.executeCommand('tsStructure.actionsAtCursor');
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.post());
    // Hidden away, VS Code disposes the page: forget it, so showing a card later opens the panel afresh.
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private post(): void {
    if (!this.view) return;
    try {
      void this.view.webview.postMessage({ type: 'card', card: this.card, stale: this.stale, accent: vscode.workspace.getConfiguration('tsStructure.actions').get('accentColor', 'cyan') }).then(undefined, () => undefined);
    } catch {
      this.view = undefined;
    }
  }
}

/** A location sent back by the page, checked before it is opened. */
function isLocation(value: unknown): value is ReportLocation {
  const v = value as ReportLocation | undefined;
  return !!v && typeof v.file === 'string' && [v.line, v.character, v.endLine, v.endCharacter].every((n) => typeof n === 'number');
}
