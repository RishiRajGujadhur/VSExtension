import * as vscode from 'vscode';
import { ChartMeaning, MeaningItem, MeaningSource } from './chartMeaning';
import { followAnimations } from './animationSettings';
import { showProblem, unexpectedRemedies } from './problems';
import { offerSymbols } from './analysisActions';
import { AnalysisError } from '../analysis/types';
import { ProjectService } from '../analysis/project';
import { ControlFlowChart, chartMermaid, controlFlowChart, nodeAtOffset, nodeAtPosition } from '../inspect/controlFlowChart';
import { csharpFlowChart } from '../csharp/flow';
import { tsqlFlowChart } from '../tsql/flow';
import { normalizePath } from '../analysis/paths';
import { besideChartColumn, iconButton, saveImage, webviewPage, webviewRoots } from './webviewPage';
import { sliceAt } from '../inspect/slice';
import { boxAnalyses, menuAnalyses } from './diagramView';
import { pickGraph } from './graphSwitch';
import { graphOption, ReportControl, setGraphOption } from '../structure/graphOptions';
import { ReportLocation } from '../structure/report';
import { activeFeature } from './activeFeature';
import { editsFor, runEdit } from './editActionsUi';
import { compareCharts, findSameFunction, FlowComparison } from '../inspect/flowCompare';
import { standaloneCharts } from '../inspect/controlFlowChart';
import { fileAtRef } from '../navigate/graphDiff';

/**
 * The Control Flow view: a function's flowchart in an editor tab, with its paths listed beside it. It redraws as
 * the function is edited, outlines the box the editor's cursor is in, and opens the code of a clicked box.
 */
export class ControlFlowPanel {
  /** The code model in the flowchart, when you turn it on: what each box is for, and Find by meaning. */
  private readonly meaning = new ChartMeaning();

  /** The code model every chart may use (the Git reel's: one model, one download). */
  useCodeModel(source: MeaningSource): vscode.Disposable {
    this.meaning.use(source);
    return ChartMeaning.onChange(() => this.post());
  }

  /** For tests: what the flowchart was last told about the code model. */
  get meaningState(): ChartMeaning['state'] {
    return this.meaning.state;
  }

  /** Each box of the flowchart for the code model, keyed by its id; start and end have no code. */
  private postMeaning(): void {
    const items: MeaningItem[] = (this.chart?.nodes ?? []).filter((n) => n.kind !== 'start' && n.kind !== 'end').map((n) => ({ key: String(n.id), label: (n.lines[0] ?? '').trim(), text: n.text || n.lines.join(' ') }));
    void this.meaning.analyse(items, (state) => void this.panel?.webview.postMessage({ type: 'meaning', ...state }));
  }

  static readonly viewType = 'tsStructure.controlFlow';
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private chart: ControlFlowChart | undefined;
  /** The file and the function's offset in it, moved along with edits above it. */
  private target: { uri: vscode.Uri; anchor: number; folder?: string } | undefined;
  private refresh: NodeJS.Timeout | undefined;
  /** The code changed while the panel was hidden: it is drawn again when shown, not on every edit meanwhile. */
  private outdated = false;
  /** The parsed file the chart was drawn from, for finding the cursor's box without touching the project. */
  private source: import('typescript').SourceFile | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private cursorId: number | undefined;
  /** Calls expanded in place, by "file:offset"; cleared when another function is shown. */
  private expanded = new Set<string>();
  /** Boxes whose code was unfolded with their chip. */
  private unfolded = new Set<string>();
  /**
   * Compare with the last commit: on, the chart marks what changed in the function since then, and lists what is gone.
   * It stays on as the code is edited, so the marks follow the edits.
   */
  private comparing = false;
  /** The file as it was in the last commit, read once per file while comparing; undefined text when it is new. */
  private committed: { file: string; text: string | undefined } | undefined;
  private changes: FlowComparison | undefined;
  /** The slice on screen, sent after each chart until the code is edited. */
  private slice: { nodes: number[]; at: number; direction: 'backward' | 'forward'; name: string; line: number } | undefined;

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
        // Box numbers change with the code, so an edit ends the slice.
        this.slice = undefined;
        if (!this.panel.visible) {
          this.outdated = true;
          return;
        }
        this.refresh = setTimeout(() => this.build(), 400);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.panel || !this.chart || !this.target || e.textEditor.document.uri.toString() !== this.target.uri.toString()) return;
        if (!this.source && !isOtherLanguage(this.target.uri)) return;
        // The box under the cursor, from the file the chart was drawn from: moving the cursor never rebuilds the
        // project, and holding an arrow key sends one update rather than one per line.
        clearTimeout(this.cursorTimer);
        const active = e.selections[0].active;
        const offset = e.textEditor.document.offsetAt(active);
        this.cursorTimer = setTimeout(() => {
          if (!this.panel || !this.chart || !this.target) return;
          const id = this.source ? nodeAtOffset(this.chart, this.source, offset) : nodeAtPosition(this.chart, normalizePath(this.target.uri.fsPath), active.line, active.character);
          if (id === this.cursorId) return;
          this.cursorId = id;
          void this.panel.webview.postMessage({ type: 'cursor', id });
        }, 40);
      }),
    );
  }

  /** Opens the view on the function around the cursor with the slice of the variable there lit up. */
  showSlice(editor: vscode.TextEditor, direction: 'backward' | 'forward'): void {
    const uri = editor.document.uri;
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const offset = editor.document.offsetAt(editor.selection.active);
    try {
      const slice = sliceAt(this.projects.analysisProject(uri.fsPath, folder), uri.fsPath, offset, direction);
      const at = slice.cfg.nodes[slice.at].nodes[0];
      // The slice is about the function around the cursor, even when the cursor is on a call.
      const anchor = slice.cfg.fn.getStart();
      this.show(editor, anchor);
      this.slice = {
        nodes: slice.nodes,
        at: slice.at,
        direction,
        name: slice.name,
        line: at ? at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1 : editor.selection.active.line + 1,
      };
      this.post();
    } catch (error) {
      if (error instanceof AnalysisError) void offerSymbols(direction === 'backward' ? 'tsStructure.sliceBackward' : 'tsStructure.sliceForward', error, editor);
      else void showProblem(`Slice failed: ${String(error)}`, unexpectedRemedies('Slice', error));
    }
  }

  /** The dependence layer is turned on once the page is ready. */
  private pendingDeps = false;

  /** The Program Dependence Graph: the Control Flow view with its dependence layer on. */
  showDependences(editor: vscode.TextEditor): void {
    this.pendingDeps = true;
    this.show(editor);
    this.post();
  }

  /** Opens the view for the function at the editor's cursor (or the function called there). */
  show(editor: vscode.TextEditor, anchor?: number): void {
    const uri = editor.document.uri;
    this.expanded.clear();
    this.slice = undefined;
    this.target = { uri, anchor: anchor ?? editor.document.offsetAt(editor.selection.active), folder: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath };
    if (!this.build(editor)) return;
    activeFeature.set('tsStructure.controlFlow');
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(ControlFlowPanel.viewType, 'Control Flow', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewRoots(this.extensionUri) });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'structure-light.svg'), dark: vscode.Uri.joinPath(media, 'structure-dark.svg') };
    this.ready = false;
    this.panel.webview.html = html(this.panel.webview, this.extensionUri);
    followAnimations(this.panel);
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; location?: ReportLocation; svg?: string; png?: string; text?: string; command?: string; direction?: string; path?: { nodes: number[]; edges: number[] }; keys?: string[]; expand?: boolean; id?: string; value?: unknown; dependences?: boolean }) => {
      if (message.type === 'toggleMeaning') {
        await this.meaning.toggle();
      } else if (message.type === 'meaningFind' && typeof message.text === 'string') {
        // Find by meaning: the boxes whose code means what was typed, worked out here, nothing sent.
        const text = message.text;
        void this.panel?.webview.postMessage({ type: 'meaningFound', text, keys: await this.meaning.find(text) });
      } else if (message.type === 'ready') {
        this.ready = true;
        this.post();
      } else if (message.type === 'open' && message.location) {
        await openBeside(message.location);
      } else if (message.type === 'edits' && message.location) {
        const where = message.location;
        // The quick edits come from TypeScript; C# and T-SQL boxes have none.
        const edits = isOtherLanguage(vscode.Uri.file(where.file)) ? [] : await vscode.workspace.openTextDocument(where.file).then((d) => editsFor(d, where.line, where.character), () => []);
        void this.panel?.webview.postMessage({ type: 'edits', id: (message as { id?: unknown }).id, edits });
      } else if (message.type === 'edit' && message.location) {
        await runEdit(message.location.file, (message as { edit?: unknown }).edit);
      } else if (message.type === 'expand' && message.keys) {
        // Expand or collapse the calls of a box, then redraw with the called functions spliced in.
        for (const key of message.keys) {
          if (message.expand) this.expanded.add(key);
          else this.expanded.delete(key);
        }
        this.build();
      } else if (message.type === 'unfold' && typeof message.id === 'string') {
        // A box's "N more lines" chip, or its "Fold" chip: the chart is drawn again with the box's code shown or folded.
        if (message.expand) this.unfolded.add(message.id);
        else this.unfolded.delete(message.id);
        this.build();
      } else if (message.type === 'mermaid' && this.chart) {
        // The picked path, if any, is drawn thick in the copy too.
        await vscode.env.clipboard.writeText(['```mermaid', chartMermaid(this.chart, message.path, message.dependences === true), '```', ''].join('\n'));
        void vscode.window.setStatusBarMessage('Copied the control flow as Mermaid: paste it into Markdown, a GitHub issue or a pull request', 5000);
      } else if (message.type === 'save' && message.svg && this.chart) {
        await saveImage(Buffer.from(message.svg, 'utf8'), 'svg', `control-flow-${this.chart.name}`);
      } else if (message.type === 'otherGraphs' && this.chart) {
        // Another graph of the same function: from its start.
        const start = this.chart.nodes.find((n) => n.kind === 'start')?.location;
        if (start) await pickGraph(start);
      } else if (message.type === 'control' && message.id === 'callLevels') {
        // How many levels of calls are expanded in place: the chart is drawn again with them.
        if (setGraphOption('controlFlow', callLevelsControl(), message.value)) this.build();
      } else if (message.type === 'control' && message.id === 'code') {
        // Folded boxes, or all the code in every box.
        if (setGraphOption('controlFlow', codeControl(), message.value)) {
          this.unfolded.clear();
          this.build();
        }
      } else if (message.type === 'savePng' && message.png && this.chart) {
        await saveImage(Buffer.from(message.png, 'base64'), 'png', `control-flow-${this.chart.name}`);
      } else if (message.type === 'copy' && typeof message.text === 'string') {
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Copied', 3000);
      } else if (message.type === 'analyze' && message.command && message.location && boxAnalyses.some((a) => a.command === message.command)) {
        // A choice from a box's right-click menu: the same command the results view runs on a row.
        await vscode.commands.executeCommand(message.command, { file: message.location.file, line: message.location.line, character: message.location.character });
      } else if (message.type === 'sliceAt' && message.location && (message.direction === 'backward' || message.direction === 'forward')) {
        // What affects, or is affected by, the first value in a box: a slice from that statement.
        const where = message.location;
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(where.file), {
          selection: new vscode.Range(where.line, where.character, where.line, where.character),
          viewColumn: besideChartColumn(),
          preserveFocus: true,
        });
        this.showSlice(editor, message.direction);
      } else if (message.type === 'compare') {
        this.setComparing(!this.comparing);
      } else if (message.type === 'error' && message.text) {
        void vscode.window.showWarningMessage(message.text);
      }
    });
    this.panel.onDidChangeViewState(() => {
      if (this.panel?.visible && this.outdated) {
        this.outdated = false;
        this.build();
      }
    });
    this.panel.onDidDispose(() => {
      this.outdated = false;
      this.panel = undefined;
      this.chart = undefined;
      activeFeature.closed('tsStructure.controlFlow');
    });
  }

  /** The chart for the target, sent to the page; false when there is no function there. */
  /** C# (the bundled C# parser) and T-SQL (the T-SQL reader): syntax only, so no calls to expand. */
  private async buildOther(fromCommand?: vscode.TextEditor): Promise<void> {
    const target = this.target;
    if (!target) return;
    try {
      const document = await vscode.workspace.openTextDocument(target.uri);
      const code = { unfolded: this.unfolded, showAll: graphOption<string>('controlFlow', 'code', 'fold') === 'all' };
      const file = normalizePath(target.uri.fsPath);
      const chart = isTsqlFile(target.uri) ? tsqlFlowChart(document.getText(), file, target.anchor, code) : await csharpFlowChart(document.getText(), file, target.anchor, code);
      // Another chart was asked for meanwhile.
      if (this.target !== target) return;
      this.chart = chart;
      this.source = undefined;
      this.cursorId = undefined;
      target.anchor = chart.anchor;
      void this.publish();
    } catch (error) {
      if (fromCommand) {
        const message = error instanceof AnalysisError ? error.message : `Control Flow failed: ${String(error)}`;
        void showProblem(message, error instanceof AnalysisError ? [] : unexpectedRemedies('Control Flow', error));
      }
    }
  }

  private build(fromCommand?: vscode.TextEditor): boolean {
    if (!this.target) return false;
    if (isOtherLanguage(this.target.uri)) {
      void this.buildOther(fromCommand);
      return true;
    }
    try {
      const project = this.projects.analysisProject(this.target.uri.fsPath, this.target.folder);
      // Calls expanded in place: those picked with ƒ+, and every call down to the chosen number of levels.
      const levels = graphOption('controlFlow', 'callLevels', 0);
      let keys = new Set(this.expanded);
      const code = { unfolded: this.unfolded, showAll: graphOption<string>('controlFlow', 'code', 'fold') === 'all' };
      this.chart = controlFlowChart(project, this.target.uri.fsPath, this.target.anchor, keys, code);
      for (let level = 0; level < levels; level++) {
        const more = this.chart.nodes.flatMap((n) => n.calls.map((c) => c.key)).filter((k) => !keys.has(k));
        if (!more.length) break;
        keys = new Set([...keys, ...more]);
        this.chart = controlFlowChart(project, this.target.uri.fsPath, this.target.anchor, keys, code);
      }
      this.source = project.sourceFile(this.target.uri.fsPath);
      this.cursorId = undefined;
      // Follow the function itself from now on, not the cursor position it was found from.
      this.target.anchor = this.chart.anchor;
      void this.publish();
      return true;
    } catch (error) {
      if (fromCommand) {
        if (error instanceof AnalysisError) void offerSymbols('tsStructure.controlFlow', error, fromCommand);
        else void showProblem(`Control Flow failed: ${String(error)}`, unexpectedRemedies('Control Flow', error));
      }
      return false;
    }
  }

  /** Opens the view on the function at the cursor, compared with the last commit. */
  showComparison(editor: vscode.TextEditor): void {
    this.comparing = true;
    this.committed = undefined;
    this.show(editor);
  }

  /** Turns Compare with the last commit on or off, and draws the chart again with or without its marks. */
  private setComparing(on: boolean): void {
    this.comparing = on;
    this.committed = undefined;
    if (!on) this.changes = undefined;
    void this.publish();
  }

  /** Sends the chart, after comparing it with the last commit when that is on. */
  private async publish(): Promise<void> {
    const chart = this.chart;
    if (this.comparing && chart && this.target) {
      try {
        const changes = await this.compareWithCommit(this.target.uri, chart);
        // Another chart was drawn meanwhile: it sends its own.
        if (this.chart !== chart) return;
        this.changes = changes;
      } catch (error) {
        if (this.chart !== chart) return;
        this.comparing = false;
        this.changes = undefined;
        const why = error instanceof Error ? error.message : String(error);
        void showProblem(error instanceof AnalysisError ? `Compare with last commit needs the file in a git repository with at least one commit. ${why}` : `Compare with last commit failed: ${why}`, error instanceof AnalysisError ? [] : unexpectedRemedies('Compare with last commit', error));
      }
    } else this.changes = undefined;
    this.post();
  }

  /** The chart on screen against the same function in the last commit. */
  private async compareWithCommit(uri: vscode.Uri, chart: ControlFlowChart): Promise<FlowComparison> {
    const file = uri.fsPath;
    if (this.committed?.file !== file) this.committed = { file, text: fileAtRef(file).text };
    const before = this.committed.text;
    if (before === undefined) return { ...compareCharts(undefined, chart), against: 'the last commit (the file is new since then)' };
    const now = (await vscode.workspace.openTextDocument(uri)).getText();
    const normalized = normalizePath(file);
    let chartAt: (text: string, offset: number) => Promise<ControlFlowChart>;
    if (isTsqlFile(uri)) chartAt = async (text, offset) => tsqlFlowChart(text, normalized, offset);
    else if (isOtherLanguage(uri)) chartAt = (text, offset) => csharpFlowChart(text, normalized, offset);
    else {
      // Each text is parsed once, however many places in it are tried.
      const parsed = new Map<string, ReturnType<typeof standaloneCharts>>();
      chartAt = async (text, offset) => {
        let charts = parsed.get(text);
        if (!charts) parsed.set(text, (charts = standaloneCharts(file, text)));
        return charts(offset);
      };
    }
    const found = await findSameFunction({ text: now, chart }, before, chartAt);
    const result = compareCharts(found.chart, chart);
    return found.chart ? { ...result, byPosition: found.byPosition } : { ...result, against: 'the last commit (the function is new since then)' };
  }

  private post(): void {
    if (!this.panel || !this.ready) return;
    this.panel.title = this.chart ? `Flowchart: ${this.chart.name}()` : 'Flowchart';
    void this.panel.webview.postMessage({ type: 'chart', chart: this.chart, analyses: menuAnalyses(), controls: [callLevelsControl(), codeControl()], changes: this.changes, comparing: this.comparing });
    this.postMeaning();
    if (this.slice) void this.panel.webview.postMessage({ type: 'slice', slice: this.slice });
    if (this.pendingDeps && this.chart) {
      this.pendingDeps = false;
      void this.panel.webview.postMessage({ type: 'deps', on: true });
    }
  }

  /** For tests: what the chart on screen marks as changed since the last commit, when comparing. */
  get comparison(): FlowComparison | undefined {
    return this.changes;
  }

  /** For tests: the chart on screen. */
  get current(): ControlFlowChart | undefined {
    return this.chart;
  }
}

/** The toolbar control for how many levels of calls are expanded in place. */
function callLevelsControl(): ReportControl {
  return {
    id: 'callLevels',
    label: 'Calls expanded',
    description: 'How many levels of the functions it calls are drawn inside the chart: 0 is none; each ƒ+ button still expands one call',
    kind: 'levels',
    value: graphOption('controlFlow', 'callLevels', 0),
    min: 0,
    max: 3,
  };
}

/** Opens code in an editor group other than the one the chart is in. */
async function openBeside(location: ReportLocation): Promise<void> {
  const selection = new vscode.Range(location.line, location.character, location.endLine, location.endCharacter);
  await vscode.window.showTextDocument(vscode.Uri.file(location.file), { selection, viewColumn: besideChartColumn(), preserveFocus: false });
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const button = iconButton;
  return webviewPage(webview, extensionUri, {
    title: 'Control flow',
    images: true,
    styles: ['chart.css', 'controlFlow.css'],
    scripts: ['diagramGrid.js', 'chartKit.js', 'controlFlow.js'],
    body: `<header aria-label="Control flow tools">
  <span id="caption"></span>
  <span id="graphControls" aria-label="Graph options" hidden></span>
  <span class="search-box" role="search">
    <i class="codicon codicon-search" aria-hidden="true"></i>
    <input id="search" type="search" placeholder="Find in boxes (Ctrl+F)" aria-label="Find boxes by their code" aria-describedby="searchCount">
    <span id="searchCount" role="status" aria-live="polite"></span>
  </span>
  <span class="group" role="group" aria-label="Zoom">
  ${button('zoomOut', 'zoom-out', 'Zoom Out (−)')}
  <button id="zoomLevel" title="Zoom level: click for 100%" aria-label="Zoom level, click for 100%">100%</button>
  ${button('zoomIn', 'zoom-in', 'Zoom In (+)')}
  ${button('fit', 'screen-full', 'Fit the Whole Function (0)')}
  ${button('toCursor', 'target', 'Go to the Box at the Editor Cursor (C)')}
  </span>
  <span class="group" role="group" aria-label="Export">
  ${button('mermaid', 'markdown', 'Copy as Mermaid: the flowchart, with the picked path drawn thick')}
  ${button('save', 'save', 'Save as SVG image, in the current colors')}
  ${button('savePng', 'file-media', 'Save as PNG image, at twice the size')}
  </span>
  <span class="group" role="group" aria-label="Effects">
  ${button('effects', 'sparkle', 'Animated Grid: the dot grid behind the chart follows the pointer', 'aria-pressed="true"')}
  ${button('flowToggle', 'play-circle', 'Flow Animation: clicking a box animates every path through it (Escape stops it)', 'aria-pressed="true"')}
  ${button('meaning', 'wand', 'Code Model: what each box is for, and Find by meaning', 'aria-pressed="false" hidden')}
  </span>
  ${button('otherGraphs', 'graph-scatter', 'Other Graphs of This Function: draw it another way (G)')}
  ${button('compare', 'git-commit', 'Compare with Last Commit: mark what changed in this function since the last commit, and list what is gone (V)', 'aria-pressed="false"')}
  ${button('deps', 'references', 'Dependences: the program dependence graph, where each value comes from and what controls each box (D)', 'aria-pressed="false"')}
  ${button('togglePaths', 'list-tree', 'Paths: every way through the function (P)', 'aria-pressed="true" aria-controls="explorer"')}
  ${button('legendButton', 'question', 'Legend: what the shapes, colors and keys mean', 'aria-expanded="false" aria-controls="legend"')}
</header>
<div id="typeBar" role="group" aria-label="Kinds of boxes: press one to light those boxes up" hidden></div>
<p id="empty">Put the cursor in a function and run <strong>Control Flow Graph</strong> (Ctrl+Alt+S 1) to draw it here.</p>
<main>
<div id="stage">
<canvas id="grid" aria-hidden="true"></canvas>
<canvas id="flowLines" aria-hidden="true"></canvas>
<svg id="canvas" class="off" tabindex="-1" role="application" aria-roledescription="flowchart" aria-label="Flowchart. Tab and Shift+Tab move between boxes in reading order, the arrow keys follow the flow, Enter opens the code, F animates the paths through a box, Shift+F10 opens the menu.">
  <defs><marker id="dataArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker><marker id="controlArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  <g id="scene"></g>
</svg>
<svg id="minimap" class="off" aria-hidden="true"><g class="mini-scene"></g><rect id="miniView"/></svg>
<div id="info" role="status" aria-live="polite"></div>
</div>
<aside id="explorer" aria-label="Paths">
  <h2>Paths</h2>
  <div id="pathSummary" role="status"></div>
  <p class="hint">Pick a path to light up its route, Shift+click another to compare them, or click a branch label (yes, no, case…) to keep only the paths through it.</p>
  <div class="options">
    <label><input type="checkbox" id="showImpossible"> Show impossible paths</label>
    <button id="clearPins" title="Remove every branch filter and the selected path (Escape)">Clear</button>
  </div>
  <div id="changes" role="region" aria-label="Changes since the last commit" hidden></div>
  <div id="pins" aria-label="Branches the paths must take"></div>
  <div id="comparison" role="status" hidden></div>
  <ul id="paths" role="tree" aria-label="Paths through the function, grouped by how they end"></ul>
</aside>
</main>
<div id="boxMenu" role="dialog" aria-label="Box actions" hidden></div>
<aside id="legend" aria-label="Legend" hidden>
  <h2>Shapes</h2>
  <ul>
    <li><span class="swatch terminal start"></span> Start: the function is called</li>
    <li><span class="swatch terminal end"></span> End: every way out of the function</li>
    <li><span class="swatch decision"></span> Decision: if, ?:, while and switch</li>
    <li><span class="swatch loop"></span> Loop: for, for…of, while</li>
    <li><span class="swatch statement"></span> Code that runs in order</li>
    <li><span class="swatch return"></span> Return <span class="swatch throw"></span> Throw</li>
    <li><span class="swatch unreachable"></span> Unreachable: nothing leads here</li>
  </ul>
  <h2>Lines</h2>
  <ul>
    <li><span class="line-sample"></span> Next step; dashed: back to a loop</li>
    <li><span class="line-sample on"></span> The picked path; orange: the one compared with it</li>
    <li><span class="line-sample data"></span> Dependence (D): a value set there is read here</li>
    <li><span class="line-sample control"></span> Dependence (D): the decision controls whether this runs</li>
  </ul>
  <h2>Keys</h2>
  <ul class="keys">
    <li><kbd>Tab</kbd> a box, <kbd>↑</kbd><kbd>↓</kbd> follow the flow, <kbd>←</kbd><kbd>→</kbd> the same row</li>
    <li><kbd>Enter</kbd> open its code, <kbd>Shift+F10</kbd> its menu, <kbd>F</kbd> animate its paths</li>
    <li><kbd>Ctrl+F</kbd> find, <kbd>+</kbd> <kbd>−</kbd> zoom, <kbd>0</kbd> fit, <kbd>C</kbd> cursor box, <kbd>P</kbd> paths, <kbd>D</kbd> dependences, <kbd>N</kbd> next box of a slice, <kbd>M</kbd> minimap, <kbd>Esc</kbd> clear</li>
  </ul>
</aside>`,
  });
}

/** The toolbar control for how much code the boxes show: a few lines with a chip for the rest, or all of it. */
function codeControl(): ReportControl {
  return {
    id: 'code',
    label: 'Code in boxes',
    description: 'Folded shows the first lines of a long box with a chip that unfolds it; All shows every line in every box',
    kind: 'choice',
    value: graphOption('controlFlow', 'code', 'fold'),
    choices: [
      { id: 'fold', label: 'Folded' },
      { id: 'all', label: 'Show all code' },
    ],
  };
}

/** A file charted without TypeScript: C# by the bundled parser, T-SQL by the T-SQL reader. */
const isTsqlFile = (uri: vscode.Uri): boolean => uri.fsPath.toLowerCase().endsWith('.sql');
const isOtherLanguage = (uri: vscode.Uri): boolean => uri.fsPath.toLowerCase().endsWith('.cs') || isTsqlFile(uri);
