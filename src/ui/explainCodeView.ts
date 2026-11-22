import * as vscode from 'vscode';
import { CodeExplanation, explainCode } from '../explain/explainCode';
import type { ReelPanel } from '../reel/reelPanel';
import { CODE_MODEL, downloadDisclosure } from '../reel/codeModelText';
import { HUGGING_FACE_PRIVACY } from '../reel/downloadPrivacy';
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
    let explanation = await explainCode(document.fileName, document.getText(), document.offsetAt(range.start), document.offsetAt(range.end), understand);
    let file = document.fileName;
    // A function's name highlighted where it is called, and declared in another file: that function, found the way
    // Go to Definition finds it (on this computer, by the language's own extension).
    const word = document.getText(range).trim();
    if (!explanation.walk && /^[#\w$]+$/.test(word)) {
      const elsewhere = await this.definitionOf(document, range.start.translate(0, document.getText(range).length - document.getText(range).trimStart().length), understand);
      if (elsewhere) ({ explanation, file } = elsewhere);
    }
    this.last = explanation;
    this.lastFile = file;
    this.show(explanation, !!understand);
    return explanation;
  }
  private lastFile: string | undefined;

  /** The explanation of the function a name refers to, when it is declared somewhere else. */
  private async definitionOf(document: vscode.TextDocument, at: vscode.Position, understand: ((texts: string[]) => Promise<Float32Array[]>) | undefined): Promise<{ explanation: CodeExplanation; file: string } | undefined> {
    try {
      const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, at);
      for (const d of found ?? []) {
        const uri = 'targetUri' in d ? d.targetUri : d.uri;
        const target = 'targetUri' in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
        if (uri.toString() === document.uri.toString() && target.contains(at)) continue;
        const other = await vscode.workspace.openTextDocument(uri);
        const explanation = await explainCode(other.fileName, other.getText(), other.offsetAt(target.start), other.offsetAt(target.end), understand);
        if (explanation.walk) return { explanation, file: other.fileName };
      }
    } catch {
      // No definition to go to: the highlight is explained as it is.
    }
    return undefined;
  }

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
        // The download step: exactly what downloading sends and how the data is used, before anything is sent.
        let choice: string | undefined;
        for (;;) {
          choice = await vscode.window.showInformationMessage(
            `Explain this code works better with the code model (all-MiniLM-L6-v2, Apache-2.0, ${CODE_MODEL.megabytes} MB, downloaded once from Hugging Face). Download it?`,
            { modal: true, detail: downloadDisclosure(this.reel.codeModelFolder) },
            'Download and Explain',
            'Explain Without It',
            "Hugging Face's Privacy Policy",
          );
          if (choice !== "Hugging Face's Privacy Policy") break;
          await vscode.env.openExternal(vscode.Uri.parse(HUGGING_FACE_PRIVACY));
        }
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

