import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportLocation } from '../structure/report';
import { dataFlowReport } from '../inspect/dataFlow';
import { mutationReport, sideEffectReport } from '../inspect/effects';
import { nullabilityReport } from '../inspect/nullability';
import { rejectionReport } from '../inspect/rejections';
import { deadExportReport } from '../inspect/deadExports';
import { exceptionFlowReport } from '../inspect/exceptionFlow';
import { duplicatesReport } from '../inspect/duplicates';
import { semanticUsagesReport } from '../navigate/usages';
import { reexportChainReport } from '../navigate/reexports';
import { hierarchyReport, overrideImpactReport } from '../navigate/hierarchy';
import { dependencyPathReport } from '../navigate/dependencyPaths';
import { argumentFlowReport } from '../navigate/argumentFlow';
import { discoverTests } from '../analysis/testDiscovery';
import { defaultEntryPoints } from '../navigate/moduleGraph';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { normalizePath } from '../analysis/paths';
import { registerReportActions } from './reportActions';
import { reportError } from './applyRefactor';
import { sourceEditor } from './refactorCommands';
import { StructureView } from './structureView';

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
        return compute();
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

export function registerAnalyses(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  /** A command that analyzes the symbol or selection in the active editor. Returns the report for tests and other extensions. */
  const editorCommand = (id: string, title: string, compute: Compute) =>
    vscode.commands.registerCommand(id, () => {
      const editor = sourceEditor();
      if (editor) {
        const target = editorTarget(projects, editor);
        return runAnalysis(view, title, () => compute(target));
      }
    });

  registerReportActions(context, view);
  context.subscriptions.push(
    view.view,
    vscode.commands.registerCommand('tsStructure.openLocation', (location: ReportLocation) => view.open(location)),
    vscode.commands.registerCommand('tsStructure.rerunAnalysis', () => view.rerun()),
    vscode.commands.registerCommand('tsStructure.clearReport', () => view.clear()),
    editorCommand('tsStructure.dataFlow', 'Data Flow', (t) => dataFlowReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTracking', 'Mutation Tracking', (t) => mutationReport(t.project().program(), t.fileName)),
    editorCommand('tsStructure.nullability', 'Nullability Analysis', (t) => nullabilityReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.promiseRejections', 'Promise Rejection Analysis', (t) => rejectionReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.deadExports', 'Dead Export Analysis', async (t) => {
      const program = t.project().program();
      const config = vscode.workspace.getConfiguration('tsStructure.deadExports');
      const root = t.folder ?? path.dirname(t.fileName);
      const globs = config.get<string[]>('entryPoints', []);
      let entryPoints: string[] = [];
      if (globs.length > 0 && t.folder) {
        const found = await Promise.all(globs.map((g) => vscode.workspace.findFiles(new vscode.RelativePattern(t.folder!, g), '**/node_modules/**')));
        entryPoints = found.flat().map((u) => u.fsPath);
      } else {
        entryPoints = defaultEntryPoints(root, new Set(projectSourceFiles(program).map((f) => normalizePath(f.fileName))));
      }
      return deadExportReport(program, { entryPoints, testsAreEntryPoints: config.get('testFilesAreEntryPoints', true) }, root);
    }),
    editorCommand('tsStructure.exceptionFlow', 'Exception Flow Analysis', (t) => exceptionFlowReport(t.project(), t.fileName, t.offset)),
    vscode.commands.registerCommand('tsStructure.findDuplicates', async (scopeArg?: 'file' | 'project') => {
      const editor = sourceEditor();
      if (!editor) {
        return;
      }
      const scope =
        scopeArg ??
        (
          await vscode.window.showQuickPick(
            [
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
      const config = vscode.workspace.getConfiguration('tsStructure.duplicates');
      return runAnalysis(view, 'Finding duplicates', () => {
        const program = target.project().program();
        const ignoreTests = config.get('ignoreTestFiles', true);
        const files = scope === 'file' ? [program.getSourceFile(normalizePath(target.fileName))!] : projectSourceFiles(program).filter((sf) => !ignoreTests || !discoverTests(sf).isTestFile);
        return duplicatesReport(files, { minStatements: config.get('minStatements', 3), minTokens: config.get('minTokens', 40) }, target.folder);
      });
    }),
    editorCommand('tsStructure.semanticUsages', 'Finding usages', (t) => semanticUsagesReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.reexportChain', 'Tracing re-exports', (t) => reexportChainReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.typeHierarchy', 'Building hierarchy', (t) => hierarchyReport(t.project(), t.fileName, t.offset, t.folder)),
    editorCommand('tsStructure.overrideImpact', 'Analyzing override impact', (t) => overrideImpactReport(t.project(), t.fileName, t.offset, t.folder)),
    vscode.commands.registerCommand('tsStructure.dependencyPath', async (fromUri?: vscode.Uri, toUri?: vscode.Uri) => {
      const from = fromUri?.fsPath ?? sourceEditor()?.document.uri.fsPath;
      if (!from) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(from))?.uri.fsPath;
      let to = toUri?.fsPath;
      if (!to) {
        const program = projects.createVirtualProject(from, folder).program();
        const files = projectSourceFiles(program)
          .map((sf) => normalizePath(sf.fileName))
          .filter((f) => f !== normalizePath(from));
        const picked = await vscode.window.showQuickPick(
          files.map((file) => ({ label: path.basename(file), description: vscode.workspace.asRelativePath(path.dirname(file)), file })),
          { title: `Why does ${path.basename(from)} depend on…`, placeHolder: 'Choose the module to explain', matchOnDescription: true },
        );
        to = picked?.file;
      }
      if (!to) {
        return;
      }
      const target = to;
      return runAnalysis(view, 'Finding dependency paths', () => dependencyPathReport(projects.createVirtualProject(from, folder).program(), from, target, folder));
    }),
    editorCommand('tsStructure.argumentFlow', 'Tracing argument propagation', (t) =>
      argumentFlowReport(t.project(), t.fileName, t.offset, vscode.workspace.getConfiguration('tsStructure').get('argumentFlow.maxDepth', 6)),
    ),
    editorCommand('tsStructure.sideEffects', 'Side-Effect Analysis', (t) => sideEffectReport(t.project().program(), t.fileName, t.offset)),
  );
}
