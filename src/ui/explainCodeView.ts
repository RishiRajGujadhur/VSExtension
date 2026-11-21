import * as vscode from 'vscode';
import { CodeExplanation, explainCode } from '../explain/explainCode';
import type { ReelPanel } from '../reel/reelPanel';
import { CODE_MODEL, downloadDisclosure } from '../reel/codeModelText';
import { webviewPage, webviewRoots } from './webviewPage';
import { showProblem } from './problems';

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
    this.show(explanation, !!understand);
    return explanation;
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
      this.panel = vscode.window.createWebviewPanel('tsStructure.explainCode', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, localResourceRoots: webviewRoots(this.extensionUri) });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.panel.title = title;
    this.panel.webview.html = webviewPage(this.panel.webview, this.extensionUri, { title: 'Explain this code', styles: ['explain.css'], scripts: [], body: explanationHtml(explanation, withModel) });
  }
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The explanation as the page shows it. */
export function explanationHtml(e: CodeExplanation, withModel: boolean): string {
  const subject = e.subject.replace(/(\w+\(\))/, '<code>$1</code>');
  const purpose = e.purpose
    ? `<div class="purpose"><i class="codicon codicon-lightbulb" aria-hidden="true"></i><span>${escape(e.purpose.text)}</span><small>${e.purpose.by === 'model' ? 'named by the code model' : "by Code X-Ray's rules"}</small></div>`
    : '';
  const steps = e.steps.length ? `<ol>${e.steps.map((s) => `<li>${escape(s)}</li>`).join('')}</ol>` : '<p class="empty">Nothing here to put in words: highlight a whole function, or lines that call, set, check or return something.</p>';
  const privacy = withModel
    ? 'Explained on your computer by Code X-Ray\'s rules and the downloaded code model. Nothing was sent anywhere.'
    : 'Explained on your computer by Code X-Ray\'s rules. Nothing was sent anywhere.';
  return `<h1>What ${subject.replace(/^the /, 'the ')} does</h1>
${e.summary ? `<p class="summary">${escape(e.summary)}</p>` : ''}
${purpose}
${steps}
<p class="privacy"><i class="codicon codicon-shield" aria-hidden="true"></i><span>${privacy}</span></p>`;
}
