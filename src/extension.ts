import * as vscode from 'vscode';
import { ProjectService } from './analysis/project';
import { analyzeImpact } from './analysis/impact';
import { AnalysisError, AnalysisScope, ImpactResult, SourceLocation, TestCase } from './analysis/types';
import { pathKey } from './analysis/paths';
import { ResultsProvider, countLabel, openLocation, showResultsPicker, trackResult } from './resultsView';
import { runTests } from './runner';
import { registerRefactorings } from './ui/refactorCommands';
import { registerAnalyses } from './ui/analysisCommands';
import { StructureView } from './ui/structureView';
import { InspectionDiagnostics } from './ui/inspectionDiagnostics';
import { customInspectionConfigs, registerStructuralSearch } from './ui/structuralSearchPanel';
import { customInspections } from './search/customInspections';
import { registerGraphDiff } from './ui/graphDiffCommand';
import { SideEffectLens } from './ui/sideEffectLens';
import { showActionsAtCursor } from './ui/actionsAtCursor';
import { CompilerErrorActions } from './ui/compilerErrorActions';
import { Inspection } from './inspect/inspection';
import { configureFeatures, registerCommand } from './ui/features';
import { registerGuide } from './ui/guide';
import { registerScope } from './ui/exclude';
import { registerScopeCommands } from './ui/scopeCommands';

const supportedLanguages = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function activate(context: vscode.ExtensionContext): void {
  // Analyze unsaved editor text, not only what is on disk.
  const projects = new ProjectService((fileName) => {
    const key = pathKey(fileName);
    // Only unsaved text: a saved document can lag behind a change made on disk (Git, a formatter, another tool).
    return vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key)?.getText();
  });
  const results = new ResultsProvider();
  const view = vscode.window.createTreeView('tsImpact.results', { treeDataProvider: results, showCollapseAll: true });
  results.view = view;
  trackResult(() => results.result);

  const configWatcher = vscode.workspace.createFileSystemWatcher('**/{tsconfig*.json,jsconfig.json,package.json}');
  const invalidate = () => projects.invalidate();
  configWatcher.onDidChange(invalidate);
  configWatcher.onDidCreate(invalidate);
  configWatcher.onDidDelete(invalidate);
  // Project file lists are cached: a new, deleted or renamed source file means listing them again.
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', false, true, false);
  sourceWatcher.onDidCreate(() => projects.invalidateFileList());
  sourceWatcher.onDidDelete(() => projects.invalidateFileList());

  // Before anything that reads the scope, so its cache is cleared first when the settings change.
  registerScope(context);
  registerScopeCommands(context);
  const run = (tests: TestCase[]) => void runTests(tests);
  registerRefactorings(context, projects);
  const structureView = new StructureView(context.workspaceState);
  registerAnalyses(context, projects, structureView);
  registerStructuralSearch(context, projects, structureView);
  registerGraphDiff(context, projects, structureView);
  new SideEffectLens(projects).register(context);
  new CompilerErrorActions().register(context);
  registerGuide(context);
  context.subscriptions.push(registerCommand('tsStructure.actionsAtCursor', () => showActionsAtCursor(context.globalState, context.extension.packageJSON.contributes?.keybindings)), registerCommand('tsStructure.configureFeatures', configureFeatures),
    registerCommand('tsStructure.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),
  );
  new InspectionDiagnostics(projects, configuredInspections).register(context, structureView);

  context.subscriptions.push(
    view,
    configWatcher,
    sourceWatcher,
    // Returns the result so other extensions and integration tests can use it.
    // From the Explorer the argument is the file: the tests that depend on anything in it.
    registerCommand('tsImpact.analyze', async (scopeArg?: AnalysisScope | vscode.Uri): Promise<ImpactResult | undefined> => {
      let document: vscode.TextDocument;
      let offset = 0;
      let scope: AnalysisScope | undefined;
      if (scopeArg instanceof vscode.Uri) {
        document = await vscode.workspace.openTextDocument(scopeArg);
        scope = 'module';
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !supportedLanguages.has(editor.document.languageId) || editor.document.uri.scheme !== 'file') {
          void vscode.window.showErrorMessage('Open a TypeScript or JavaScript file and place the cursor on a symbol.');
          return;
        }
        scope = scopeArg ?? (await pickScope());
        document = editor.document;
        offset = document.offsetAt(editor.selection.active);
      }
      if (!scope) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const config = vscode.workspace.getConfiguration('tsImpact', document.uri);

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Analyzing test impact…' },
          async () => {
            // Let the progress notification render before the synchronous analysis starts.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const project = projects.load(document.uri.fsPath, folder?.uri.fsPath);
            return analyzeImpact(
              project,
              { fileName: document.uri.fsPath, offset, scope },
              { maxDepth: config.get('maxDepth'), includeInheritedMembers: config.get('includeInheritedMembers') },
            );
          },
        );
        results.set(result);
        if (result.tests.length === 0) {
          void vscode.window.showInformationMessage(
            `No tests found that depend on ${result.target.name} (${result.filesScanned} files, ${result.testFilesScanned} test files scanned).`,
          );
          return result;
        }
        await showResultsPicker(result, run);
        return result;
      } catch (error) {
        const message = error instanceof AnalysisError ? error.message : `Test impact analysis failed: ${String(error)}`;
        void vscode.window.showErrorMessage(message);
      }
    }),
    registerCommand('tsImpact.analyzeFile', (uri?: vscode.Uri) => vscode.commands.executeCommand('tsImpact.analyze', uri ?? vscode.window.activeTextEditor?.document.uri)),
    registerCommand('tsImpact.showLastResults', async () => {
      if (results.result) {
        await showResultsPicker(results.result, run);
      } else {
        void vscode.window.showInformationMessage('No impact analysis has run yet.');
      }
    }),
    registerCommand('tsImpact.runImpactedTests', async () => {
      const tests = results.result?.tests.map((t) => t.test) ?? [];
      if (tests.length === 0) {
        void vscode.window.showInformationMessage('There are no impacted tests to run. Run the analysis first.');
        return;
      }
      const choice = await vscode.window.showInformationMessage(`Run ${countLabel(tests.length)}?`, 'Run');
      if (choice) {
        run(tests);
      }
    }),
    registerCommand('tsImpact.runTest', (item) => run(results.testsOf(item))),
    registerCommand('tsImpact.open', (location: SourceLocation) => openLocation(location)),
    registerCommand('tsImpact.clear', () => results.set(undefined)),
  );
}

async function pickScope(): Promise<AnalysisScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Function or Symbol at Cursor', description: 'Tests that depend on the selected symbol', scope: 'symbol' as const },
      { label: 'Active Module', description: 'Tests that depend on anything in this file', scope: 'module' as const },
    ],
    { title: 'Test Impact Analysis', placeHolder: 'Choose what changed' },
  );
  return picked?.scope;
}

let configured: { key: string; inspections: Inspection[] } | undefined;

/** Custom inspections from settings, rebuilt only when the setting changes. */
function configuredInspections(): Inspection[] {
  const configs = customInspectionConfigs();
  const key = JSON.stringify(configs);
  if (configured?.key !== key) {
    const { inspections, errors } = customInspections(configs);
    configured = { key, inspections };
    for (const error of errors) {
      void vscode.window.showWarningMessage(error);
    }
  }
  return configured.inspections;
}

export function deactivate(): void {}
