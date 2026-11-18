import * as vscode from 'vscode';
import { inspectCSharp } from '../csharp/inspections';
import { parseCSharp } from '../csharp/parser';
import type { Severity } from '../inspect/inspection';
import { isFeatureEnabled } from './features';
import { isExcluded } from './exclude';

/**
 * Live C# inspections: the bundled parser's syntax checks (src/csharp/inspections.ts) on open C# files, in the
 * Problems panel with the TypeScript ones. They follow the same switches: the Inspections feature, Inspections:
 * Enabled, the delay after typing, and each inspection's severity (or off) in Inspections: Severity.
 */
const severities: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export class CSharpDiagnostics {
  private readonly collection = vscode.languages.createDiagnosticCollection('tsStructure.csharp');
  private readonly timers = new Map<string, NodeJS.Timeout>();

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
    if (document.languageId !== 'csharp' || document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    const wait = delay ?? vscode.workspace.getConfiguration('tsStructure', document.uri).get('inspections.delay', 500);
    this.timers.set(key, setTimeout(() => void this.inspect(document), wait));
  }

  /** Inspects the file now; returns the diagnostics, for tests. */
  async inspect(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const config = vscode.workspace.getConfiguration('tsStructure', document.uri);
    if (document.isClosed || !config.get('inspections.enabled', true) || !isFeatureEnabled('inspections') || isExcluded(document.uri.fsPath)) {
      this.collection.delete(document.uri);
      return [];
    }
    const version = document.version;
    const tree = await parseCSharp(document.getText());
    try {
      if (document.isClosed || document.version !== version) return [];
      const overrides = config.get<Record<string, Severity | 'off' | 'default'>>('inspections.severity', {});
      const diagnostics = inspectCSharp(tree)
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
    } finally {
      tree.delete();
    }
  }
}
