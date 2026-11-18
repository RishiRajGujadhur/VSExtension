import * as vscode from 'vscode';
import type { Severity } from '../inspect/inspection';
import { isFeatureEnabled } from './features';
import { isExcluded } from './exclude';

/**
 * Live inspections for a language Code X-Ray reads without TypeScript (C#, T-SQL): its syntax checks on open files,
 * in the Problems panel with the TypeScript ones. They follow the same switches: the Inspections feature, Inspections:
 * Enabled, the delay after typing, and each inspection's severity (or off) in Inspections: Severity.
 */

/** What a language's checks report: an inspection id, a message, a severity and a character range. */
export interface SyntaxFinding {
  inspection: string;
  message: string;
  severity: Severity;
  start: number;
  end: number;
}
const severities: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export class SyntaxDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** `languages` are VS Code language ids, such as csharp or sql; `inspect` runs the checks on a file's text. */
  constructor(
    private readonly languages: readonly string[],
    private readonly inspect: (text: string) => SyntaxFinding[] | Promise<SyntaxFinding[]>,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection(`tsStructure.${languages[0]}`);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsStructure.inspections') || e.affectsConfiguration('tsStructure.features.inspections') || e.affectsConfiguration('tsStructure.exclude')) {
          vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0));
        }
      }),
      { dispose: () => this.timers.forEach((t) => clearTimeout(t)) },
    );
    vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0));
  }

  private schedule(document: vscode.TextDocument, delay?: number): void {
    if (!this.languages.includes(document.languageId) || document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    const wait = delay ?? vscode.workspace.getConfiguration('tsStructure', document.uri).get('inspections.delay', 500);
    this.timers.set(key, setTimeout(() => void this.run(document), wait));
  }

  /** Inspects the file now; returns the diagnostics, for tests. */
  async run(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const config = vscode.workspace.getConfiguration('tsStructure', document.uri);
    if (document.isClosed || !config.get('inspections.enabled', true) || !isFeatureEnabled('inspections') || isExcluded(document.uri.fsPath)) {
      this.collection.delete(document.uri);
      return [];
    }
    const version = document.version;
    const findings = await this.inspect(document.getText());
    if (document.isClosed || document.version !== version) return [];
    const overrides = config.get<Record<string, Severity | 'off' | 'default'>>('inspections.severity', {});
    const diagnostics = findings
      .filter((f) => overrides[f.inspection] !== 'off')
      .map((f) => {
        const chosen = overrides[f.inspection];
        const severity: Severity = chosen && chosen !== 'default' && chosen !== 'off' ? chosen : f.severity;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(f.start), document.positionAt(f.end)), f.message, severities[severity]);
        diagnostic.source = 'X-Ray';
        diagnostic.code = f.inspection;
        return diagnostic;
      });
    this.collection.set(document.uri, diagnostics);
    return diagnostics;
  }
}
