import * as ts from 'typescript';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportLocation, ReportNode } from '../structure/report';
import { retarget } from '../structure/retarget';
import { dataFlowReport } from '../inspect/dataFlow';
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
import { AnalysisError } from '../analysis/types';
import { analyzeSymbol, offerSymbols } from './analysisActions';

/** The file, cursor and project an analysis runs against, captured so it can be re-run later. */
export interface AnalysisTarget {
  fileName: string;
  offset: number;
  end: number;
  folder?: string;
  project(): VirtualProject;
}

type Compute = (target: AnalysisTarget) => Report | Promise<Report | undefined> | undefined;

/** Runs an analysis with progress and shows its report, keeping a closure to re-run it. */
export async function runAnalysis(view: StructureView, title: string, compute: () => Report | Promise<Report | undefined> | undefined): Promise<Report | undefined> {
  const run = async () => {
    try {
      // A spinner in the status bar by default; a notification when tsStructure.results.progress asks for one.
      const location = vscode.workspace.getConfiguration('tsStructure.results').get<string>('progress', 'statusBar') === 'notification' ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window;
      return await vscode.window.withProgress({ location, title: `${title}…` }, async () => {
        // Let the notification render before the synchronous analysis starts.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = Date.now();
        const report = await compute();
        if (report) {
          report.durationMs = Date.now() - started;
        }
        return report;
      });
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

/** Opens a row's location and runs an analysis there, such as Find Usages of the symbol a row points at. */
async function runAt(view: StructureView, node: ReportNode | undefined, command: string): Promise<unknown> {
  if (!node?.location) {
    return;
  }
  await view.open(node.location);
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
    return await compute();
  } catch (error) {
    if (error instanceof AnalysisError) {
      void offerSymbols(command, error.message, editor);
      return undefined;
    }
    throw error;
  }
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
    registerCommand(id, async (arg?: unknown) => {
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
          title: 'Limit Results to Scope',
          alwaysAsk: true,
          kinds: [...fineScopes],
          editor,
          labels: { project: { label: '$(clear-all) All Results', description: 'Show every row again' } },
        },
        arg,
      );
      if (scope) {
        view.limitTo(scope.kind === 'project' ? undefined : { label: scope.label ?? scope.kind, inside: locationFilter(scope.spec) });
      }
    }),
    registerCommand('tsStructure.report.clearLimit', () => view.limitTo(undefined)),
    registerCommand('tsStructure.report.clearFilters', () => view.clearFilters()),
    registerCommand('tsStructure.analyzeSymbol', () => {
      const editor = sourceEditor();
      return editor && analyzeSymbol(editor);
    }),
    registerCommand('tsStructure.report.rerunOutdated', () => view.rerun()),
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
    registerCommand('tsStructure.clearReport', () => view.clear()),
    editorCommand('tsStructure.dataFlow', 'Data Flow', (t) => dataFlowReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTracking', 'Mutation Tracking', (t) => mutationReport(t.project().program(), t.fileName, t.offset)),
    scopedCommand('tsStructure.mutationTrackingProject', 'Mutation Tracking', { id: 'mutations', kinds: projectScopes.filter((k) => k !== 'file') }, (t, scope) => {
      const program = t.project().program();
      const { files, note } = filesIn(program, scope);
      return withNote(mutationReport(program, t.fileName, t.offset, files), note);
    }),
    editorCommand('tsStructure.nullability', 'Nullability', (t) => nullabilityReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.promiseRejections', 'Promise rejections', (t) => rejectionReport(t.project(), t.fileName, t.offset)),
    // The whole project still decides what is used; the scope only limits which exports are reported.
    scopedCommand('tsStructure.deadExports', 'Dead Export Analysis', { id: 'deadExports', kinds: projectScopes }, (t, scope) => deadExports(t, scope.kind === 'project' ? undefined : scopeFilter(scope.spec))),
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
          title: 'Find Structural Duplicates',
          kinds: ['selection', ...projectScopes],
          editor,
          labels: { selection: { label: '$(selection) Copies of the Selection', description: 'Every place with the same structure as the selected statements' } },
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
  );
}
