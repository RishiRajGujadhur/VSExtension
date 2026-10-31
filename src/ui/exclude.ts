import * as path from 'path';
import * as vscode from 'vscode';
import { globToRegExp } from '../structure/glob';

let cached: { key: string; patterns: RegExp[] } | undefined;

/** Whether `tsStructure.exclude` leaves the file out of inspections, searches and project-wide analyses. */
export function isExcluded(fileName: string): boolean {
  const globs = vscode.workspace.getConfiguration('tsStructure').get<string[]>('exclude', []);
  const key = globs.join('\n');
  if (cached?.key !== key) {
    cached = { key, patterns: globs.map((g) => globToRegExp(g)) };
  }
  if (cached.patterns.length === 0) {
    return false;
  }
  const uri = vscode.Uri.file(fileName);
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const relative = (folder ? path.relative(folder, fileName) : fileName).replace(/\\/g, '/');
  return cached.patterns.some((p) => p.test(relative));
}
