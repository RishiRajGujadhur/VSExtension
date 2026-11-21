import * as vscode from 'vscode';
import { CodeExplanation, explainCode } from '../explain/explainCode';
import type { ReelPanel } from '../reel/reelPanel';
import { CODE_MODEL, downloadDisclosure } from '../reel/codeModelText';
import { webviewPage, webviewRoots } from './webviewPage';
import { explanationHtml } from '../explain/explainHtml';
import { showProblem } from './problems';
import * as path from 'path';
import { explanationReel } from '../explain/explainReel';
import type { ReelPlan } from '../reel/plan';
import { gitRoot } from '../navigate/graphDiff';

/**
 * "Explain this code": the highlighted code (or the function at the cursor) explained in plain sentences, beside the
 * editor. Worked out on this computer by Code X-Ray's rules, with the code model's help when it is downloaded; when
 * it is not, you are asked first, and told exactly what a download sends.
 */
export class ExplainCodeView {
  private panel: vscode.WebviewPanel | undefined;
  /** Asked once a session: "Explain without it" is not asked again until VS Code restarts. */
  private declined = false;
  /** For tests: the last explanation shown. */
  last: CodeExplanation | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly reel: ReelPanel,
  ) {}

  async run(): Promise<CodeExplanation | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void showProblem('Highlight some code in an editor first, then choose Explain this code.', [], 'info');
      return undefined;
    }
    const { document, selection } = editor;
    // Nothing highlighted: the line the cursor is on, which explains the function it starts, or that line.
    const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
    const understand = await this.understanding();
    const explanation = await explainCode(document.fileName, document.getText(), document.offsetAt(range.start), document.offsetAt(range.end), understand);
    this.last = explanation;
    this.lastFile = document.fileName;
    this.show(explanation, !!understand);
    return explanation;
  }
  private lastFile: string | undefined;

  /**
   * The explanation as a video in the Git reel's player: a scene per step on the function's flowchart, with the
   * voice-over. Made on this computer from the explanation shown.
   */
  async video(): Promise<ReelPlan | undefined> {
    const e = this.last;
    const file = this.lastFile;
    if (!e?.walk || !file) {
      void showProblem('A video can be made of a whole function: highlight one, choose Explain this code, then Generate video.', [], 'info');
      return undefined;
    }
    let folder = path.dirname(file);
    try {
      folder = gitRoot(folder);
    } catch {
      // Not in a repository: the video is saved next to the file.
    }
    const plan = explanationReel(e, path.relative(folder, file).replace(/\\/g, '/'));
    if (!plan) return undefined;
    return this.reel.openPlan(plan, folder, `${file}#${e.walk.name}`);
  }

  /**
   * The code model, if it is there or you agree to download it now. Before any download, the prompt says what it
   * sends (a request for two files, which shows Hugging Face your IP address) and what it never sends (your code).
   */
  private async understanding(): Promise<((texts: string[]) => Promise<Float32Array[]>) | undefined> {
    const setting = vscode.workspace.getConfiguration('tsStructure.reel').get<string>('codeModel', 'ask');
    if (setting === 'off') return undefined;
    if (!this.reel.codeModel.runnable && !this.declined) {
      if (setting !== 'on') {
        const choice = await vscode.window.showInformationMessage(
          `Explain this code works better with the code model (all-MiniLM-L6-v2, Apache-2.0, ${CODE_MODEL.megabytes} MB, downloaded once).`,
          { modal: true, detail: downloadDisclosure() },
          'Download and Explain',
          'Explain Without It',
        );
        if (choice !== 'Download and Explain') {
          this.declined = true;
          return undefined;
        }
      }
      if (!(await this.reel.downloadCodeModel())) return undefined;
    }
    return this.reel.codeModel.runnable ? (texts) => this.reel.codeModel.embed(texts) : undefined;
  }

  private show(explanation: CodeExplanation, withModel: boolean): void {
    const title = `Explain: ${explanation.subject.replace(/^the (function|highlighted lines in) /, '')}`;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('tsStructure.explainCode', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, enableCommandUris: ['tsStructure.explainCode.video'], localResourceRoots: webviewRoots(this.extensionUri) });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.panel.title = title;
    this.panel.webview.html = webviewPage(this.panel.webview, this.extensionUri, { title: 'Explain this code', styles: ['explain.css'], scripts: [], body: explanationHtml(explanation, withModel) });
  }
}

