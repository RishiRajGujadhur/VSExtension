import ts = require('typescript');
import { bundleWeightReport } from '../navigate/bundleWeight';
import { graphOption, setGraphOption } from '../structure/graphOptions';
import { termFor } from '../structure/glossary';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportLocation, ReportNode } from '../structure/report';
import { retarget } from '../structure/retarget';
import { dataFlowReport } from '../inspect/dataFlow';
import { raceReport, variableMutationReport } from '../inspect/races';
import { patternMeaning, patternsReport } from '../inspect/patterns';
import { patternLink } from '../inspect/patternLinks';
import { cyclesReport, dependentsReport } from '../navigate/moduleUsers';
import { mutationReport, sideEffectReport } from '../inspect/effects';
import { assertionAuditReport } from '../inspect/assertionAudit';
import { nullabilityReport } from '../inspect/nullability';
import { rejectionReport } from '../inspect/rejections';
import { deadExportReport } from '../inspect/deadExports';
import { exceptionFlowReport } from '../inspect/exceptionFlow';
import { copiesReport, duplicatesReport } from '../inspect/duplicates';
import { semanticUsagesReport } from '../navigate/usages';
import { reexportChainReport } from '../navigate/reexports';
import { hierarchyReport, overrideImpactReport } from '../navigate/hierarchy';
import { dependencyPathReport, distancesFrom } from '../navigate/dependencyPaths';
import { argumentFlowReport } from '../navigate/argumentFlow';
import { CallDirection, callGraphReport } from '../navigate/callGraph';
import { reactStateReport } from '../inspect/reactState';
import { discoverTests } from '../analysis/testDiscovery';
import { defaultEntryPoints, programGraph } from '../navigate/moduleGraph';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { normalizePath, pathKey } from '../analysis/paths';
import { registerReportActions } from './reportActions';
import { isExcluded, scopedFiles, withNote } from './exclude';
import { ChosenScope, ScopeKind, ScopeRequest, chooseScope, openSourceFiles } from './analysisScope';
import { limitReport, locationFilter, scopeFilter } from '../structure/scope';
import { reportError } from './applyRefactor';
import { sourceEditor } from './refactorCommands';
import { StructureView } from './structureView';
import { registerCommand } from './features';
import { explanations, guideUrl } from '../structure/explanations';
import { relatedAnalyses } from '../structure/related';
import { commandIcons } from '../structure/icons';
import { featureOf } from '../structure/features';
import { isFeatureEnabled } from './features';
import { reportCsv } from '../structure/markdown';
import { AnalysisError } from '../analysis/types';
import { analyzeSymbol, offerSymbols } from './analysisActions';
import { explainValueReport } from '../inspect/paths';
import { asyncTimelineReport, valueTimelineReport } from '../inspect/timelines';

/** The file, cursor and project an analysis runs against, captured so it can be re-run later. */
export interface AnalysisTarget {
  fileName: string;
  offset: number;
  end: number;
  folder?: string;
  project(): VirtualProject;
}

type Compute = (target: AnalysisTarget) => Report | Promise<Report | undefined> | undefined;

/** The analysis running now, which the results view's Stop button cancels. */
let running: vscode.CancellationTokenSource | undefined;

/** Stops the running analysis: its result is not shown, and Inspect Code stops between files. */
export function cancelRunningAnalysis(): void {
  running?.cancel();
}

/**
 * Runs work while the results view shows a progress bar, a "Running …" message and a Stop button.
 * The token is cancelled by Stop or by starting another analysis.
 */
export async function withRunning<T>(view: StructureView, title: string, work: (token: vscode.CancellationToken) => Thenable<T>): Promise<T | undefined> {
  running?.cancel();
  const source = new vscode.CancellationTokenSource();
  running = source;
  view.setRunning(title);
  void vscode.commands.executeCommand('setContext', 'tsStructure.running', true);
  try {
    const result = await vscode.window.withProgress({ location: { viewId: 'tsStructure.report' } }, () => work(source.token));
    if (source.token.isCancellationRequested) {
      void vscode.window.setStatusBarMessage(`$(debug-stop) ${title} cancelled`, 3000);
      return undefined;
    }
    return result;
  } finally {
    if (running === source) {
      running = undefined;
      view.setRunning(undefined);
      void vscode.commands.executeCommand('setContext', 'tsStructure.running', false);
    }
    source.dispose();
  }
}

/** Runs an analysis with progress and shows its report, keeping a closure to re-run it. */
export async function runAnalysis(view: StructureView, title: string, compute: () => Report | Promise<Report | undefined> | undefined): Promise<Report | undefined> {
  const run = async () => {
    try {
      // A spinner in the status bar by default; a notification when tsStructure.results.progress asks for one.
      const location = vscode.workspace.getConfiguration('tsStructure.results').get<string>('progress', 'statusBar') === 'notification' ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window;
      return await withRunning(view, title, (token) =>
        vscode.window.withProgress({ location, title: `${title}…`, cancellable: location === vscode.ProgressLocation.Notification }, async (_progress, notificationToken) => {
          notificationToken.onCancellationRequested(() => cancelRunningAnalysis());
          // Let the progress render before the synchronous analysis starts.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (token.isCancellationRequested) {
            return undefined;
          }
          const started = Date.now();
          const report = await compute();
          if (report) {
            report.durationMs = Date.now() - started;
          }
          return report;
        }),
      );
    } catch (error) {
      reportError(error, title);
      return undefined;
    }
  };
  const report = await run();
  if (report) {
    await view.show(report, run);
  }
  return report;
}

export function editorTarget(projects: ProjectService, editor: vscode.TextEditor): AnalysisTarget {
  const document = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  return {
    fileName: document.uri.fsPath,
    offset: document.offsetAt(editor.selection.active),
    end: document.offsetAt(editor.selection.end),
    folder,
    project: () => projects.analysisProject(document.uri.fsPath, folder),
  };
}

/** Dead exports of the target's project; `inside` limits the results (not what counts as used) to some files. */
async function deadExports(t: AnalysisTarget, inside?: (fileName: string) => boolean): Promise<Report> {
  const program = t.project().program();
  const config = vscode.workspace.getConfiguration('tsStructure.deadExports', vscode.Uri.file(t.fileName));
  const root = t.folder ?? path.dirname(t.fileName);
  const globs = config.get<string[]>('entryPoints', []);
  let entryPoints: string[] = [];
  if (globs.length > 0 && t.folder) {
    const found = await Promise.all(globs.map((g) => vscode.workspace.findFiles(new vscode.RelativePattern(t.folder!, g), '**/node_modules/**')));
    entryPoints = found.flat().map((u) => u.fsPath);
  } else {
    entryPoints = defaultEntryPoints(root, new Set(projectSourceFiles(program).map((f) => normalizePath(f.fileName))));
  }
  const excluded = inside ? (file: string) => isExcluded(file) || !inside(file) : isExcluded;
  return deadExportReport(program, { entryPoints, testsAreEntryPoints: config.get('testFilesAreEntryPoints', true), isExcluded: excluded }, root);
}

/** The first TypeScript or JavaScript file among the picked files, or inside the picked folders. */
async function firstSourceFile(uris: readonly vscode.Uri[]): Promise<vscode.Uri | undefined> {
  for (const uri of uris) {
    if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.Directory) {
      if (/\.[cm]?[jt]sx?$/.test(uri.fsPath)) {
        return uri;
      }
      continue;
    }
    const [found] = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'), '**/node_modules/**', 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Opens a row's location and runs an analysis there, such as Find Usages of the symbol a row points at. */
/** Words that start a declaration or statement; an analysis started on one moves on to the name after it. */
const keywords = new Set('export default async function const let var class interface type enum return await new if while for switch case throw yield void typeof delete import from public private protected static readonly abstract get set declare namespace'.split(' '));

/**
 * Runs an analysis where a row points. The row is a result row, or the context of a diagram node
 * (which carries file, line and character itself). A row that starts on a keyword, such as a function
 * row on `export function`, runs on the name that follows.
 */
async function runAt(view: StructureView, node: ReportNode | { file?: string; line?: number; character?: number } | undefined, command: string): Promise<unknown> {
  const fromRow = (node as ReportNode | undefined)?.location;
  const plain = node as { file?: string; line?: number; character?: number } | undefined;
  const location = fromRow ?? (plain?.file !== undefined && plain.line !== undefined ? { file: plain.file, line: plain.line, character: plain.character ?? 0, endLine: plain.line, endCharacter: plain.character ?? 0 } : undefined);
  if (!location) {
    return;
  }
  await view.open(location);
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.lineCount > location.line) {
    const text = editor.document.lineAt(location.line).text;
    const words = /[A-Za-z_$][\w$]*/g;
    words.lastIndex = location.character;
    let word = words.exec(text);
    while (word && keywords.has(word[0])) {
      word = words.exec(text);
    }
    if (word && word.index !== location.character) {
      const position = new vscode.Position(location.line, word.index);
      editor.selection = new vscode.Selection(position, position);
    }
  }
  return vscode.commands.executeCommand(command);
}

/** The scope's name in the title, and only the rows inside its lines when it is a function or selection. */
function inScope(report: Report | undefined, scope: ChosenScope): Report | undefined {
  if (report && scope.label) {
    // "Type assertions in the project" becomes "Type assertions in src/cart".
    report.title = report.title.includes(' in the project') ? report.title.replace(' in the project', ` in ${scope.label}`) : `${report.title} in ${scope.label}`;
  }
  if (report && scope.spec.lines) {
    report.roots = limitReport(report.roots, locationFilter(scope.spec));
  }
  return report;
}

/** The project's source files inside the scope and the analysis scope settings. */
function filesIn(program: ts.Program, scope: ChosenScope): { files: ts.SourceFile[]; note?: string } {
  const inside = scopeFilter(scope.spec);
  const candidates = projectSourceFiles(program).filter((sf) => inside(sf.fileName));
  // A single file asked for by name is analyzed even when the scope settings leave it out.
  return scope.kind === 'file' || scope.spec.lines ? { files: candidates } : scopedFiles(candidates);
}

const recentDependencyKey = 'tsStructure.dependencyPath.recent';

/** Position in a most-recent-first list, with files not in it after every one that is. */
function rank(recent: readonly string[], file: string): number {
  const index = recent.findIndex((r) => pathKey(r) === pathKey(file));
  return index < 0 ? recent.length : index;
}

/** Scopes for analyses that look at every file. */
const projectScopes: readonly ScopeKind[] = ['project', 'folder', 'pickFolder', 'open', 'changed', 'file'];
const fineScopes: readonly ScopeKind[] = [...projectScopes, 'function', 'selection'];

/**
 * Runs an analysis that starts from the symbol at the cursor. When there is nothing there for it,
 * the message offers the file's declarations to start from instead.
 */
async function startingAtCursor(command: string, editor: vscode.TextEditor, compute: () => Report | Promise<Report | undefined> | undefined): Promise<Report | undefined> {
  try {
    const report = await compute();
    return report && withNext(report, editor);
  } catch (error) {
    if (error instanceof AnalysisError) {
      void offerSymbols(command, error, editor);
      return undefined;
    }
    throw error;
  }
}

/** Adds a Next group: the analyses worth running on the same symbol, each a click away. */
function withNext(report: Report, editor: vscode.TextEditor): Report {
  if (report.kind === 'dataFlow' && !vscode.workspace.getConfiguration('tsStructure', editor.document.uri).get('dataFlow.designPatterns', true)) {
    report.roots = report.roots.filter((r) => r.label !== 'Design patterns');
  }
  const related = (relatedAnalyses[report.kind] ?? []).filter((r) => {
    const feature = featureOf(r.command);
    return !feature || isFeatureEnabled(feature.id);
  });
  if (related.length === 0) {
    return report;
  }
  const file = editor.document.uri.fsPath;
  const offset = editor.document.offsetAt(editor.selection.active);
  report.roots.push({
    label: 'Next',
    description: 'run another analysis here',
    icon: 'arrow-right',
    children: related.map((r) => ({ label: r.title, icon: commandIcons[r.command] ?? 'play', action: { kind: 'follow', command: r.command, file, offset } })),
  });
  return report;
}

/** The same target after the file was edited: the cursor follows the symbol it was on. */
function followEdits(target: AnalysisTarget, before: string | undefined): AnalysisTarget {
  const document = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === pathKey(target.fileName));
  const now = document?.getText();
  if (before === undefined || now === undefined || now === before) {
    return target;
  }
  const offset = retarget(before, now, target.offset);
  return { ...target, offset, end: Math.max(offset, retarget(before, now, target.end)) };
}

export function registerAnalyses(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  let latestArgumentRun: { extra: number } | undefined;
  /** A command that analyzes the symbol or selection in the active editor. Returns the report for tests and other extensions. */
  const editorCommand = (id: string, title: string, compute: Compute) =>
    registerCommand(id, () => {
      const editor = sourceEditor();
      if (editor) {
        const target = editorTarget(projects, editor);
        const text = editor.document.getText();
        // The progress names what is analyzed: "Data Flow of total…".
        const word = editor.document.getWordRangeAtPosition(editor.selection.active);
        const subject = word && id !== 'tsStructure.mutationTracking' ? ` of ${editor.document.getText(word)}` : '';
        return runAnalysis(view, `${title}${subject}`, () => startingAtCursor(id, editor, () => compute(followEdits(target, text))));
      }
    });

  /** An analysis over many files that first asks where to look; re-running it keeps that scope. */
  const scopedCommand = (id: string, title: string, request: Omit<ScopeRequest, 'editor' | 'title'>, compute: (t: AnalysisTarget, scope: ChosenScope) => Report | Promise<Report | undefined> | undefined) =>
    registerCommand(id, async (arg?: unknown, selected?: vscode.Uri[]) => {
      // From the Explorer: the folders and files picked there, without asking.
      if (arg instanceof vscode.Uri) {
        const uris = selected?.length ? selected : [arg];
        const anchor = await firstSourceFile(uris);
        if (!anchor) {
          void vscode.window.showInformationMessage('There are no TypeScript or JavaScript files there.');
          return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(anchor)?.uri.fsPath;
        const kinds = await Promise.all(uris.map(async (u) => (await vscode.workspace.fs.stat(u)).type === vscode.FileType.Directory));
        const scope: ChosenScope = {
          kind: 'folder',
          label: uris.map((u) => vscode.workspace.asRelativePath(u)).join(', '),
          spec: { folders: uris.filter((_, i) => kinds[i]).map((u) => u.fsPath), files: uris.filter((_, i) => !kinds[i]).map((u) => u.fsPath) },
        };
        const target: AnalysisTarget = { fileName: anchor.fsPath, offset: 0, end: 0, folder, project: () => projects.analysisProject(anchor.fsPath, folder) };
        return runAnalysis(view, title, async () => inScope(await compute(target, scope), scope));
      }
      const editor = sourceEditor();
      if (!editor) {
        return;
      }
      const scope = await chooseScope({ ...request, title, editor }, arg);
      if (!scope) {
        return;
      }
      const target = editorTarget(projects, editor);
      const text = editor.document.getText();
      return runAnalysis(view, title, async () => inScope(await compute(followEdits(target, text), scope), scope));
    });

  registerReportActions(context, view);
  context.subscriptions.push(
    view.view,
    ...view.listeners(),
    registerCommand('tsStructure.openLocation', (location: ReportLocation) => view.open(location)),
    registerCommand('tsStructure.report.back', () => view.go(-1)),
    registerCommand('tsStructure.report.forward', () => view.go(1)),
    registerCommand('tsStructure.report.filter', () => view.setFilter()),
    registerCommand('tsStructure.report.chooseGroups', (labels?: string[]) => view.chooseGroups(labels)),
    registerCommand('tsStructure.report.next', () => view.step(1)),
    registerCommand('tsStructure.report.expandAll', () => view.expandAll()),
    registerCommand('tsStructure.report.history', () => view.pickHistory()),
    // Any report: only the rows in a folder, the changed files, the current function and so on.
    registerCommand('tsStructure.report.limitScope', async (arg?: unknown) => {
      if (!view.report) {
        return;
      }
      const active = vscode.window.activeTextEditor;
      const editor = active?.document.uri.scheme === 'file' ? active : undefined;
      const scope = await chooseScope(
        {
          id: 'limitResults',
          title: 'Limit results to scope',
          alwaysAsk: true,
          kinds: [...fineScopes],
          editor,
          labels: { project: { label: '$(clear-all) All results', description: 'Show every row again' } },
        },
        arg,
      );
      if (scope) {
        view.limitTo(scope.kind === 'project' ? undefined : { label: scope.label ?? scope.kind, inside: locationFilter(scope.spec) });
      }
    }),
    registerCommand('tsStructure.report.clearLimit', () => view.limitTo(undefined)),
    registerCommand('tsStructure.report.clearFilters', () => view.clearFilters()),
    registerCommand('tsStructure.cancelAnalysis', () => cancelRunningAnalysis()),
    // Data Flow: steps under Flows in and Flows out, or one group per function.
    registerCommand('tsStructure.report.flowByDirection', async () => {
      await vscode.workspace.getConfiguration('tsStructure').update('dataFlow.groupByDirection', true, vscode.ConfigurationTarget.Global);
      await view.rerun();
    }),
    registerCommand('tsStructure.report.flowByFunction', async () => {
      await vscode.workspace.getConfiguration('tsStructure').update('dataFlow.groupByDirection', false, vscode.ConfigurationTarget.Global);
      await view.rerun();
    }),
    registerCommand('tsStructure.report.fewerButtons', () => vscode.workspace.getConfiguration('tsStructure').update('results.toolbar', 'essential', vscode.ConfigurationTarget.Global)),
    registerCommand('tsStructure.report.allButtons', () => vscode.workspace.getConfiguration('tsStructure').update('results.toolbar', 'all', vscode.ConfigurationTarget.Global)),
    registerCommand('tsStructure.toggleAssertionTests', async () => {
      const config = vscode.workspace.getConfiguration('tsStructure');
      const skip = !config.get('typeAssertion.ignoreTestFiles', false);
      await config.update('typeAssertion.ignoreTestFiles', skip, vscode.ConfigurationTarget.Workspace);
      void vscode.window.setStatusBarMessage(skip ? 'Type assertions in test files are now skipped' : 'Type assertions in test files are checked again', 4000);
    }),
    registerCommand('tsStructure.inspectOpen', () => vscode.commands.executeCommand('tsStructure.inspectCode', 'open')),
    registerCommand('tsStructure.inspectChanged', () => vscode.commands.executeCommand('tsStructure.inspectCode', 'changed')),
    registerCommand('tsStructure.analyzeSymbol', () => {
      const editor = sourceEditor();
      return editor && analyzeSymbol(editor);
    }),
    registerCommand('tsStructure.report.rerunOutdated', () => view.rerun()),
    registerCommand('tsStructure.report.explainPattern', async (node: ReportNode) => {
      const name = String(node?.action?.name ?? '');
      if (name) {
        const url = patternLink(name);
        const choice = await vscode.window.showInformationMessage(name, { modal: true, detail: `${patternMeaning(name)}\n\nIn this code: ${node.description ?? node.label}` }, ...(url ? ['Learn More'] : []));
        if (choice && url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    }),
    registerCommand('tsStructure.report.explainTerm', async (node: ReportNode) => {
      const term = node && termFor(node.label, node.description);
      if (term) {
        const detail = `${term.meaning}${term.example ? `\n\nFor example:\n${term.example}` : ''}`;
        if ((await vscode.window.showInformationMessage(term.term, { modal: true, detail }, 'Learn More')) === 'Learn More') {
          await vscode.env.openExternal(vscode.Uri.parse(term.url));
        }
      }
    }),
    registerCommand('tsStructure.report.learnPattern', async (node: ReportNode) => {
      const url = patternLink(String(node?.action?.name ?? ''));
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    registerCommand('tsStructure.report.openFiles', async () => {
      // Opening dozens of tabs helps nobody: the first ten, with a note about the rest.
      const files = view.files();
      for (const file of files.slice(0, 10)) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, preserveFocus: true });
      }
      if (files.length > 10) {
        void vscode.window.showInformationMessage(`Opened the first 10 of ${files.length} files.`);
      }
    }),
    registerCommand('tsStructure.report.copyCode', async (node: ReportNode) => {
      const line = view.codeLine(node ?? view.view.selection[0]);
      if (line) {
        await vscode.env.clipboard.writeText(line);
        void vscode.window.setStatusBarMessage('Copied the line of code', 3000);
      }
    }),
    registerCommand('tsStructure.report.copyCsv', async () => {
      const report = view.report;
      if (report) {
        await vscode.env.clipboard.writeText(reportCsv(report.roots, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath));
        void vscode.window.setStatusBarMessage('Analysis copied as CSV', 3000);
      }
    }),
    // The report as a formatted document beside the editor, to read or print.
    registerCommand('tsStructure.report.preview', async () => {
      const markdown = view.markdown();
      if (markdown) {
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
        await vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri);
      }
    }),
    registerCommand('tsStructure.report.toggleRerunOnSave', async () => {
      const config = vscode.workspace.getConfiguration('tsStructure.results');
      const on = !config.get('rerunOnSave', false);
      await config.update('rerunOnSave', on, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Re-run on save ${on ? 'on: saving a file the report covers refreshes it' : 'off'}`, 4000);
    }),
    registerCommand('tsStructure.report.copyLocations', async () => {
      const lines = view.locations();
      await vscode.env.clipboard.writeText(lines.join('\n'));
      void vscode.window.setStatusBarMessage(`Copied ${lines.length} location${lines.length === 1 ? '' : 's'}`, 3000);
    }),
    // Right-click on a row: start from where it points.
    registerCommand('tsStructure.report.revealInExplorer', (node: ReportNode) => node?.location && vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.location.file))),
    registerCommand('tsStructure.report.excludeFile', (node: ReportNode) => node?.location && vscode.commands.executeCommand('tsStructure.excludeFromAnalysis', vscode.Uri.file(node.location.file))),
    registerCommand('tsStructure.report.usagesHere', (node: ReportNode) => runAt(view, node, 'tsStructure.semanticUsages')),
    registerCommand('tsStructure.report.dataFlowHere', (node: ReportNode) => runAt(view, node, 'tsStructure.dataFlow')),
    registerCommand('tsStructure.report.nullabilityHere', (node: ReportNode) => runAt(view, node, 'tsStructure.nullability')),
    registerCommand('tsStructure.report.mutationsHere', (node: ReportNode) => runAt(view, node, 'tsStructure.mutationTrackingVariable')),
    registerCommand('tsStructure.report.racesHere', (node: ReportNode) => runAt(view, node, 'tsStructure.raceConditions')),
    registerCommand('tsStructure.report.sideEffectsHere', (node: ReportNode) => runAt(view, node, 'tsStructure.sideEffects')),
    registerCommand('tsStructure.report.exceptionsHere', (node: ReportNode) => runAt(view, node, 'tsStructure.exceptionFlow')),
    registerCommand('tsStructure.report.argumentsHere', (node: ReportNode) => runAt(view, node, 'tsStructure.argumentFlow')),
    // The info button: what the report on screen shows and the words it uses, such as what a mutation is.
    registerCommand('tsStructure.report.about', async () => {
      const explanation = view.report && explanations[view.report.kind];
      if (!explanation) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(explanation.title, { modal: true, detail: explanation.text }, 'Open Guide');
      if (choice) {
        await vscode.env.openExternal(vscode.Uri.parse(guideUrl + explanation.anchor));
      }
    }),
    registerCommand('tsStructure.toggleHighlights', async () => {
      const config = vscode.workspace.getConfiguration('tsStructure');
      const on = !config.get('highlightResults', true);
      await config.update('highlightResults', on, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Result highlights ${on ? 'on' : 'off'}`, 3000);
    }),
    registerCommand('tsStructure.report.copyRow', async (node: ReportNode, selected?: ReportNode[]) => {
      // From a key there is no row argument: the rows selected in the view.
      const rows = selected?.length ? selected : node ? [node] : [...view.view.selection];
      if (rows.length) {
        await vscode.env.clipboard.writeText(rows.map((r) => view.rowText(r)).join('\n'));
        void vscode.window.setStatusBarMessage(`Copied ${rows.length === 1 ? 'the row' : `${rows.length} rows`}`, 3000);
      }
    }),
    registerCommand('tsStructure.report.previous', () => view.step(-1)),
    registerCommand('tsStructure.report.copyMarkdown', async () => {
      const markdown = view.markdown();
      if (markdown) {
        await vscode.env.clipboard.writeText(markdown);
        void vscode.window.setStatusBarMessage('Analysis copied as Markdown', 3000);
      }
    }),
    registerCommand('tsStructure.report.export', async () => {
      const markdown = view.markdown();
      const report = view.report;
      if (!markdown || !report) {
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const name = `${report.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'analysis'}.md`;
      const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined, filters: { Markdown: ['md'] } });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
        await vscode.window.showTextDocument(uri);
      }
    }),
    // For scripts and CI: the report's rows with workspace-relative locations, without view-only details.
    registerCommand('tsStructure.report.exportJson', async () => {
      const report = view.report;
      if (!report) {
        return;
      }
      const row = (node: ReportNode): object => ({
        label: node.label,
        description: node.description,
        tone: node.tone,
        location: node.location ? { file: vscode.workspace.asRelativePath(node.location.file), line: node.location.line + 1, character: node.location.character + 1 } : undefined,
        children: node.children?.length ? node.children.map(row) : undefined,
      });
      const json = JSON.stringify({ kind: report.kind, title: report.title, description: report.description, warnings: report.warnings, durationMs: report.durationMs, rows: report.roots.map(row) }, null, 2);
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const name = `${report.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'analysis'}.json`;
      const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined, filters: { JSON: ['json'] } });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
        void vscode.window.setStatusBarMessage(`Analysis exported to ${vscode.workspace.asRelativePath(uri)}`, 4000);
      }
    }),
    registerCommand('tsStructure.report.openToSide', (node: ReportNode) => node?.location && view.open(node.location, true)),
    registerCommand('tsStructure.report.copyLocation', async (arg?: ReportNode) => {
      const node = arg ?? view.view.selection[0];
      if (node?.location) {
        await vscode.env.clipboard.writeText(`${vscode.workspace.asRelativePath(node.location.file)}:${node.location.line + 1}:${node.location.character + 1}`);
      }
    }),
    registerCommand('tsStructure.rerunAnalysis', () => view.rerun()),
    // A graph's levels or other options, then the analysis again with them.
    registerCommand('tsStructure.report.changeControls', (id?: string, value?: unknown) => changeControls(view, id, value)),
    registerCommand('tsStructure.clearReport', () => view.clear()),
    editorCommand('tsStructure.dataFlow', 'Data Flow', (t) => dataFlowReport(t.project(), t.fileName, t.offset, { byDirection: vscode.workspace.getConfiguration('tsStructure').get('dataFlow.groupByDirection', true) })),
    editorCommand('tsStructure.mutationTracking', 'Mutation Tracking', (t) => mutationReport(t.project().program(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTrackingVariable', 'Mutation Tracking', (t) => variableMutationReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.raceConditions', 'Race Conditions', (t) => raceReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.explainValue', 'Explain Value Path', (t) => explainValueReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.valueTimeline', 'Value timeline', (t) => valueTimelineReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.asyncTimeline', 'Async timeline', (t) => asyncTimelineReport(t.project(), t.fileName, t.offset)),
    scopedCommand('tsStructure.mutationTrackingProject', 'Mutation Tracking', { id: 'mutations', kinds: projectScopes.filter((k) => k !== 'file') }, (t, scope) => {
      const program = t.project().program();
      const { files, note } = filesIn(program, scope);
      return withNote(mutationReport(program, t.fileName, t.offset, files), note);
    }),
    editorCommand('tsStructure.nullability', 'Nullability', (t) => nullabilityReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.promiseRejections', 'Promise rejections', (t) => rejectionReport(t.project(), t.fileName, t.offset)),
    // The whole project still decides what is used; the scope only limits which exports are reported.
    scopedCommand('tsStructure.deadExports', 'Dead Export Analysis', { id: 'deadExports', kinds: fineScopes }, (t, scope) => deadExports(t, scope.kind === 'project' ? undefined : scopeFilter(scope.spec))),
    // From the Explorer: only the dead exports in the folders picked, with the whole project still deciding what is used.
    registerCommand('tsStructure.deadExportsInFolder', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const folders = selected?.length ? selected : uri ? [uri] : [];
      const anchor = (await Promise.all(folders.map((f) => vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'), '**/node_modules/**', 1)))).flat()[0];
      if (!anchor) {
        void vscode.window.showInformationMessage('There are no TypeScript or JavaScript files there.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(anchor)?.uri.fsPath;
      const roots = folders.map((f) => pathKey(f.fsPath));
      const inside = (file: string) => roots.some((root) => pathKey(file).startsWith(`${root}/`));
      const target: AnalysisTarget = { fileName: anchor.fsPath, offset: 0, end: 0, folder, project: () => projects.analysisProject(anchor.fsPath, folder) };
      return runAnalysis(view, 'Dead Export Analysis', async () => {
        const report = await deadExports(target, inside);
        if (report) {
          report.title = `${report.title} in ${folders.map((f) => vscode.workspace.asRelativePath(f)).join(', ')}`;
        }
        return report;
      });
    }),
    scopedCommand('tsStructure.detectPatterns', 'Detecting design patterns', { id: 'patterns', kinds: ['file', 'folder', 'pickFolder', 'open', 'changed', 'project'] }, (t, scope) => {
      const { files, note } = filesIn(t.project().program(), scope);
      return withNote(patternsReport(files, t.folder), note);
    }),
    registerCommand('tsStructure.whoImports', (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? sourceEditor()?.document.uri.fsPath;
      if (!file) return;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
      return runAnalysis(view, `Finding importers of ${path.basename(file)}`, () => dependentsReport(projects.analysisProject(file, folder).program(), normalizePath(file), folder));
    }),
    // Bundle weight: the runtime imports of a file and how much each one brings in.
    registerCommand('tsStructure.bundleWeight', (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? sourceEditor()?.document.uri.fsPath;
      if (!file) return;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
      return runAnalysis(view, `Weighing what ${path.basename(file)} pulls in`, () => bundleWeightReport(projects.analysisProject(file, folder).program(), normalizePath(file), folder));
    }),
    scopedCommand('tsStructure.findImportCycles', 'Finding import cycles', { id: 'cycles', kinds: projectScopes }, (t, scope) => cyclesReport(t.project().program(), t.folder, scopeFilter(scope.spec))),
    editorCommand('tsStructure.exceptionFlow', 'Exception flow', (t) => exceptionFlowReport(t.project(), t.fileName, t.offset)),
    scopedCommand('tsStructure.auditTypeAssertions', 'Auditing type assertions', { id: 'assertionAudit', kinds: fineScopes }, (t, scope) => {
      const program = t.project().program();
      const ignoreTests = vscode.workspace.getConfiguration('tsStructure', vscode.Uri.file(t.fileName)).get('typeAssertion.ignoreTestFiles', false);
      const { files, note } = filesIn(program, scope);
      return withNote(assertionAuditReport(program, files, { typeAssertionIgnoreTests: ignoreTests }, t.folder), note);
    }),
    registerCommand('tsStructure.findDuplicates', async (scopeArg?: unknown) => {
      const editor = sourceEditor();
      if (!editor) {
        return;
      }
      const scope = await chooseScope(
        {
          id: 'duplicates',
          title: 'Find structural duplicates',
          kinds: ['selection', ...projectScopes],
          editor,
          labels: { selection: { label: '$(selection) Copies of the selection', description: 'Every place with the same structure as the selected statements' } },
        },
        scopeArg,
      );
      if (!scope) {
        return;
      }
      const target = editorTarget(projects, editor);
      const config = vscode.workspace.getConfiguration('tsStructure.duplicates', editor.document.uri);
      if (scope.kind === 'selection') {
        const { start, end } = editor.selection;
        const [from, to] = [editor.document.offsetAt(start), editor.document.offsetAt(end)];
        return runAnalysis(view, 'Finding copies', () => {
          const program = target.project().program();
          const { files, note } = scopedFiles(projectSourceFiles(program));
          return withNote(copiesReport(files, program.getSourceFile(normalizePath(target.fileName))!, from, to, target.folder), note);
        });
      }
      return runAnalysis(view, 'Finding duplicates', () => {
        const program = target.project().program();
        const ignoreTests = config.get('ignoreTestFiles', true);
        const scoped = filesIn(program, scope);
        const files = scoped.files.filter((sf) => scope.kind === 'file' || !ignoreTests || !discoverTests(sf).isTestFile);
        const options = { minStatements: config.get('minStatements', 3), minTokens: config.get('minTokens', 40), matchRenamedProperties: config.get('matchRenamedProperties', false) };
        return inScope(withNote(duplicatesReport(files, options, target.folder), scoped.note), scope);
      });
    }),
    // From the Explorer: copies among the files in the folders picked.
    registerCommand('tsStructure.findDuplicatesInFolder', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const folders = selected?.length ? selected : uri ? [uri] : [];
      const anchor = (await Promise.all(folders.map((f) => vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'), '**/node_modules/**', 1)))).flat()[0];
      if (!anchor) {
        void vscode.window.showInformationMessage('There are no TypeScript or JavaScript files there.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(anchor)?.uri.fsPath;
      const roots = folders.map((f) => pathKey(f.fsPath));
      const config = vscode.workspace.getConfiguration('tsStructure.duplicates', anchor);
      return runAnalysis(view, 'Finding duplicates', () => {
        const program = projects.analysisProject(anchor.fsPath, folder).program();
        const inside = projectSourceFiles(program).filter((sf) => roots.some((root) => pathKey(sf.fileName).startsWith(`${root}/`)));
        const scoped = scopedFiles(inside);
        const ignoreTests = config.get('ignoreTestFiles', true);
        const files = scoped.files.filter((sf) => !ignoreTests || !discoverTests(sf).isTestFile);
        const report = withNote(duplicatesReport(files, { minStatements: config.get('minStatements', 3), minTokens: config.get('minTokens', 40), matchRenamedProperties: config.get('matchRenamedProperties', false) }, folder), scoped.note);
        report.title = `${report.title} in ${folders.map((f) => vscode.workspace.asRelativePath(f)).join(', ')}`;
        return report;
      });
    }),
    editorCommand('tsStructure.semanticUsages', 'Finding usages', (t) => semanticUsagesReport(t.project(), t.fileName, t.offset, t.folder)),
    // The usages in the file at hand only: the whole project is still searched, then the report is limited.
    registerCommand('tsStructure.semanticUsagesInFile', async () => {
      const report = await vscode.commands.executeCommand<Report | undefined>('tsStructure.semanticUsages');
      if (report) {
        await vscode.commands.executeCommand('tsStructure.report.limitScope', 'file');
      }
      return report;
    }),
    editorCommand('tsStructure.reexportChain', 'Tracing re-exports', (t) => reexportChainReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.typeHierarchy', 'Building hierarchy', (t) => hierarchyReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.overrideImpact', 'Override impact', (t) => overrideImpactReport(t.project(), t.fileName, t.offset, t.folder)),
    registerCommand('tsStructure.report.swapDependency', (node: ReportNode) => {
      const { from, to } = (node?.action ?? {}) as { from?: string; to?: string };
      if (from && to) {
        return vscode.commands.executeCommand('tsStructure.dependencyPath', vscode.Uri.file(from), vscode.Uri.file(to));
      }
    }),
    // From the Explorer the second argument is every selected file: with two selected, the path between them.
    registerCommand('tsStructure.dependencyPath', async (fromUri?: vscode.Uri, toArg?: vscode.Uri | vscode.Uri[]) => {
      let toUri = Array.isArray(toArg) ? undefined : toArg;
      if (Array.isArray(toArg) && toArg.length === 2 && fromUri) {
        toUri = toArg.find((u) => u.fsPath !== fromUri.fsPath);
      }
      const from = fromUri?.fsPath ?? sourceEditor()?.document.uri.fsPath;
      if (!from) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(from))?.uri.fsPath;
      let to = toUri?.fsPath;
      // The picker's program is reused for the analysis instead of building the project twice.
      let program: ts.Program | undefined;
      if (!to) {
        program = projects.analysisProject(from, folder).program();
        // Modules it depends on come first, nearest first; the rest follow for checking the reverse direction.
        const distance = distancesFrom(programGraph(program), from);
        const files = projectSourceFiles(program)
          .map((sf) => normalizePath(sf.fileName))
          .filter((f) => f !== normalizePath(from));
        // Each module's button asks the reverse question: why it depends on this one.
        const reverse: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: `Why does this module depend on ${path.basename(from)}?` };
        const item = (file: string) => ({
          label: path.basename(file),
          description: vscode.workspace.asRelativePath(path.dirname(file)),
          detail: distance.has(file) ? `${distance.get(file)} import${distance.get(file) === 1 ? '' : 's'} away` : undefined,
          buttons: [reverse],
          file,
        });
        // Modules open in editors or asked about recently are usually the ones in question.
        const recent = context.workspaceState.get<string[]>(recentDependencyKey, []);
        const open = new Set(openSourceFiles().map(pathKey));
        const isShortcut = (f: string) => open.has(pathKey(f)) || recent.some((r) => pathKey(r) === pathKey(f));
        const shortcuts = files.filter(isShortcut).sort((a, b) => rank(recent, a) - rank(recent, b));
        const reached = files.filter((f) => distance.has(f) && !isShortcut(f)).sort((a, b) => distance.get(a)! - distance.get(b)!);
        const others = files.filter((f) => !distance.has(f) && !isShortcut(f));
        type Item = vscode.QuickPickItem & { file?: string };
        const picker = vscode.window.createQuickPick<Item>();
        picker.title = `Why does ${path.basename(from)} depend on…`;
        picker.placeholder = 'Choose the module to explain; its swap button asks why it depends on this one';
        picker.matchOnDescription = true;
        picker.items = [
          ...(shortcuts.length ? [{ label: 'Recent and open', kind: vscode.QuickPickItemKind.Separator }, ...shortcuts.map(item)] : []),
          { label: `Depends on (${reached.length})`, kind: vscode.QuickPickItemKind.Separator },
          ...reached.map(item),
          { label: 'Not imported from here', kind: vscode.QuickPickItemKind.Separator },
          ...others.map(item),
        ];
        const choice = await new Promise<{ file: string; reverse: boolean } | undefined>((resolve) => {
          picker.onDidAccept(() => resolve(picker.selectedItems[0]?.file ? { file: picker.selectedItems[0].file, reverse: false } : undefined));
          picker.onDidTriggerItemButton((e) => resolve(e.item.file ? { file: e.item.file, reverse: true } : undefined));
          picker.onDidHide(() => resolve(undefined));
          picker.show();
        });
        picker.dispose();
        if (choice?.reverse) {
          return vscode.commands.executeCommand('tsStructure.dependencyPath', vscode.Uri.file(choice.file), vscode.Uri.file(from));
        }
        to = choice?.file;
      }
      if (!to) {
        return;
      }
      const target = to;
      void context.workspaceState.update(recentDependencyKey, [target, ...context.workspaceState.get<string[]>(recentDependencyKey, []).filter((f) => pathKey(f) !== pathKey(target))].slice(0, 5));
      return runAnalysis(view, 'Finding dependency paths', () => dependencyPathReport(program ?? projects.analysisProject(from, folder).program(), from, target, folder));
    }),
    registerCommand('tsStructure.argumentFlow', () => {
      const editor = sourceEditor();
      if (!editor) {
        return;
      }
      const target = editorTarget(projects, editor);
      const text = editor.document.getText();
      // Trace Deeper raises the depth of this run; a new run starts from the setting again.
      const run = { extra: 0 };
      latestArgumentRun = run;
      return runAnalysis(view, 'Tracing argument propagation', () =>
        startingAtCursor('tsStructure.argumentFlow', editor, () => {
          const t = followEdits(target, text);
          const depth = vscode.workspace.getConfiguration('tsStructure', vscode.Uri.file(t.fileName)).get('argumentFlow.maxDepth', 6);
          return argumentFlowReport(t.project(), t.fileName, t.offset, depth + run.extra);
        }),
      );
    }),
    registerCommand('tsStructure.report.traceDeeper', async () => {
      if (view.report?.kind === 'argumentFlow' && latestArgumentRun) {
        latestArgumentRun.extra += 3;
        await view.rerun();
      }
    }),
    editorCommand('tsStructure.sideEffects', 'Side effects', (t) => sideEffectReport(t.project().program(), t.fileName, t.offset)),
    // Graphs: drawn as a chart as soon as they are ready (see extension.ts).
    editorCommand('tsStructure.callGraph', 'Call graph', (t) =>
      callGraphReport(t.project(), t.fileName, t.offset, {
        depth: graphOption('callGraph', 'levels', vscode.workspace.getConfiguration('tsStructure', vscode.Uri.file(t.fileName)).get('callGraph.depth', 3)),
        direction: graphOption('callGraph', 'direction', 'both') as CallDirection,
      }),
    ),
    editorCommand('tsStructure.reactState', 'React state', (t) => reactStateReport(t.project(), t.fileName, t.offset, { levels: graphOption('reactState', 'levels', 1) })),
  );
}

/** Sets one of the report's options (from the chart) or picks one (from the results view), then runs it again. */
async function changeControls(view: StructureView, id?: string, value?: unknown): Promise<void> {
  const report = view.report;
  const controls = report?.controls ?? [];
  if (!report || !controls.length) return;
  let control = controls.find((c) => c.id === id);
  if (!control) {
    const picked = controls.length === 1 ? controls[0] : (await vscode.window.showQuickPick(controls.map((c) => ({ label: c.label, description: String(c.choices?.find((x) => x.id === c.value)?.label ?? c.value), detail: c.description, control: c })), { title: 'Change the graph' }))?.control;
    if (!picked) return;
    control = picked;
  }
  if (value === undefined) {
    const items =
      control.kind === 'levels'
        ? Array.from({ length: (control.max ?? 5) - (control.min ?? 1) + 1 }, (_, i) => (control!.min ?? 1) + i).map((n) => ({ label: `${n} ${n === 1 ? 'level' : 'levels'}`, picked: n === control!.value, value: n as unknown }))
        : (control.choices ?? []).map((c) => ({ label: c.label, picked: c.id === control!.value, value: c.id as unknown }));
    const chosen = await vscode.window.showQuickPick(
      items.map((i) => ({ ...i, description: i.picked ? 'current' : undefined })),
      { title: `${report.title}: ${control.label}`, placeHolder: control.description },
    );
    if (!chosen) return;
    value = chosen.value;
  }
  if (setGraphOption(report.kind, control, value)) await view.rerun();
}
