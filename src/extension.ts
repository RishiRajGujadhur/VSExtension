import * as vscode from 'vscode';
import { ProjectService } from './analysis/project';
import { analyzeImpact } from './analysis/impact';
import { AnalysisError, AnalysisScope, ImpactResult, SourceLocation, TestCase } from './analysis/types';
import { pathKey } from './analysis/paths';
import { ResultsProvider, countLabel, openLocation, showResultsPicker, trackResult } from './resultsView';
import { runTests } from './runner';

const supportedLanguages = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function activate(context: vscode.ExtensionContext): void {
  // Analyze unsaved editor text, not only what is on disk.
  const projects = new ProjectService((fileName) => {
    const key = pathKey(fileName);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key)?.getText();
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

  const run = (tests: TestCase[]) => void runTests(tests);

  context.subscriptions.push(
    view,
    configWatcher,
    // Returns the result so other extensions and integration tests can use it.
    vscode.commands.registerCommand('tsImpact.analyze', async (scopeArg?: AnalysisScope): Promise<ImpactResult | undefined> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !supportedLanguages.has(editor.document.languageId) || editor.document.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Open a TypeScript or JavaScript file and place the cursor on a symbol.');
        return;
      }
      const scope = scopeArg ?? (await pickScope());
      if (!scope) {
        return;
      }
      const document = editor.document;
      const offset = document.offsetAt(editor.selection.active);
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const config = vscode.workspace.getConfiguration('tsImpact');

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
    vscode.commands.registerCommand('tsImpact.showLastResults', async () => {
      if (results.result) {
        await showResultsPicker(results.result, run);
      } else {
        void vscode.window.showInformationMessage('No impact analysis has run yet.');
      }
    }),
    vscode.commands.registerCommand('tsImpact.runImpactedTests', async () => {
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
    vscode.commands.registerCommand('tsImpact.runTest', (item) => run(results.testsOf(item))),
    vscode.commands.registerCommand('tsImpact.open', (location: SourceLocation) => openLocation(location)),
    vscode.commands.registerCommand('tsImpact.clear', () => results.set(undefined)),
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

export function deactivate(): void {}
