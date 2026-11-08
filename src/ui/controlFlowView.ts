import * as vscode from 'vscode';
import { AnalysisError } from '../analysis/types';
import { ProjectService } from '../analysis/project';
import { ControlFlowChart, chartMermaid, controlFlowChart, nodeAtOffset } from '../inspect/controlFlowChart';
import { saveImage } from './diagramView';
import { ReportLocation } from '../structure/report';

/**
 * The Control Flow view: a function's flowchart in an editor tab, with the Path Explorer beside it. It redraws as
 * the function is edited, outlines the box the editor's cursor is in, and opens the code of a clicked box.
 */
export class ControlFlowPanel {
  static readonly viewType = 'tsStructure.controlFlow';
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private chart: ControlFlowChart | undefined;
  /** The file and the function's offset in it, moved along with edits above it. */
  private target: { uri: vscode.Uri; anchor: number; folder?: string } | undefined;
  private refresh: NodeJS.Timeout | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectService,
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.panel || !this.target || e.document.uri.toString() !== this.target.uri.toString()) return;
        // Keep the anchor on the function when text above it changes.
        for (const change of e.contentChanges) {
          if (change.rangeOffset + change.rangeLength <= this.target.anchor) this.target.anchor += change.text.length - change.rangeLength;
        }
        clearTimeout(this.refresh);
        this.refresh = setTimeout(() => this.build(), 400);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.panel || !this.chart || !this.target || e.textEditor.document.uri.toString() !== this.target.uri.toString()) return;
        const project = this.projects.analysisProject(this.target.uri.fsPath, this.target.folder);
        const id = nodeAtOffset(this.chart, project.sourceFile(this.target.uri.fsPath), e.textEditor.document.offsetAt(e.selections[0].active));
        void this.panel.webview.postMessage({ type: 'cursor', id });
      }),
    );
  }

  /** Opens the view for the function at the editor's cursor (or the function called there). */
  show(editor: vscode.TextEditor): void {
    const uri = editor.document.uri;
    this.target = { uri, anchor: editor.document.offsetAt(editor.selection.active), folder: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath };
    if (!this.build(true)) return;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const codicons = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
    this.panel = vscode.window.createWebviewPanel(ControlFlowPanel.viewType, 'Control Flow', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, codicons] });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'structure-light.svg'), dark: vscode.Uri.joinPath(media, 'structure-dark.svg') };
    this.ready = false;
    this.panel.webview.html = html(this.panel.webview, media, codicons);
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; location?: ReportLocation; svg?: string; path?: { nodes: number[]; edges: number[] } }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.post();
      } else if (message.type === 'open' && message.location) {
        await openBeside(message.location);
      } else if (message.type === 'mermaid' && this.chart) {
        // The picked path, if any, is drawn thick in the copy too.
        await vscode.env.clipboard.writeText(['```mermaid', chartMermaid(this.chart, message.path), '```', ''].join('\n'));
        void vscode.window.setStatusBarMessage('Copied the control flow as Mermaid: paste it into Markdown, a GitHub issue or a pull request', 5000);
      } else if (message.type === 'save' && message.svg && this.chart) {
        await saveImage(Buffer.from(message.svg, 'utf8'), 'svg', `control-flow-${this.chart.name}`);
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.chart = undefined;
    });
  }

  /** The chart for the target, sent to the page; false when there is no function there. */
  private build(fromCommand = false): boolean {
    if (!this.target) return false;
    try {
      const project = this.projects.analysisProject(this.target.uri.fsPath, this.target.folder);
      this.chart = controlFlowChart(project, this.target.uri.fsPath, this.target.anchor);
      // Follow the function itself from now on, not the cursor position it was found from.
      this.target.anchor = this.chart.anchor;
      this.post();
      return true;
    } catch (error) {
      if (fromCommand) {
        void vscode.window.showInformationMessage(error instanceof AnalysisError ? error.message : `Control Flow: ${String(error)}`);
      }
      return false;
    }
  }

  private post(): void {
    if (!this.panel || !this.ready) return;
    this.panel.title = this.chart ? `Control Flow: ${this.chart.name}` : 'Control Flow';
    void this.panel.webview.postMessage({ type: 'chart', chart: this.chart });
  }

  /** For tests: the chart on screen. */
  get current(): ControlFlowChart | undefined {
    return this.chart;
  }
}

/** Opens code in an editor group other than the one the chart is in. */
async function openBeside(location: ReportLocation): Promise<void> {
  const fromWebview = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview;
  const other = fromWebview ? (vscode.window.tabGroups.all.find((g) => g !== vscode.window.tabGroups.activeTabGroup)?.viewColumn ?? vscode.ViewColumn.Beside) : undefined;
  const selection = new vscode.Range(location.line, location.character, location.endLine, location.endCharacter);
  await vscode.window.showTextDocument(vscode.Uri.file(location.file), { selection, viewColumn: other, preserveFocus: false });
}

function html(webview: vscode.Webview, media: vscode.Uri, codicons: vscode.Uri): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
  const button = (id: string, icon: string, title: string, extra = '') =>
    `<button id="${id}" title="${title}" aria-label="${title}" ${extra}><i class="codicon codicon-${icon}" aria-hidden="true"></i></button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'))}">
<link rel="stylesheet" href="${asset('controlFlow.css')}">
<title>Control Flow</title>
</head>
<body>
<header aria-label="Control flow tools">
  <span id="caption"></span>
  <span class="group" role="group" aria-label="Zoom">
  ${button('zoomOut', 'zoom-out', 'Zoom Out (−)')}
  <button id="zoomLevel" title="Zoom level: click for 100%" aria-label="Zoom level, click for 100%">100%</button>
  ${button('zoomIn', 'zoom-in', 'Zoom In (+)')}
  ${button('fit', 'screen-full', 'Fit the Whole Function (0)')}
  </span>
  <span class="group" role="group" aria-label="Export">
  ${button('mermaid', 'markdown', 'Copy as Mermaid: the flowchart, with the picked path drawn thick')}
  ${button('save', 'save', 'Save as SVG image, in the current colors')}
  </span>
  ${button('togglePaths', 'list-tree', 'Path Explorer: the paths through the function', 'aria-pressed="true" aria-controls="explorer"')}
</header>
<p id="empty">Put the cursor in a function and run Control Flow Graph to draw it here.</p>
<main>
<div id="stage">
<svg id="canvas" class="off" role="group" aria-label="Control flow graph. Tab moves between boxes; Enter opens the code.">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  <g id="scene"></g>
</svg>
</div>
<aside id="explorer" aria-label="Path Explorer">
  <h2>Path Explorer</h2>
  <div id="pathSummary" role="status"></div>
  <p class="hint">Pick a path to light up its route, or click a branch label (yes, no, case…) to keep only the paths through it.</p>
  <div class="options">
    <label><input type="checkbox" id="showImpossible"> Show impossible paths</label>
    <button id="clearPins" title="Remove every branch filter and the selected path (Escape)">Clear</button>
  </div>
  <div id="pins" aria-label="Branches the paths must take"></div>
  <ul id="paths" role="listbox" aria-label="Paths through the function"></ul>
</aside>
</main>
<script src="${asset('controlFlow.js')}"></script>
</body>
</html>`;
}
