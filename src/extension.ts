import * as vscode from 'vscode';
import { ProjectService } from './analysis/project';
import { analyzeImpactAsync } from './analysis/impact';
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
import { rememberScopesIn } from './ui/analysisScope';
import { registerScopeCommands } from './ui/scopeCommands';
import { tasks } from './structure/tasks';
import * as fs from 'fs';
import { changedFiles } from './ui/analysisScope';
import { output } from './ui/applyRefactor';
import { Keybinding, shortcuts } from './structure/keys';
import { commandIcons } from './structure/icons';
import { featureOf } from './structure/features';
import { isFeatureEnabled } from './ui/features';

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
  rememberScopesIn(context.workspaceState);
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
    // Every shortcut of the extension, or one command's, in the Keyboard Shortcuts editor where it can be changed.
    registerCommand('tsStructure.shortcutSheet', () => showShortcutSheet(context.extension.packageJSON.contributes)),
    registerCommand('tsStructure.showLog', () => output.show(true)),
    registerCommand('tsStructure.togglePreview', () => toggleSetting('previewRefactorings', true, 'Refactoring preview')),
    registerCommand('tsStructure.toggleLiveInspections', () => toggleSetting('inspections.enabled', true, 'Live inspections')),
    registerCommand('tsStructure.howDoI', () => showHowDoI(process.platform === 'darwin' ? 'Cmd+Ctrl+S' : 'Ctrl+Alt+S')),
    registerCommand('tsStructure.editKeybindings', (command?: string) => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', command ? `"${command}"` : `@ext:${context.extension.id}`)),
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
          void vscode.window.showErrorMessage('Place the cursor on a symbol in a TypeScript or JavaScript file.');
          return;
        }
        scope = scopeArg ?? (await pickScope(context.workspaceState));
        document = editor.document;
        offset = document.offsetAt(editor.selection.active);
      }
      if (!scope) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const config = vscode.workspace.getConfiguration('tsImpact', document.uri);

      try {
        // Cancel stops the analysis between files and declarations; the editor stays usable meanwhile.
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Analyzing test impact…', cancellable: true },
          async (_progress, token) => {
            // Let the progress notification render before loading the project.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const project = projects.load(document.uri.fsPath, folder?.uri.fsPath);
            return analyzeImpactAsync(
              project,
              { fileName: document.uri.fsPath, offset, scope },
              { maxDepth: config.get('maxDepth'), includeInheritedMembers: config.get('includeInheritedMembers') },
              token,
            );
          },
        );
        if (!result) {
          void vscode.window.setStatusBarMessage('$(debug-stop) Test impact analysis cancelled', 3000);
          return;
        }
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
    // One test per line, "file: suite › test", or the test files only, for a commit message, a ticket or a CI filter.
    registerCommand('tsImpact.copyTests', async () => {
      const tests = results.result?.tests.map((t) => t.test) ?? [];
      if (tests.length === 0) {
        void vscode.window.showInformationMessage('There are no impacted tests to copy. Run the analysis first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Test Names', description: 'file: suite › test, one per line', files: false },
          { label: 'Test Files', description: 'each file once', files: true },
        ],
        { title: `Copy ${countLabel(tests.length)}` },
      );
      if (!picked) {
        return;
      }
      const lines = picked.files
        ? [...new Set(tests.map((t) => vscode.workspace.asRelativePath(t.file)))]
        : tests.map((t) => `${vscode.workspace.asRelativePath(t.file)}: ${t.isFileEntry ? '(whole file)' : t.titlePath.join(' › ')}`);
      await vscode.env.clipboard.writeText(lines.join('\n'));
      void vscode.window.setStatusBarMessage(`Copied ${lines.length} ${picked.files ? 'test file' : 'test'}${lines.length === 1 ? '' : 's'}`, 3000);
    }),
    // Every changed source file analyzed as a module, with the tests merged into one result.
    registerCommand('tsImpact.analyzeChanged', async () => {
      const anchor = vscode.window.activeTextEditor?.document.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const changed = anchor ? (await changedFiles(anchor))?.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && fs.existsSync(f)) : undefined;
      if (!changed?.length) {
        void vscode.window.showInformationMessage(changed ? 'No TypeScript or JavaScript files have changed since the last commit.' : 'Changed files need a Git repository.');
        return;
      }
      const merged = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Finding tests for ${changed.length} changed file${changed.length === 1 ? '' : 's'}…`, cancellable: true }, async (progress, token) => {
        let result: ImpactResult | undefined;
        const seen = new Set<string>();
        for (const file of changed) {
          if (token.isCancellationRequested) return undefined;
          progress.report({ message: vscode.workspace.asRelativePath(file), increment: 100 / changed.length });
          await new Promise((resolve) => setTimeout(resolve, 0));
          try {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
            const one = await analyzeImpactAsync(projects.load(file, folder), { fileName: file, offset: 0, scope: 'module' }, {}, token);
            if (!one) return undefined;
            if (!result) {
              result = { ...one, tests: [], target: { ...one.target, name: 'changed files' } };
            }
            for (const t of one.tests) {
              const key = `${t.test.file}:${t.test.location.line}:${t.test.title}`;
              if (!seen.has(key)) {
                seen.add(key);
                result.tests.push(t);
              }
            }
            result.fileHashes = { ...result.fileHashes, ...one.fileHashes };
          } catch {
            // Files outside any project have no tests to find.
          }
        }
        return result;
      });
      if (merged) {
        results.set(merged);
        if (merged.tests.length) await showResultsPicker(merged, run);
        else void vscode.window.showInformationMessage('No tests depend on the changed files.');
      }
    }),
    registerCommand('tsImpact.openTestFiles', async () => {
      const files = [...new Set((results.result?.tests ?? []).map((t) => t.test.file))];
      if (files.length === 0) {
        void vscode.window.showInformationMessage('There are no impacted tests. Run the analysis first.');
        return;
      }
      for (const file of files.slice(0, 10)) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, preserveFocus: true });
      }
      if (files.length > 10) void vscode.window.showInformationMessage(`Opened the first 10 of ${files.length} test files.`);
    }),
    registerCommand('tsImpact.open', (location: SourceLocation) => openLocation(location)),
    registerCommand('tsImpact.clear', () => results.set(undefined)),
  );
}

const lastScopeKey = 'tsImpact.lastScope';

/** What changed: the symbol at the cursor or the whole module, with the last choice first. */
async function pickScope(memento: vscode.Memento): Promise<AnalysisScope | undefined> {
  const last = memento.get<AnalysisScope>(lastScopeKey);
  const items = [
    { label: 'Function or Symbol at Cursor', description: 'Tests that depend on the selected symbol', scope: 'symbol' as const },
    { label: 'Active Module', description: 'Tests that depend on anything in this file', scope: 'module' as const },
  ]
    .map((item) => (item.scope === last ? { ...item, description: `${item.description} · last used` } : item))
    .sort((a, b) => Number(b.scope === last) - Number(a.scope === last));
  const picked = await vscode.window.showQuickPick(items, { title: 'Test Impact Analysis', placeHolder: 'Choose what changed' });
  if (picked) {
    void memento.update(lastScopeKey, picked.scope);
  }
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

/** How Do I…?: the questions the extension answers, in plain words, each running its command. */
async function showHowDoI(prefix: string): Promise<void> {
  const items = tasks.map((task) => {
    const feature = featureOf(task.command);
    const off = feature && !isFeatureEnabled(feature.id);
    return {
      label: `$(${commandIcons[task.command] ?? 'question'}) ${task.question}`,
      description: [task.key ? `${prefix} ${task.key}` : undefined, off ? `${feature.title} is off` : undefined].filter(Boolean).join(' · ') || undefined,
      command: task.command,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { title: 'How Do I…?', placeHolder: 'Pick a question; its analysis runs at the cursor', matchOnDescription: true });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

/** Every default shortcut of the extension with what it runs, as the keys VS Code shows; picking one runs it. */
async function showShortcutSheet(contributes: { keybindings: Keybinding[]; commands: { command: string; title: string }[] }): Promise<void> {
  const keys = shortcuts(contributes.keybindings);
  const items = contributes.commands
    .filter((c) => keys.has(c.command) && (!featureOf(c.command) || isFeatureEnabled(featureOf(c.command)!.id)))
    .map((c) => ({ label: `$(${commandIcons[c.command] ?? 'keyboard'}) ${c.title}`, description: keys.get(c.command), command: c.command }))
    .sort((a, b) => a.description!.localeCompare(b.description!));
  const editShortcuts: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Change Shortcuts…' };
  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = 'TypeScript Structure Shortcuts';
  picker.placeholder = 'Pick one to run it';
  picker.matchOnDescription = true;
  picker.items = items;
  picker.buttons = [editShortcuts];
  picker.onDidTriggerButton(() => {
    picker.hide();
    void vscode.commands.executeCommand('tsStructure.editKeybindings');
  });
  picker.onDidAccept(() => {
    const picked = picker.selectedItems[0];
    picker.hide();
    if (picked) {
      void vscode.commands.executeCommand(picked.command);
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

/** Flips a boolean setting where it is set (the workspace if it is set there, else the user settings) and says so. */
async function toggleSetting(key: string, fallback: boolean, what: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure');
  const on = !config.get(key, fallback);
  const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update(key, on, target);
  void vscode.window.setStatusBarMessage(`${what} ${on ? 'on' : 'off'}`, 3000);
}

export function deactivate(): void {}
