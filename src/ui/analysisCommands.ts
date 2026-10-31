import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportLocation } from '../structure/report';
import { dataFlowReport } from '../inspect/dataFlow';
import { mutationReport, sideEffectReport } from '../inspect/effects';
import { nullabilityReport } from '../inspect/nullability';
import { rejectionReport } from '../inspect/rejections';
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

  context.subscriptions.push(
    view.view,
    vscode.commands.registerCommand('tsStructure.openLocation', (location: ReportLocation) => view.open(location)),
    vscode.commands.registerCommand('tsStructure.rerunAnalysis', () => view.rerun()),
    vscode.commands.registerCommand('tsStructure.clearReport', () => view.clear()),
    editorCommand('tsStructure.dataFlow', 'Data Flow', (t) => dataFlowReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.mutationTracking', 'Mutation Tracking', (t) => mutationReport(t.project().program(), t.fileName)),
    editorCommand('tsStructure.nullability', 'Nullability Analysis', (t) => nullabilityReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.promiseRejections', 'Promise Rejection Analysis', (t) => rejectionReport(t.project(), t.fileName, t.offset)),
    editorCommand('tsStructure.sideEffects', 'Side-Effect Analysis', (t) => sideEffectReport(t.project().program(), t.fileName, t.offset)),
  );
}
