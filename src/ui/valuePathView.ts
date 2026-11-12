import * as vscode from 'vscode';
import { Report, ReportLocation } from '../structure/report';
import { ValuePathCard, valuePathCard } from '../structure/valuePathCard';
import { webviewPage, webviewRoots } from './webviewPage';
import { StructureView } from './structureView';

const shownContext = 'tsStructure.valuePathShown';

/**
 * The Value path panel at the bottom of the Code X-Ray sidebar. While the result on show is a "Why this value",
 * it takes the place of the Results list, with the result drawn as a card: the values on a timeline, each with
 * how many ways lead to it and what has to be true, and a Next step. "Show as a list" brings the Results list back
 * for that result; the next Value path shows as a card again.
 */
export class ValuePathView implements vscode.WebviewViewProvider {
  static readonly viewType = 'tsStructure.valuePath';
  private view: vscode.WebviewView | undefined;
  private card: ValuePathCard | undefined;
  /** The Results list was asked for, for the result on show. */
  private asList = false;
  private stale = false;

  constructor(private readonly extensionUri: vscode.Uri, private readonly results: StructureView) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ValuePathView.viewType, this),
      this.results.onDidShowNewReport(() => {
        this.asList = false;
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
    );
    this.follow(false);
  }

  /** Shows the card when the result on show is a Value path, and the Results list otherwise. */
  private follow(fresh: boolean): void {
    const report: Report | undefined = this.results.report;
    this.card = report ? valuePathCard(report) : undefined;
    const shown = !!this.card && !this.asList;
    void vscode.commands.executeCommand('setContext', shownContext, shown);
    this.post();
    // A new Value path comes into view, as the Results list does for other results.
    if (shown && fresh) {
      if (this.view) this.view.show(true);
      else void vscode.commands.executeCommand(`${ValuePathView.viewType}.focus`).then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) };
    view.webview.html = webviewPage(view.webview, this.extensionUri, { title: 'Value path', styles: ['valuePath.css'], scripts: ['valuePath.js'], body: '<main id="card"></main>' });
    view.webview.onDidReceiveMessage(async (message: { type: string; location?: unknown }) => {
      if (message.type === 'ready') {
        this.post();
      } else if (message.type === 'open' && isLocation(message.location)) {
        const where = message.location;
        await vscode.window.showTextDocument(vscode.Uri.file(where.file), { selection: new vscode.Range(where.line, where.character, where.endLine, where.endCharacter) });
      } else if (message.type === 'copy') {
        await vscode.commands.executeCommand('tsStructure.report.copyMarkdown');
      } else if (message.type === 'list') {
        // The Results list for this result, with its filters, history and row menus.
        this.asList = true;
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
