import * as vscode from 'vscode';
import { Report, ReportLocation } from '../structure/report';
import { ResultCard, resultCard } from '../structure/resultCard';
import { registerCommand } from './features';
import { webviewPage, webviewRoots } from './webviewPage';
import { StructureView } from './structureView';

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
    if (this.view) this.view.title = this.card?.heading ?? 'Result';
    const shown = !!this.card && !this.asList;
    void vscode.commands.executeCommand('setContext', shownContext, shown);
    this.post();
    // A new result comes into view, as the Results list would.
    if (shown && fresh) {
      if (this.view) this.view.show(true);
      else void vscode.commands.executeCommand(`${ValuePathView.viewType}.focus`).then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    if (this.card) view.title = this.card.heading;
    view.webview.html = webviewPage(view.webview, this.extensionUri, { title: 'Result', styles: ['valuePath.css'], scripts: ['valuePath.js'], body: '<main id="card"></main>' });
    view.webview.onDidReceiveMessage(async (message: { type: string; location?: unknown }) => {
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
      } else if (message.type === 'rerun') {
        await vscode.commands.executeCommand('tsStructure.rerunAnalysis');
      } else if (message.type === 'next') {
        await vscode.commands.executeCommand('tsStructure.actionsAtCursor');
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.post());
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'card', card: this.card, stale: this.stale, accent: vscode.workspace.getConfiguration('tsStructure.actions').get('accentColor', 'cyan') });
  }
}

/** A location sent back by the page, checked before it is opened. */
function isLocation(value: unknown): value is ReportLocation {
  const v = value as ReportLocation | undefined;
  return !!v && typeof v.file === 'string' && [v.line, v.character, v.endLine, v.endCharacter].every((n) => typeof n === 'number');
}
