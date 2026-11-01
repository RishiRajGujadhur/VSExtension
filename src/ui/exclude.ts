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
