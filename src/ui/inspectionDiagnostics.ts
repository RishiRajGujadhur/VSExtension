import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { hashText, normalizePath, pathKey } from '../analysis/paths';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { TextEdit } from '../intentions/intentions';
import { Finding, Inspection, InspectionOptions, Severity, fileSuppressionEdit, fixAllEdits, runInspections, suppressionEdit } from '../inspect/inspection';
import { InspectedFile, inspectionReport } from '../inspect/inspectionReport';
import { builtInInspections } from '../inspect/registry';
import { Report, ReportNode } from '../structure/report';
import { FixLedger, RowFix, fixesUnder, rowFix } from '../structure/fixes';
import { languageSelector } from './refactorCommands';
import { StructureView } from './structureView';
import { isExcluded, scopedFiles, withNote } from './exclude';
import { ScopeKind, chooseScope } from './analysisScope';
import { ScopeSpec, scopeFilter } from '../structure/scope';
import { registerCommand } from './features';
import { withRunning } from './analysisCommands';
import { isFeatureEnabled } from './features';

const severities: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const docsUrl = 'https://github.com/RishiRajGujadhur/VSExtension#find-problems';
/** Custom inspections are documented together, in the builder's guide. */
const customDocsUrl = 'https://github.com/RishiRajGujadhur/VSExtension#find-problems';
const fixAllKind = vscode.CodeActionKind.SourceFixAll.append('tsStructure');

/** Analyses that explain a finding in depth, offered from its lightbulb. */
const explainers: Record<string, { title: string; command: string }> = {
  missingAwait: { title: 'Trace where this promise’s rejection goes…', command: 'tsStructure.promiseRejections' },
};

interface Inspected {
  version: number;
  sourceFile?: ts.SourceFile;
  findings: Finding[];
  diagnostics: vscode.Diagnostic[];
}

const severityRank: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Runs the live inspections on visible TypeScript and JavaScript files and offers their fixes. */
export class InspectionDiagnostics implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, fixAllKind];
  readonly collection = vscode.languages.createDiagnosticCollection('tsStructure');
  private readonly results = new Map<string, Inspected>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly status = vscode.window.createStatusBarItem('tsStructure.inspections', vscode.StatusBarAlignment.Right, 100);

  constructor(
    private readonly projects: ProjectService,
    private readonly extra: () => readonly Inspection[] = () => [],
  ) {
    this.status.name = 'TypeScript Structure Inspections';
    this.status.command = { command: 'tsStructure.inspectionsMenu', title: 'Inspections' };
  }

  register(context: vscode.ExtensionContext, view: StructureView): void {
    context.subscriptions.push(
      this.collection,
      this.status,
      // Only files on screen are inspected; others are when they are shown.
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.scheduleIfStale(e.document))),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length > 0 && this.isVisible(e.document) && runOn(e.document.uri) === 'type' && this.schedule(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.isVisible(d) && runOn(d.uri) === 'save' && this.schedule(d, 0)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsStructure.inspections') || e.affectsConfiguration('tsStructure.features.inspections') || e.affectsConfiguration('tsStructure.customInspections') || e.affectsConfiguration('tsStructure.exclude') || e.affectsConfiguration('tsStructure.include') || e.affectsConfiguration('tsStructure.missingAwait') || e.affectsConfiguration('tsStructure.typeAssertion')) {
          // Files inspected earlier but not on screen are inspected again too, so findings of
          // a disabled inspection or an excluded file don't linger in the Problems panel.
          const inspected = new Set(this.results.keys());
          this.results.clear();
          for (const document of vscode.workspace.textDocuments) {
            if (inspected.has(pathKey(document.uri.fsPath))) {
              this.schedule(document, 0);
            }
          }
          this.refreshAll();
        }
      }),
      vscode.languages.registerCodeActionsProvider(languageSelector, this, { providedCodeActionKinds: InspectionDiagnostics.kinds }),
      // From the Explorer the arguments are the clicked file or folder and every selected one.
      registerCommand('tsStructure.inspectCode', (scope?: 'file' | 'project' | 'changed' | vscode.Uri, selected?: vscode.Uri[]) =>
        this.inspectCode(view, scope instanceof vscode.Uri ? (selected?.length ? selected : [scope]) : scope),
      ),
      registerCommand('tsStructure.report.applyFix', (node: ReportNode) => applyReportFixes(view, node, rowFix(node) ? [rowFix(node)!] : [])),
      registerCommand('tsStructure.report.applyAllFixes', (node: ReportNode) => applyReportFixes(view, node, node ? fixesUnder(node, (n) => view.isDone(n)) : [])),
      registerCommand('tsStructure.turnOffInspection', (id: string, uri?: vscode.Uri) => turnOffInspection(id, uri)),
      registerCommand('tsStructure.configureInspections', () => this.configureInspections()),
      registerCommand('tsStructure.inspectionsMenu', () => this.menu()),
      registerCommand('tsStructure.explainFinding', async (uri: vscode.Uri, offset: number, command: string) => {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        const position = document.positionAt(offset);
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand(command);
      }),
    );
    this.refreshAll();
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.schedule(editor.document, 0);
    }
  }

  /** Findings for a document's current version, if it has been inspected. */
  findingsFor(document: vscode.TextDocument): Finding[] | undefined {
    const result = this.results.get(pathKey(document.uri.fsPath));
    return result?.version === document.version ? result.findings : undefined;
  }

  private isVisible(document: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some((e) => e.document === document);
  }

  private scheduleIfStale(document: vscode.TextDocument): void {
    if (this.results.get(pathKey(document.uri.fsPath))?.version !== document.version) {
      this.schedule(document, 50);
    }
  }

  private schedule(document: vscode.TextDocument, delay = vscode.workspace.getConfiguration('tsStructure', document.uri).get('inspections.delay', 500)): void {
    if (document.uri.scheme !== 'file' || vscode.languages.match(languageSelector, document) === 0) {
      return;
    }
    const key = pathKey(document.uri.fsPath);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.inspect(document);
      }, delay),
    );
  }

  private forget(uri: vscode.Uri): void {
    const key = pathKey(uri.fsPath);
    clearTimeout(this.timers.get(key));
    this.results.delete(key);
    this.collection.delete(uri);
    this.updateStatus();
  }

  private inspections(): Inspection[] {
    return [...builtInInspections, ...this.extra()];
  }

  private severityOf(uri: vscode.Uri): (inspection: Inspection) => Severity | 'off' | 'default' {
    const overrides = vscode.workspace.getConfiguration('tsStructure', uri).get<Record<string, Severity | 'off' | 'default'>>('inspections.severity', {});
    return (i) => overrides[i.id] ?? 'default';
  }

  inspect(document: vscode.TextDocument): Finding[] {
    const config = vscode.workspace.getConfiguration('tsStructure', document.uri);
    if (!config.get('inspections.enabled', true) || !isFeatureEnabled('inspections') || document.isClosed || isExcluded(document.uri.fsPath)) {
      this.collection.delete(document.uri);
      this.results.delete(pathKey(document.uri.fsPath));
      this.updateStatus();
      return [];
    }
    let findings: Finding[] = [];
    let inspected: ts.SourceFile | undefined;
    try {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const project = this.projects.load(document.uri.fsPath, folder);
      const sourceFile = project.program.getSourceFile(normalizePath(document.uri.fsPath));
      if (sourceFile && sourceFile.text === document.getText()) {
        inspected = sourceFile;
        findings = runInspections(this.inspections(), { sourceFile, program: project.program, checker: project.checker, options: inspectionOptions(document.uri) }, this.severityOf(document.uri));
      }
    } catch {
      // Files outside any compiler project are not inspected.
    }
    const diagnostics = findings.map((f) => toDiagnostic(document, f));
    this.results.set(pathKey(document.uri.fsPath), { version: document.version, sourceFile: inspected, findings, diagnostics });
    this.collection.set(document.uri, diagnostics);
    this.updateStatus();
    return findings;
  }

  /** The status bar item's menu: inspect at three sizes, configure, or pause live inspections. */
  private async menu(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    const findings = document ? this.findingsFor(document) : undefined;
    const paused = !vscode.workspace.getConfiguration('tsStructure', document?.uri).get('inspections.enabled', true);
    type Item = vscode.QuickPickItem & { run?: () => Thenable<unknown> };
    // The file's own problems come first, worst first, to jump straight to one.
    const problems: Item[] = (findings ?? [])
      .map((finding) => ({ finding, line: document!.positionAt(finding.start).line }))
      .sort((a, b) => severityRank[a.finding.severity] - severityRank[b.finding.severity] || a.line - b.line)
      .slice(0, 50)
      .map(({ finding, line }) => ({
        label: `$(${finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info'}) ${finding.message}`,
        description: `line ${line + 1} · ${finding.inspection}`,
        run: async () => {
          const range = new vscode.Range(document!.positionAt(finding.start), document!.positionAt(finding.end));
          await vscode.window.showTextDocument(document!, { selection: range });
        },
      }));
    const items: Item[] = [
      ...(problems.length ? [{ label: 'In this file', kind: vscode.QuickPickItemKind.Separator }, ...problems, { label: 'Inspections', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...(document && findings && fixAllEdits(findings).length
        ? [
            {
              label: '$(check-all) Fix All in This File',
              description: `${fixAllEdits(findings).length} fix${fixAllEdits(findings).length === 1 ? '' : 'es'}`,
              run: async () => {
                const edit = new vscode.WorkspaceEdit();
                for (const e of fixAllEdits(findings)) {
                  edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
                }
                return vscode.workspace.applyEdit(edit);
              },
            },
          ]
        : []),
      { label: '$(list-flat) Show Problems in This File', description: findings ? `${findings.length}` : undefined, run: () => vscode.commands.executeCommand('workbench.actions.view.problems') },
      { label: '$(file-code) Inspect Current File', run: () => vscode.commands.executeCommand('tsStructure.inspectCode', 'file') },
      { label: '$(git-compare) Inspect Changed Files', run: () => vscode.commands.executeCommand('tsStructure.inspectCode', 'changed') },
      { label: '$(project) Inspect Whole Project', run: () => vscode.commands.executeCommand('tsStructure.inspectCode', 'project') },
      { label: '$(settings) Configure Inspections…', run: () => vscode.commands.executeCommand('tsStructure.configureInspections') },
      { label: '$(comment-discussion) How Do I…?', run: () => vscode.commands.executeCommand('tsStructure.howDoI') },
      { label: '$(list-tree) Analyze or Refactor This…', run: () => vscode.commands.executeCommand('tsStructure.actionsAtCursor') },
      paused
        ? {
            label: '$(debug-start) Resume Live Inspections',
            detail: 'Inspects visible files as you type again.',
            run: async () => {
              const config = vscode.workspace.getConfiguration('tsStructure');
              // Clear the workspace value that paused them; a user setting that turns them off is changed only if it is the reason.
              await config.update('inspections.enabled', undefined, vscode.ConfigurationTarget.Workspace);
              if (!vscode.workspace.getConfiguration('tsStructure').get('inspections.enabled', true)) {
                await config.update('inspections.enabled', true, vscode.ConfigurationTarget.Global);
              }
            },
          }
        : {
            label: '$(debug-pause) Pause Live Inspections',
            detail: 'Stops inspecting while you type, for this workspace. Turn back on in the settings or from this menu.',
            run: () => vscode.workspace.getConfiguration('tsStructure').update('inspections.enabled', false, vscode.ConfigurationTarget.Workspace),
          },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'TypeScript Structure Inspections', placeHolder: problems.length ? 'Pick a problem to go to it, or an action' : undefined, matchOnDescription: true });
    await picked?.run?.();
  }

  /** Lists every inspection with its severity; picking one asks for a new severity, until the list is closed. */
  private async configureInspections(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    for (;;) {
      const config = vscode.workspace.getConfiguration('tsStructure', uri);
      const overrides = config.get<Record<string, string>>('inspections.severity', {});
      const items = this.inspections().map((inspection) => {
        const setting = overrides[inspection.id] ?? 'default';
        return {
          label: inspection.title,
          description: setting === 'default' ? (inspection.optIn ? 'off until turned on' : inspection.defaultSeverity) : setting === 'off' ? 'off' : `${setting} (default ${inspection.optIn ? 'off' : inspection.defaultSeverity})`,
          detail: inspection.id,
          inspection,
        };
      });
      // Inspections that report on their own first, then those that wait to be turned on.
      type Row = (typeof items)[number] | vscode.QuickPickItem;
      const grouped: Row[] = [
        { label: 'On', kind: vscode.QuickPickItemKind.Separator },
        ...items.filter((i) => !i.inspection.optIn),
        { label: 'Off until turned on', kind: vscode.QuickPickItemKind.Separator },
        ...items.filter((i) => i.inspection.optIn),
      ];
      const choice = await vscode.window.showQuickPick(grouped, { title: 'Configure Inspections', placeHolder: 'Pick an inspection to change its severity', matchOnDetail: true });
      const picked = choice && 'inspection' in choice ? choice : undefined;
      if (!picked) {
        return;
      }
      const current = overrides[picked.inspection.id] ?? 'default';
      const severity = await vscode.window.showQuickPick(
        ['default', 'error', 'warning', 'info', 'hint', 'off'].map((value) => ({
          label: `${value === current ? '$(check) ' : ''}${value}`,
          description: value === 'default' ? `as reported (${picked.inspection.defaultSeverity})` : value === 'off' ? 'not reported' : undefined,
          value,
        })),
        { title: picked.inspection.title, placeHolder: 'Severity' },
      );
      if (severity && severity.value !== current) {
        const inspected = config.inspect<Record<string, string>>('inspections.severity');
        const before = { ...((target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue) ?? {}) };
        if (severity.value === 'default') {
          delete before[picked.inspection.id];
        } else {
          before[picked.inspection.id] = severity.value;
        }
        await config.update('inspections.severity', Object.keys(before).length ? before : undefined, target);
      }
    }
  }

  /** Counts for the active file in the status bar; clicking runs Inspect Code on it. */
  private updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    const config = document && vscode.workspace.getConfiguration('tsStructure', document.uri);
    if (!document || !config?.get('inspections.statusBar', true) || !isFeatureEnabled('inspections') || vscode.languages.match(languageSelector, document) === 0) {
      this.status.hide();
      return;
    }
    // Paused inspections stay visible, so it is clear why nothing is reported and how to resume.
    if (!config.get('inspections.enabled', true)) {
      this.status.text = '$(debug-pause) TS Structure';
      this.status.tooltip = 'TypeScript Structure live inspections are paused. Click to resume them or inspect on demand.';
      this.status.show();
      return;
    }
    const result = this.results.get(pathKey(document.uri.fsPath));
    if (!result) {
      this.status.hide();
      return;
    }
    const count = (severity: Severity) => result.findings.filter((f) => f.severity === severity).length;
    const problems = result.findings.filter((f) => f.severity !== 'hint').length;
    this.status.text = problems ? `$(checklist) ${problems}` : '$(pass) TS Structure';
    // Which inspections report what in this file, as a table in the hover.
    const byInspection = new Map<string, number>();
    for (const finding of result.findings) {
      byInspection.set(finding.inspection, (byInspection.get(finding.inspection) ?? 0) + 1);
    }
    const tooltip = new vscode.MarkdownString(`**TypeScript Structure inspections in this file**\n\n${count('error')} errors, ${count('warning')} warnings, ${count('info')} infos, ${count('hint')} hints`);
    if (byInspection.size) {
      tooltip.appendMarkdown(`\n\n| Inspection | Problems |\n| --- | --: |\n${[...byInspection].map(([id, n]) => `| ${id} | ${n} |`).join('\n')}`);
    }
    tooltip.appendMarkdown('\n\nClick to go to a problem, inspect more or configure.');
    this.status.tooltip = tooltip;
    this.status.show();
  }

  /** Inspect Code: every inspection over the current file or the whole project, as a report. */
  private async inspectCode(view: StructureView, scopeArg?: ScopeKind | vscode.Uri[]): Promise<Report | undefined> {
    if (Array.isArray(scopeArg)) {
      return this.inspectPaths(view, scopeArg);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || vscode.languages.match(languageSelector, editor.document) === 0) {
      void vscode.window.showErrorMessage('Open a TypeScript or JavaScript file first.');
      return;
    }
    const scope = await chooseScope({ id: 'inspectCode', title: 'Inspect Code', kinds: ['project', 'folder', 'pickFolder', 'open', 'changed', 'file', 'function', 'selection'], editor }, scopeArg);
    if (!scope) {
      return;
    }
    return this.runInspectCode(view, editor.document.uri, scope.kind === 'project' ? undefined : scopeFilter(scope.spec), scope.label, scope.spec.lines);
  }

  /** Inspect Code on files and folders picked in the Explorer: every source file in or below them. */
  private async inspectPaths(view: StructureView, uris: vscode.Uri[]): Promise<Report | undefined> {
    const sourceGlob = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
    let anchor: vscode.Uri | undefined;
    for (const uri of uris) {
      const isFile = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
      anchor = isFile ? uri : (await vscode.workspace.findFiles(new vscode.RelativePattern(uri, sourceGlob), '**/node_modules/**', 1))[0];
      if (anchor) {
        break;
      }
    }
    if (!anchor) {
      void vscode.window.showInformationMessage('There are no TypeScript or JavaScript files there to inspect.');
      return;
    }
    const roots = uris.map((u) => pathKey(u.fsPath));
    return this.runInspectCode(view, anchor, (f) => roots.some((root) => pathKey(f) === root || pathKey(f).startsWith(`${root}/`)));
  }

  /** Runs every inspection over the anchor file's project, or the files of it that `include` accepts, or only `lines` of one file. */
  private async runInspectCode(view: StructureView, anchor: vscode.Uri, include?: (fileName: string) => boolean, what?: string, lines?: ScopeSpec['lines']): Promise<Report | undefined> {
    const fileName = anchor.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(anchor)?.uri.fsPath;
    const run = () =>
      withRunning(view, 'Inspect Code', (stop) =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Inspecting code', cancellable: true }, async (progress, notificationToken) => {
        // Either the notification's Cancel or the results view's stop button ends it between files.
        const token = { get isCancellationRequested() { return notificationToken.isCancellationRequested || stop.isCancellationRequested; } };
        const started = Date.now();
        const project = this.projects.load(fileName, folder);
        const candidates = projectSourceFiles(project.program).filter((sf) => !include || include(sf.fileName));
        const single = candidates.length === 1 && pathKey(candidates[0].fileName) === pathKey(fileName);
        // A single file asked for by name is inspected even when the scope settings leave it out.
        const scoped = single ? { files: candidates, note: undefined } : scopedFiles(candidates);
        const files = scoped.files;
        const inspected: InspectedFile[] = [];
        const inspections = this.inspections();
        const severityOf = this.severityOf(anchor);
        const options = inspectionOptions(anchor);
        for (const [i, sourceFile] of files.entries()) {
          if (token.isCancellationRequested) {
            return undefined;
          }
          progress.report({ message: `${i + 1}/${files.length} ${path.basename(sourceFile.fileName)}`, increment: 100 / files.length });
          const findings = runInspections(inspections, { sourceFile, program: project.program, checker: project.checker, options }, severityOf);
          inspected.push({ sourceFile, findings: lines ? findings.filter((f) => overlaps(sourceFile, f, lines)) : findings });
          // Yield so the progress updates and cancellation can arrive.
          await new Promise((resolve) => setImmediate(resolve));
        }
        const report = withNote(inspectionReport(inspected, inspections, folder), scoped.note);
        if (what) {
          report.title = `${report.title} in ${what}`;
        }
        report.durationMs = Date.now() - started;
        return report;
      }));
    const report = await run();
    if (report) {
      await view.show(report, run);
    }
    return report;
  }

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const result = this.results.get(pathKey(document.uri.fsPath));
    if (!result || result.version !== document.version) {
      return [];
    }
    const toWorkspaceEdit = (edits: readonly TextEdit[]) => {
      const edit = new vscode.WorkspaceEdit();
      for (const e of edits) {
        edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
      }
      return edit;
    };
    // `editor.codeActionsOnSave: { "source.fixAll.tsStructure": "explicit" }` applies every preferred fix.
    if (context.only?.contains(fixAllKind) || (context.only && fixAllKind.contains(context.only))) {
      const edits = fixAllEdits(result.findings);
      if (edits.length === 0) {
        return [];
      }
      const action = new vscode.CodeAction('Fix all TypeScript Structure problems', fixAllKind);
      action.edit = toWorkspaceEdit(edits);
      return [action];
    }
    const actions: vscode.CodeAction[] = [];
    const offered = new Set<string>();
    result.findings.forEach((finding, index) => {
      const diagnostic = result.diagnostics[index];
      if (!context.diagnostics.includes(diagnostic) && !diagnostic.range.intersection(range)) {
        return;
      }
      for (const fix of finding.fixes ?? []) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = fix.preferred;
        action.edit = toWorkspaceEdit(fix.edits);
        actions.push(action);
      }
      const sameKind = result.findings.filter((f) => f.inspection === finding.inspection && f.fixes?.length);
      if (sameKind.length > 1 && !offered.has(`all:${finding.inspection}`)) {
        offered.add(`all:${finding.inspection}`);
        const all = new vscode.CodeAction(`Fix all '${finding.inspection}' problems in this file`, vscode.CodeActionKind.QuickFix);
        all.edit = toWorkspaceEdit(fixAllEdits(sameKind));
        actions.push(all);
      }
      const explainer = finding.explain ?? (explainers[finding.inspection] && { ...explainers[finding.inspection], offset: finding.start });
      if (explainer) {
        const explain = new vscode.CodeAction(explainer.title, vscode.CodeActionKind.QuickFix);
        explain.command = { command: 'tsStructure.explainFinding', title: explainer.title, arguments: [document.uri, explainer.offset, explainer.command] };
        actions.push(explain);
      }
      if (result.sourceFile) {
        const line = suppressionEdit(result.sourceFile, finding);
        const suppress = new vscode.CodeAction(`Suppress '${finding.inspection}' for this line`, vscode.CodeActionKind.QuickFix);
        suppress.diagnostics = [diagnostic];
        suppress.edit = toWorkspaceEdit([line]);
        actions.push(suppress);
        if (!offered.has(`file:${finding.inspection}`)) {
          offered.add(`file:${finding.inspection}`);
          const file = new vscode.CodeAction(`Suppress '${finding.inspection}' for this file`, vscode.CodeActionKind.QuickFix);
          file.diagnostics = [diagnostic];
          file.edit = toWorkspaceEdit([fileSuppressionEdit(result.sourceFile, finding.inspection)]);
          actions.push(file);
        }
      }
      if (finding.inspection.startsWith('custom:') && !offered.has(`custom:${finding.inspection}`)) {
        // A custom inspection is changed where it was built: in the structural search builder.
        offered.add(`custom:${finding.inspection}`);
        const id = finding.inspection.slice('custom:'.length);
        const edit = new vscode.CodeAction(`Edit custom inspection '${id}'…`, vscode.CodeActionKind.QuickFix);
        edit.command = { command: 'tsStructure.editCustomInspection', title: edit.title, arguments: [id] };
        const disable = new vscode.CodeAction(`Disable custom inspection '${id}'`, vscode.CodeActionKind.QuickFix);
        disable.command = { command: 'tsStructure.disableCustomInspection', title: disable.title, arguments: [id] };
        actions.push(edit, disable);
      }
      if (!finding.inspection.startsWith('custom:') && !offered.has(`off:${finding.inspection}`)) {
        offered.add(`off:${finding.inspection}`);
        const off = new vscode.CodeAction(`Turn off '${finding.inspection}' inspection`, vscode.CodeActionKind.QuickFix);
        off.command = { command: 'tsStructure.turnOffInspection', title: off.title, arguments: [finding.inspection, document.uri] };
        off.diagnostics = [diagnostic];
        actions.push(off);
      }
      if (!offered.has(`configure:${finding.inspection}`)) {
        offered.add(`configure:${finding.inspection}`);
        const configure = new vscode.CodeAction(`Configure '${finding.inspection}' severity…`, vscode.CodeActionKind.QuickFix);
        configure.command = { command: 'tsStructure.configureInspections', title: 'Configure' };
        configure.diagnostics = [diagnostic];
        actions.push(configure);
      }
    });
    return actions;
  }
}

function toDiagnostic(document: vscode.TextDocument, finding: Finding): vscode.Diagnostic {
  const range = new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end));
  const diagnostic = new vscode.Diagnostic(range, finding.message, severities[finding.severity]);
  diagnostic.source = 'TS Structure';
  const docs = finding.inspection.startsWith('custom:') ? customDocsUrl : docsUrl;
  diagnostic.code = { value: finding.inspection, target: vscode.Uri.parse(docs) };
  if (finding.unnecessary) {
    diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
  }
  diagnostic.relatedInformation = finding.related?.map((r) => {
    const sourceFile = r.node.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(r.node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(r.node.end);
    return new vscode.DiagnosticRelatedInformation(
      new vscode.Location(vscode.Uri.file(sourceFile.fileName), new vscode.Range(start.line, start.character, end.line, end.character)),
      r.message,
    );
  });
  return diagnostic;
}

/** Sets the inspection's severity to `off` in the workspace settings (user settings without a folder), with Undo. */
async function turnOffInspection(id: string, uri?: vscode.Uri): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure', uri);
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const inspected = config.inspect<Record<string, string>>('inspections.severity');
  const before = (target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue) ?? {};
  await config.update('inspections.severity', { ...before, [id]: 'off' }, target);
  const where = target === vscode.ConfigurationTarget.Workspace ? 'this workspace' : 'your user settings';
  const choice = await vscode.window.showInformationMessage(`Turned off the '${id}' inspection in ${where}.`, 'Undo', 'Open Settings');
  if (choice === 'Undo') {
    await config.update('inspections.severity', Object.keys(before).length ? before : undefined, target);
  } else if (choice) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'tsStructure.inspections.severity');
  }
}

/** Fixes applied from reports, so the next fix in the same file still applies without re-running. */
const ledger = new FixLedger();

/**
 * Applies fixes stored on report rows (one row's, or every one under a group) and marks the rows
 * fixed. A file changed only by earlier fixes from the report is still fixable; any other change is not.
 */
async function applyReportFixes(view: StructureView, node: ReportNode, fixes: RowFix[]): Promise<void> {
  if (fixes.length === 0) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  const applied: { fix: RowFix; edits: TextEdit[]; before: string; document: vscode.TextDocument }[] = [];
  const stale: string[] = [];
  for (const fix of fixes) {
    const document = await vscode.workspace.openTextDocument(fix.file);
    const before = hashText(document.getText());
    const edits = ledger.rebase(fix, before);
    if (!edits) {
      stale.push(path.basename(fix.file));
      continue;
    }
    for (const e of edits) {
      edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
    }
    applied.push({ fix, edits, before, document });
  }
  if (applied.length && (await vscode.workspace.applyEdit(edit))) {
    for (const { fix, edits, before, document } of applied) {
      ledger.record(fix.file, edits, before, hashText(document.getText()));
    }
    view.markFixed(node);
    void vscode.window.setStatusBarMessage(`Applied: ${applied.length === 1 ? applied[0].fix.title : `fixes in ${applied.length} files`}`, 3000);
  }
  if (stale.length) {
    void vscode.window.showWarningMessage(`${stale.join(', ')} changed since the analysis. Re-run it to fix.`);
  }
}

/** `type` inspects while editing; `save` only when the file is saved, for big projects. */
function runOn(uri: vscode.Uri): 'type' | 'save' {
  return vscode.workspace.getConfiguration('tsStructure', uri).get('inspections.run', 'type');
}

/** Whether a finding is on the lines of a function or selection. */
function overlaps(sourceFile: ts.SourceFile, finding: Finding, lines: NonNullable<ScopeSpec['lines']>): boolean {
  return sourceFile.getLineAndCharacterOfPosition(finding.end).line >= lines.start && sourceFile.getLineAndCharacterOfPosition(finding.start).line <= lines.end;
}

function inspectionOptions(uri: vscode.Uri): InspectionOptions {
  const config = vscode.workspace.getConfiguration('tsStructure', uri);
  return { missingAwaitIgnore: config.get<string[]>('missingAwait.ignore', []), typeAssertionIgnoreTests: config.get('typeAssertion.ignoreTestFiles', false) };
}
