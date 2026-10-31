import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { pathKey } from '../analysis/paths';
import { Finding, Inspection, Severity, runInspections, suppressionEdit } from '../inspect/inspection';
import { builtInInspections } from '../inspect/registry';
import { languageSelector } from './refactorCommands';

const severities: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const docsUrl = 'https://github.com/RishiRajGujadhur/VSExtension#inspections';

interface Inspected {
  version: number;
  sourceFile?: ts.SourceFile;
  findings: Finding[];
  diagnostics: vscode.Diagnostic[];
}

/** Runs the live inspections on open TypeScript and JavaScript files and offers their fixes. */
export class InspectionDiagnostics implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];
  readonly collection = vscode.languages.createDiagnosticCollection('tsStructure');
  private readonly results = new Map<string, Inspected>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidInspect = this.changed.event;

  constructor(
    private readonly projects: ProjectService,
    private readonly extra: () => readonly Inspection[] = () => [],
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsStructure.inspections')) {
          this.refreshAll();
        }
      }),
      vscode.languages.registerCodeActionsProvider(languageSelector, this, { providedCodeActionKinds: InspectionDiagnostics.kinds }),
    );
    this.refreshAll();
  }

  refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 0);
    }
  }

  /** Findings for a document's current version, if it has been inspected. */
  findingsFor(document: vscode.TextDocument): Finding[] | undefined {
    const result = this.results.get(pathKey(document.uri.fsPath));
    return result?.version === document.version ? result.findings : undefined;
  }

  private schedule(document: vscode.TextDocument, delay = 500): void {
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
  }

  inspect(document: vscode.TextDocument): Finding[] {
    const config = vscode.workspace.getConfiguration('tsStructure');
    if (!config.get('inspections.enabled', true) || document.isClosed) {
      this.collection.delete(document.uri);
      return [];
    }
    const overrides = config.get<Record<string, Severity | 'off'>>('inspections.severity', {});
    const inspections = [...builtInInspections, ...this.extra()];
    let findings: Finding[] = [];
    let inspected: ts.SourceFile | undefined;
    try {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const project = this.projects.load(document.uri.fsPath, folder);
      const sourceFile = project.program.getSourceFile(document.uri.fsPath.replace(/\\/g, '/'));
      if (sourceFile && sourceFile.text === document.getText()) {
        inspected = sourceFile;
        findings = runInspections(inspections, { sourceFile, program: project.program, checker: project.checker }, (i) => overrides[i.id] ?? 'default');
      }
    } catch {
      // Files outside any compiler project are not inspected.
    }
    const diagnostics = findings.map((f) => this.toDiagnostic(document, f));
    this.results.set(pathKey(document.uri.fsPath), { version: document.version, sourceFile: inspected, findings, diagnostics });
    this.collection.set(document.uri, diagnostics);
    this.changed.fire(document.uri);
    return findings;
  }

  private toDiagnostic(document: vscode.TextDocument, finding: Finding): vscode.Diagnostic {
    const range = new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end));
    const diagnostic = new vscode.Diagnostic(range, finding.message, severities[finding.severity]);
    diagnostic.source = 'TS Structure';
    diagnostic.code = { value: finding.inspection, target: vscode.Uri.parse(`${docsUrl}-${finding.inspection.toLowerCase()}`) };
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

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const result = this.results.get(pathKey(document.uri.fsPath));
    if (!result || result.version !== document.version) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    result.findings.forEach((finding, index) => {
      const diagnostic = result.diagnostics[index];
      if (!context.diagnostics.includes(diagnostic) && !diagnostic.range.intersection(range)) {
        return;
      }
      for (const fix of finding.fixes ?? []) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = fix.preferred;
        action.edit = new vscode.WorkspaceEdit();
        for (const edit of fix.edits) {
          action.edit.replace(document.uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
        }
        actions.push(action);
      }
      const suppress = new vscode.CodeAction(`Suppress '${finding.inspection}' for this line`, vscode.CodeActionKind.QuickFix);
      suppress.diagnostics = [diagnostic];
      if (result.sourceFile) {
        const edit = suppressionEdit(result.sourceFile, finding);
        suppress.edit = new vscode.WorkspaceEdit();
        suppress.edit.insert(document.uri, document.positionAt(edit.start), edit.text);
        actions.push(suppress);
      }
      const configure = new vscode.CodeAction(`Configure '${finding.inspection}' severity…`, vscode.CodeActionKind.QuickFix);
      configure.command = { command: 'workbench.action.openSettings', title: 'Configure', arguments: ['tsStructure.inspections'] };
      configure.diagnostics = [diagnostic];
      actions.push(configure);
    });
    return actions;
  }
}
