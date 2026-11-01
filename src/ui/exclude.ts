import * as path from 'path';
import * as vscode from 'vscode';
import { pathMatcher } from '../structure/glob';

/** Matchers per workspace folder, rebuilt when the scope settings change. */
const matchers = new Map<string, (relativePath: string) => boolean>();

function scopeMatcher(uri: vscode.Uri, folder: vscode.WorkspaceFolder | undefined): (relativePath: string) => boolean {
  const key = folder?.uri.toString() ?? '';
  let matcher = matchers.get(key);
  if (!matcher) {
    const config = vscode.workspace.getConfiguration('tsStructure', folder?.uri ?? uri);
    const include = config.get<string[]>('include', []).filter((g) => g.trim());
    const included = pathMatcher(include);
    const excluded = pathMatcher(config.get<string[]>('exclude', []));
    matcher = (relative) => (include.length > 0 && !included(relative)) || excluded(relative);
    matchers.set(key, matcher);
  }
  return matcher;
}

/** Whether `tsStructure.include` and `tsStructure.exclude` leave the file out of inspections, searches and project-wide analyses. */
export function isExcluded(fileName: string): boolean {
  const uri = vscode.Uri.file(fileName);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relative = (folder ? path.relative(folder.uri.fsPath, fileName) : fileName).replace(/\\/g, '/');
  return scopeMatcher(uri, folder)(relative);
}

/** The files inside the analysis scope, and a note for the report when some were left out. */
export function scopedFiles<T extends { fileName: string }>(files: readonly T[]): { files: T[]; note?: string } {
  const kept = files.filter((f) => !isExcluded(f.fileName));
  const skipped = files.length - kept.length;
  return {
    files: kept,
    note: skipped ? `${skipped} file${skipped === 1 ? ' is' : 's are'} outside the analysis scope (tsStructure.include and tsStructure.exclude) and ${skipped === 1 ? 'was' : 'were'} skipped.` : undefined,
  };
}

/** Adds the scope note to a report's warnings. */
export function withNote<R extends { warnings: string[] } | undefined>(report: R, note: string | undefined): R {
  if (report && note) {
    report.warnings.push(note);
  }
  return report;
}

export function registerScope(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tsStructure.include') || e.affectsConfiguration('tsStructure.exclude')) {
        matchers.clear();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => matchers.clear()),
  );
}
