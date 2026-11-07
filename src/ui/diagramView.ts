import * as vscode from 'vscode';
import { reportDiagram } from '../structure/diagram';
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
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; location?: ReportLocation }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.post(this.view.report);
      } else if (message.type === 'open' && message.location) {
        await this.view.open(message.location);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
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
  ${button('zoomOut', '−', 'Zoom out')}
  ${button('zoomIn', '+', 'Zoom in')}
  ${button('fit', 'Fit', 'Fit the diagram to the window')}
</header>
<p id="empty">Run an analysis, such as Data Flow, and it is drawn here. Click a box to open its code, right-click it for more analyses, and drag or scroll to move around. With the keyboard: Tab to the subject, arrow keys to move, Enter to open, Space to fold, + and − to zoom, 0 to fit, Home to return.</p>
<svg id="canvas" class="off" role="img" aria-label="Analysis diagram">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker><marker id="arrowOn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  <g id="scene"></g>
</svg>
<footer id="info" aria-live="polite"></footer>
<script src="${asset('diagram.js')}"></script>
</body>
</html>`;
  }
}
