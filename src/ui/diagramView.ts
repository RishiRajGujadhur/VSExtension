import * as vscode from 'vscode';
import { Diagram, diagramMermaid, reportDiagram } from '../structure/diagram';
import { Report, ReportLocation } from '../structure/report';
import { StructureView } from './structureView';

/**
 * The analysis on screen as a flow chart in an editor tab. It follows the results view: each new
 * analysis redraws it. Clicking a box opens its code; right-clicking runs another analysis there.
 */
export class DiagramPanel {
  static readonly viewType = 'tsStructure.diagram';
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly view: StructureView,
  ) {
    view.onDidChangeReport((report) => this.panel && this.post(report));
    // The row selected in the results view is marked in the chart, and a box clicked in the chart selects its row.
    view.view.onDidChangeSelection((e) => {
      if (this.panel && this.ready && e.selection[0]?.location) {
        void this.panel.webview.postMessage({ type: 'select', location: e.selection[0].location });
      }
    });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      this.post(this.view.report);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(DiagramPanel.viewType, 'Analysis Diagram', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'structure-light.svg'), dark: vscode.Uri.joinPath(media, 'structure-dark.svg') };
    this.ready = false;
    this.panel.webview.html = this.html(this.panel.webview, media);
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; location?: ReportLocation; svg?: string; png?: string; text?: string; title?: string; diagram?: Diagram }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.post(this.view.report);
      } else if (message.type === 'peek' && message.location) {
        // The line a box points at, for the bar under the chart.
        const where = message.location;
        const code = await vscode.workspace.openTextDocument(where.file).then(
          (document) => (where.line < document.lineCount ? document.lineAt(where.line).text.trim().slice(0, 200) : ''),
          () => '',
        );
        void this.panel?.webview.postMessage({ type: 'peek', location: where, code });
      } else if (message.type === 'open' && message.location) {
        await this.view.open(message.location);
        await this.view.revealLocation(message.location);
      } else if (message.type === 'mermaid' && message.diagram) {
        await vscode.env.clipboard.writeText(['```mermaid', diagramMermaid(message.diagram), '```', ''].join('\n'));
        void vscode.window.setStatusBarMessage('Copied the chart as Mermaid: paste it into Markdown, a GitHub issue or a pull request', 5000);
      } else if (message.type === 'save' && message.svg) {
        await saveImage(Buffer.from(message.svg, 'utf8'), 'svg', message.title);
      } else if (message.type === 'error' && message.text) {
        void vscode.window.showWarningMessage(message.text);
      } else if (message.type === 'savePng' && message.png) {
        await saveImage(Buffer.from(message.png, 'base64'), 'png', message.title);
      }
    });
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  private post(report: Report | undefined): void {
    if (!this.panel || !this.ready) {
      return;
    }
    this.panel.title = report ? `Diagram: ${report.title}` : 'Analysis Diagram';
    void this.panel.webview.postMessage({ type: 'diagram', diagram: report ? reportDiagram(report) : undefined });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    const button = (id: string, label: string, title: string) => `<button id="${id}" title="${title}">${label}</button>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('diagram.css')}">
<title>Analysis Diagram</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<header>
  <span id="caption"></span>
  <input id="search" type="search" placeholder="Find a box (Ctrl+F)" aria-label="Find a box" title="Highlights boxes whose text contains this; Enter goes to the next, Shift+Enter to the previous">
  <span id="searchCount" aria-live="polite"></span>
  ${button('collapse', 'Fold All', 'Show only the rows next to the subject')}
  ${button('expand', 'Unfold All', 'Show every row')}
  ${button('zoomOut', '−', 'Zoom out (−)')}
  <button id="zoomLevel" title="Zoom level; click for 100%">100%</button>
  ${button('zoomIn', '+', 'Zoom in (+)')}
  ${button('fit', 'Fit', 'Fit the diagram to the window')}
  ${button('mermaid', 'Copy Mermaid', 'Copy the chart, as folded now, as a Mermaid flowchart for Markdown, GitHub issues and pull requests')}
  ${button('save', 'Save SVG', 'Save the chart as an SVG image, in the current colors')}
  ${button('savePng', 'Save PNG', 'Save the chart as a PNG picture at twice the size, for chats and slides')}
  <button id="effects" class="toggle-button" aria-pressed="true" title="The animated dot grid behind the chart, which follows the pointer">Grid</button>
  <button id="flowToggle" class="toggle-button" aria-pressed="true" title="Clicking a box animates the lines between it and the subject; click the background or press Escape to stop">Flow</button>
  <button id="legendButton" title="What the colors, arrows and buttons mean" aria-expanded="false" aria-controls="legend">?</button>
</header>
<div id="branch" hidden><span id="branchLabel"></span><button id="wholeChart" title="Show every branch again (Escape)">Show Whole Chart</button></div>
<p id="empty">Run an analysis, such as Data Flow, and it is drawn here. Click a box to open its code, right-click it for more analyses, and drag or scroll to move around. With the keyboard: Tab to the subject, arrow keys to move, Enter to open, Space to fold, + and − to zoom, 0 to fit, Home to return.</p>
<div id="stage">
<canvas id="grid" aria-hidden="true"></canvas>
<svg id="canvas" class="off" role="img" aria-label="Analysis diagram">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker><marker id="arrowOn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  <g id="scene"></g>
</svg>
</div>
<aside id="legend" hidden>
  <h2>Reading the chart</h2>
  <ul>
    <li><span class="swatch subject"></span>The subject of the analysis, such as the variable</li>
    <li><span class="swatch ok"></span>Safe or handled</li>
    <li><span class="swatch warning"></span>Needs a look, such as a value that may be undefined</li>
    <li><span class="swatch error"></span>A problem, such as an unhandled error</li>
    <li><span class="swatch info"></span>Worth knowing, such as a write</li>
    <li><span class="swatch group"></span>A group (dashed): gathers the boxes behind it and has no code of its own</li>
    <li><span class="swatch pattern"></span>A design pattern (purple hexagon, dotted line): how the code around the value is organized, not a place the value goes</li>
    <li><span class="glyph">→</span>The way the value moves: into the subject on the left, out of it on the right</li>
    <li><span class="glyph">3</span>A folded box and how many boxes it hides; click it, or press Space, to unfold</li>
  </ul>
  <h2>Keys</h2>
  <ul>
    <li><kbd>Tab</kbd> then arrow keys: move between boxes</li>
    <li><kbd>Enter</kbd> open the code · <kbd>Space</kbd> fold or unfold</li>
    <li><kbd>+</kbd> <kbd>−</kbd> zoom · <kbd>0</kbd> fit · <kbd>Home</kbd> back to the subject</li>
    <li>Double-click a box, or <kbd>B</kbd>: show only its branch · <kbd>Escape</kbd> the whole chart again</li>
    <li>Click a box: pulses flow along the lines between it and the subject (the <b>Flow</b> button turns this off) · click the background or <kbd>Escape</kbd> to stop</li>
    <li><kbd>Ctrl+F</kbd> find a box · <kbd>Enter</kbd> next match</li>
    <li>Right-click a box: Check for Null, Find Usages, Data Flow and more</li>
  </ul>
</aside>
<svg id="minimap" class="off" aria-label="Overview of the whole chart; click to move there" role="img"><g id="miniScene"></g><rect id="miniView"/></svg>
<footer id="info" aria-live="polite"></footer>
<script src="${asset('diagramGrid.js')}"></script>
<script src="${asset('diagram.js')}"></script>
</body>
</html>`;
  }
}

/** Asks where to save the chart's image, offering the workspace folder and a name from the analysis title. */
async function saveImage(content: Buffer, extension: 'svg' | 'png', title = 'diagram'): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const name = `${title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'}.${extension}`;
  const kind = extension.toUpperCase();
  const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined, filters: { [`${kind} image`]: [extension] }, title: `Save Diagram as ${kind}` });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, content);
  if ((await vscode.window.showInformationMessage(`Diagram saved to ${vscode.workspace.asRelativePath(target)}.`, 'Open')) === 'Open') {
    await vscode.commands.executeCommand('vscode.open', target);
  }
}
