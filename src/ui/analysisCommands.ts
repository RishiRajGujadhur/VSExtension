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
import { reportError } from './applyRefactor';
import { sourceEditor } from './refactorCommands';
import { StructureView } from './structureView';
import { registerCommand } from './features';

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
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${title}…` }, async () => {
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
    project: () => projects.createVirtualProject(document.uri.fsPath, folder),
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
  /** A command that analyzes the symbol or selection in the active editor. Returns the report for tests and other extensions. */
  const editorCommand = (id: string, title: string, compute: Compute) =>
    registerCommand(id, () => {
      const editor = sourceEditor();
      if (editor) {
        const target = editorTarget(projects, editor);
        const text = editor.document.getText();
        return runAnalysis(view, title, () => compute(followEdits(target, text)));
      }
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
    registerCommand('tsStructure.toggleHighlights', async () => {
      const config = vscode.workspace.getConfiguration('tsStructure');
      const on = !config.get('highlightResults', true);
      await config.update('highlightResults', on, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Result highlights ${on ? 'on' : 'off'}`, 3000);
    }),
    registerCommand('tsStructure.report.copyRow', async (node: ReportNode, selected?: ReportNode[]) => {
      const rows = selected?.length ? selected : node ? [node] : [];
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
    registerCommand('tsStructure.report.openToSide', (node: ReportNode) => node?.location && view.open(node.location, true)),
    registerCommand('tsStructure.report.copyLocation', async (node: ReportNode) => {
      if (node?.location) {
        await vscode.env.clipboard.writeText(`${vscode.workspace.asRelativePath(node.location.file)}:${node.location.line + 1}:${node.location.character + 1}`);
      }
    }),
    registerCommand('tsStructure.rerunAnalysis', () => view.rerun()),
    registerCommand('tsStructure.clearReport', () => view.clear()),
    editorCommand('tsStructure.dataFlow', 'Data Flow', (t) => dataFlowReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTracking', 'Mutation Tracking', (t) => mutationReport(t.project().program(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTrackingProject', 'Mutation Tracking', (t) => {
      const program = t.project().program();
      const { files, note } = scopedFiles(projectSourceFiles(program));
      return withNote(mutationReport(program, t.fileName, t.offset, files), note);
    }),
    editorCommand('tsStructure.nullability', 'Nullability Analysis', (t) => nullabilityReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.promiseRejections', 'Promise Rejection Analysis', (t) => rejectionReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.deadExports', 'Dead Export Analysis', (t) => deadExports(t)),
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
      const target: AnalysisTarget = { fileName: anchor.fsPath, offset: 0, end: 0, folder, project: () => projects.createVirtualProject(anchor.fsPath, folder) };
      return runAnalysis(view, 'Dead Export Analysis', async () => {
        const report = await deadExports(target, inside);
        if (report) {
          report.title = `${report.title} in ${folders.map((f) => vscode.workspace.asRelativePath(f)).join(', ')}`;
        }
        return report;
      });
    }),
    editorCommand('tsStructure.exceptionFlow', 'Exception Flow Analysis', (t) => exceptionFlowReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.auditTypeAssertions', 'Auditing type assertions', (t) => {
      const program = t.project().program();
      const ignoreTests = vscode.workspace.getConfiguration('tsStructure', vscode.Uri.file(t.fileName)).get('typeAssertion.ignoreTestFiles', false);
      const { files, note } = scopedFiles(projectSourceFiles(program));
      return withNote(assertionAuditReport(program, files, { typeAssertionIgnoreTests: ignoreTests }, t.folder), note);
    }),
    registerCommand('tsStructure.findDuplicates', async (scopeArg?: 'file' | 'project' | 'selection') => {
      const editor = sourceEditor();
      if (!editor) {
        return;
      }
      const scope =
        scopeArg ??
        (
          await vscode.window.showQuickPick(
            [
              ...(editor.selection.isEmpty ? [] : [{ label: 'Copies of the Selection', description: 'Every place with the same structure as the selected statements', scope: 'selection' as const }]),
              { label: 'Whole Project', description: 'Compare every source file in the compiler project', scope: 'project' as const },
              { label: 'Active File', description: 'Only look inside the current file', scope: 'file' as const },
            ],
            { title: 'Find Structural Duplicates' },
          )
        )?.scope;
      if (!scope) {
        return;
      }
      const target = editorTarget(projects, editor);
      const config = vscode.workspace.getConfiguration('tsStructure.duplicates', editor.document.uri);
      if (scope === 'selection') {
        return runAnalysis(view, 'Finding copies', () => {
          const program = target.project().program();
          const { files, note } = scopedFiles(projectSourceFiles(program));
          const { start, end } = editor.selection;
          return withNote(copiesReport(files, program.getSourceFile(normalizePath(target.fileName))!, editor.document.offsetAt(start), editor.document.offsetAt(end), target.folder), note);
        });
      }
      return runAnalysis(view, 'Finding duplicates', () => {
        const program = target.project().program();
        const ignoreTests = config.get('ignoreTestFiles', true);
        const scoped = scope === 'file' ? { files: [program.getSourceFile(normalizePath(target.fileName))!] } : scopedFiles(projectSourceFiles(program));
        const files = scoped.files.filter((sf) => scope === 'file' || !ignoreTests || !discoverTests(sf).isTestFile);
        return withNote(duplicatesReport(files, { minStatements: config.get('minStatements', 3), minTokens: config.get('minTokens', 40), matchRenamedProperties: config.get('matchRenamedProperties', false) }, target.folder), scoped.note);
      });
    }),
    editorCommand('tsStructure.semanticUsages', 'Finding usages', (t) => semanticUsagesReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.reexportChain', 'Tracing re-exports', (t) => reexportChainReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.typeHierarchy', 'Building hierarchy', (t) => hierarchyReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.overrideImpact', 'Analyzing override impact', (t) => overrideImpactReport(t.project(), t.fileName, t.offset, t.folder)),
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
        program = projects.createVirtualProject(from, folder).program();
        // Modules it depends on come first, nearest first; the rest follow for checking the reverse direction.
        const distance = distancesFrom(programGraph(program), from);
        const files = projectSourceFiles(program)
          .map((sf) => normalizePath(sf.fileName))
          .filter((f) => f !== normalizePath(from));
        const item = (file: string) => ({
          label: path.basename(file),
          description: vscode.workspace.asRelativePath(path.dirname(file)),
          detail: distance.has(file) ? `${distance.get(file)} import${distance.get(file) === 1 ? '' : 's'} away` : undefined,
          file,
        });
        const reached = files.filter((f) => distance.has(f)).sort((a, b) => distance.get(a)! - distance.get(b)!);
        const others = files.filter((f) => !distance.has(f));
        const picked = await vscode.window.showQuickPick(
          [
            { label: `Depends on (${reached.length})`, kind: vscode.QuickPickItemKind.Separator },
            ...reached.map(item),
            { label: 'Not imported from here', kind: vscode.QuickPickItemKind.Separator },
            ...others.map(item),
          ] as (vscode.QuickPickItem & { file?: string })[],
          { title: `Why does ${path.basename(from)} depend on…`, placeHolder: 'Choose the module to explain', matchOnDescription: true },
        );
        to = picked?.file;
      }
      if (!to) {
        return;
      }
      const target = to;
      return runAnalysis(view, 'Finding dependency paths', () => dependencyPathReport(program ?? projects.createVirtualProject(from, folder).program(), from, target, folder));
    }),
    editorCommand('tsStructure.argumentFlow', 'Tracing argument propagation', (t) =>
      argumentFlowReport(t.project(), t.fileName, t.offset, vscode.workspace.getConfiguration('tsStructure', vscode.Uri.file(t.fileName)).get('argumentFlow.maxDepth', 6)),
    ),
    editorCommand('tsStructure.sideEffects', 'Side-Effect Analysis', (t) => sideEffectReport(t.project().program(), t.fileName, t.offset)),
  );
}
