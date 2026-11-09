import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { pathKey } from '../analysis/paths';
import { output } from './applyRefactor';
import { languageSelector } from './refactorCommands';

/**
 * Builds the project of the file being edited in the background, a moment after the editor goes quiet, so the
 * first analysis finds it ready instead of parsing every file then. Each project is warmed once; inspections,
 * test impact and every analysis share what it builds (ProjectService.load and analysisProject).
 */
export function registerWarmUp(context: vscode.ExtensionContext, projects: ProjectService): void {
  const warmed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const schedule = (editor: vscode.TextEditor | undefined) => {
    clearTimeout(timer);
    if (!editor || editor.document.uri.scheme !== 'file' || vscode.languages.match(languageSelector, editor.document) === 0) return;
    if (!vscode.workspace.getConfiguration('tsStructure', editor.document.uri).get('warmUp', true)) return;
    const file = editor.document.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
    timer = setTimeout(() => {
      try {
        const key = projects.resolve(file, folder).configPath ?? `inferred:${pathKey(folder ?? file)}`;
        if (warmed.has(key)) return;
        warmed.add(key);
        const started = Date.now();
        const project = projects.load(file, folder);
        output.appendLine(`Prepared ${project.program.getSourceFiles().length} files for analysis in ${Date.now() - started} ms (${key}).`);
      } catch {
        // A file outside any project, or one that can't be read: the first analysis reports it.
      }
    }, 1500);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(schedule), { dispose: () => clearTimeout(timer) });
  schedule(vscode.window.activeTextEditor);
}
