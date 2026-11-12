import * as vscode from 'vscode';
import { showLastRefactoring } from './ui/applyRefactor';
import { rememberRewriteUses } from './ui/intentionProvider';
import { registerWarmUp } from './ui/warmUp';
import { remedies, remediesFor, runRemedy, showProblem, unexpectedRemedies } from './ui/problems';
import { ProjectService } from './analysis/project';
import { analyzeImpactAsync } from './analysis/impact';
import { AnalysisError, AnalysisScope, ImpactResult, SourceLocation, TestCase } from './analysis/types';
import { pathKey } from './analysis/paths';
import { ResultsProvider, countLabel, openLocation, showResultsPicker, trackResult } from './resultsView';
import { runTests } from './runner';
import { registerRefactorings } from './ui/refactorCommands';
import { registerAnalyses } from './ui/analysisCommands';
import { StructureView } from './ui/structureView';
import { DiagramPanel } from './ui/diagramView';
import { ControlFlowPanel } from './ui/controlFlowView';
import { ActionsView } from './ui/actionsView';
import { sourceEditor } from './ui/refactorCommands';
import { Report } from './structure/report';
import { InspectionDiagnostics } from './ui/inspectionDiagnostics';
import { customInspectionConfigs, registerStructuralSearch } from './ui/structuralSearchPanel';
import { customInspections } from './search/customInspections';
import { registerGraphDiff } from './ui/graphDiffCommand';
import { SideEffectLens } from './ui/sideEffectLens';
import { showActionsAtCursor } from './ui/actionsAtCursor';
import { CompilerErrorActions } from './ui/compilerErrorActions';
import { Inspection } from './inspect/inspection';
import { configureFeatures, registerCommand } from './ui/features';
import { activeFeature } from './ui/activeFeature';
import { registerLastSubjects } from './ui/lastSubjects';
import { ValuePathView } from './ui/valuePathView';
import { registerGuide } from './ui/welcomeView';
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
  // The project of the file being edited is prepared in the background, so the first analysis is quick.
  registerWarmUp(context, projects);
  rememberRewriteUses(context.globalState);
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
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}');
  sourceWatcher.onDidCreate(() => projects.invalidateFileList());
  sourceWatcher.onDidDelete(() => projects.invalidateFileList());
  // A file changed outside the editor (a checkout, a formatter): read it again on the next analysis.
  sourceWatcher.onDidChange((uri) => projects.fileChanged(uri.fsPath));

  // Before anything that reads the scope, so its cache is cleared first when the settings change.
  registerScope(context);
  registerScopeCommands(context);
  rememberScopesIn(context.workspaceState);
  const run = (tests: TestCase[]) => void runTests(tests);
  registerRefactorings(context, projects);
  const structureView = new StructureView(context.workspaceState, context.extensionUri);
  registerAnalyses(context, projects, structureView);
  const diagram = new DiagramPanel(context.extensionUri, structureView);
  // Graph analyses open as a chart straight away; the results view keeps the same rows as a tree.
  const graphKinds = new Set(['callGraph', 'reactState']);
  // Only a newly run graph opens the chart: filtering it or going back to it in the results view doesn't.
  // With "always show as diagram" on, every new result opens as a chart too.
  const alwaysDiagram = () => vscode.workspace.getConfiguration('tsStructure.results').get('alwaysShowDiagram', false);
  context.subscriptions.push(
    structureView.onDidShowNewReport((report) => (graphKinds.has(report.kind) || alwaysDiagram()) && diagram.show()),
    // The Actions view highlights the action whose result is on screen.
    structureView.onDidShowNewReport(() => activeFeature.reportShown()),
    registerCommand('tsStructure.report.diagramsOn', async () => {
      await vscode.workspace.getConfiguration('tsStructure.results').update('alwaysShowDiagram', true, vscode.ConfigurationTarget.Global);
      if (structureView.report) diagram.show();
      void vscode.window.setStatusBarMessage('$(circuit-board) New results now open as diagrams too', 4000);
    }),
    registerCommand('tsStructure.report.diagramsOff', async () => {
      await vscode.workspace.getConfiguration('tsStructure.results').update('alwaysShowDiagram', false, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage('Results no longer open as diagrams', 4000);
    }),
  );
  const controlFlow = new ControlFlowPanel(context.extensionUri, projects);
  controlFlow.register(context);
  // The Actions view at the top of the sidebar: search, Analyze and Edit tabs, Most Used and categories.
  const actionsView = new ActionsView(context.extensionUri, context.globalState, context.extension.packageJSON.contributes?.keybindings ?? []);
  registerLastSubjects(context);
  actionsView.register(context);
  // A Value path result shows as a card in the Value path panel, in the Results view's place.
  new ValuePathView(context.extensionUri, structureView).register(context);
  context.subscriptions.push(
    // The function at the cursor as a flowchart with its paths; returns the chart for tests.
    registerCommand('tsStructure.sliceBackward', () => {
      const editor = sourceEditor();
      if (editor) controlFlow.showSlice(editor, 'backward');
      return controlFlow.current;
    }),
    registerCommand('tsStructure.sliceForward', () => {
      const editor = sourceEditor();
      if (editor) controlFlow.showSlice(editor, 'forward');
      return controlFlow.current;
    }),
    registerCommand('tsStructure.controlFlow', () => {
      const editor = sourceEditor();
      if (editor) controlFlow.show(editor);
      return controlFlow.current;
    }),
    // The Program Dependence Graph: the control flow chart with its data and control dependences drawn on it.
    registerCommand('tsStructure.dependenceGraph', () => {
      const editor = sourceEditor();
      if (editor) controlFlow.showDependences(editor);
      return controlFlow.current;
    }),
  );
  context.subscriptions.push(
    registerCommand('tsStructure.report.showDiagram', () => diagram.show()),
    // Data Flow at the cursor, drawn as a chart.
    registerCommand('tsStructure.dataFlowDiagram', async () => {
      const report = await vscode.commands.executeCommand<Report | undefined>('tsStructure.dataFlow');
      if (report?.kind === 'dataFlow') {
        diagram.show();
      }
      return report;
    }),
  );
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
    registerCommand('tsStructure.showLastRefactoring', () => showLastRefactoring()),
    // A fix offered as a link in an error message.
    vscode.commands.registerCommand('tsStructure.runRemedy', (id: unknown) => runRemedy(id)),
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
          void showProblem('Place the cursor on a symbol in a TypeScript or JavaScript file.', [remedies.openFile]);
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
          // Nothing found: say how much was searched, and offer the wider search or a different question.
          void showProblem(
            `No tests found that depend on ${result.target.name} (${result.filesScanned} files, ${result.testFilesScanned} test files scanned).${result.testFilesScanned ? '' : ' No test files were found: they are named *.test.ts or *.spec.ts, sit in a test or __tests__ folder, or import a test framework.'}`,
            [
              ...(scope !== 'module' ? [{ title: 'Test the whole file', run: () => vscode.commands.executeCommand('tsImpact.analyzeFile', document.uri) }] : []),
              { title: 'Search deeper', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'tsImpact.maxDepth') },
              remedies.howDoI,
            ],
            'info',
          );
          return result;
        }
        const confirmedCount = result.tests.filter((t) => t.confidence === 'confirmed').length;
        void vscode.window.setStatusBarMessage(`$(beaker) ${result.tests.length} impacted test${result.tests.length === 1 ? '' : 's'} (${confirmedCount} confirmed) for ${result.target.name}`, 6000);
        await showResultsPicker(result, run);
        return result;
      } catch (error) {
        if (error instanceof AnalysisError) void showProblem(error.message, remediesFor(error));
        else void showProblem(`Test impact analysis failed: ${String(error)}`, unexpectedRemedies('Test impact analysis', error));
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
          { label: 'Test names', description: 'file: suite › test, one per line', files: false },
          { label: 'Test files', description: 'each file once', files: true },
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
        if (changed) void showProblem('No TypeScript or JavaScript files have changed since the last commit.', [{ title: 'Test impact at the cursor', run: () => vscode.commands.executeCommand('tsImpact.analyze') }], 'info');
        else void showProblem('Changed files need a Git repository.', [remedies.initGit, remedies.sourceControl]);
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
    { label: 'Function or symbol at cursor', description: 'Tests that depend on the selected symbol', scope: 'symbol' as const },
    { label: 'Active module', description: 'Tests that depend on anything in this file', scope: 'module' as const },
  ]
    .map((item) => (item.scope === last ? { ...item, description: `${item.description} · last used` } : item))
    .sort((a, b) => Number(b.scope === last) - Number(a.scope === last));
  const picked = await vscode.window.showQuickPick(items, { title: 'Test impact analysis', placeHolder: 'Choose what changed' });
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

/**
 * Ask the rubber duck…: the questions the extension answers, in plain words, each running its command. Like any
 * good rubber duck it listens; type "quack" and it answers back.
 */
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
  type Item = vscode.QuickPickItem & { command?: string };
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'Ask the rubber duck';
  picker.placeholder = 'Pick a question; its analysis runs at the cursor';
  picker.matchOnDescription = true;
  picker.items = items;
  const duck: Item = { label: '$(comment) Quack.', detail: 'Explaining the problem to me usually solves it. Now pick a question, or keep talking.', alwaysShow: true };
  picker.onDidChangeValue((value) => {
    const quacked = /^\s*quack[.!]*\s*$/i.test(value);
    if (quacked !== picker.items.includes(duck)) picker.items = quacked ? [duck, ...items] : items;
  });
  const picked = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item === duck) return;
      resolve(item);
      picker.hide();
    });
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (picked?.command) {
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
  const editShortcuts: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Change shortcuts…' };
  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = 'Cheat codes';
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
