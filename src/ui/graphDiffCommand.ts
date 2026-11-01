import { execFileSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { diffGraphs, filesAtRef, gitRoot, graphDiffReport, graphOf, workingTreeFiles } from '../navigate/graphDiff';
import { runAnalysis } from './analysisCommands';
import { reportError } from './applyRefactor';
import { StructureView } from './structureView';

function gitLines(cwd: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Revisions worth comparing against: HEAD, the branch point, recent commits and branches. */
async function pickRef(root: string): Promise<{ ref: string; label: string } | undefined> {
  type Item = vscode.QuickPickItem & { ref?: string; custom?: boolean };
  const items: Item[] = [{ label: '$(git-commit) HEAD', description: 'Uncommitted changes', ref: 'HEAD' }];
  for (const base of ['origin/main', 'main', 'origin/master', 'master']) {
    const mergeBase = gitLines(root, ['merge-base', 'HEAD', base])[0];
    if (mergeBase) {
      items.push({ label: `$(git-merge) Branch point with ${base}`, description: `Everything on this branch · ${mergeBase.slice(0, 8)}`, ref: mergeBase });
      break;
    }
  }
  items.push({ label: '$(history) HEAD~1', description: 'Including the last commit', ref: 'HEAD~1' });
  const commits = gitLines(root, ['log', '-15', '--format=%h%x09%s']);
  if (commits.length) {
    items.push({ label: 'Recent commits', kind: vscode.QuickPickItemKind.Separator });
    items.push(...commits.map((line) => ({ label: `$(git-commit) ${line.split('\t')[0]}`, description: line.split('\t')[1], ref: line.split('\t')[0] })));
  }
  const branches = gitLines(root, ['for-each-ref', '--format=%(refname:short)', '--count=20', 'refs/heads', 'refs/remotes']);
  if (branches.length) {
    items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator });
    items.push(...branches.map((b) => ({ label: `$(git-branch) ${b}`, ref: b })));
  }
  items.push({ label: '$(edit) Enter a revision…', custom: true });
  const picked = await vscode.window.showQuickPick(items, { title: 'Compare the dependency graph with…', matchOnDescription: true });
  if (picked?.custom) {
    const ref = await vscode.window.showInputBox({ title: 'Git revision', placeHolder: 'v1.2.0, origin/main, a1b2c3d…' });
    return ref ? { ref, label: ref } : undefined;
  }
  return picked?.ref ? { ref: picked.ref, label: picked.label.replace(/^\$\([^)]*\)\s*/, '') } : undefined;
}

export function registerGraphDiff(context: vscode.ExtensionContext, projects: ProjectService, view: StructureView): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tsStructure.dependencyGraphDiff', async (refArg?: string) => {
      const editor = vscode.window.activeTextEditor;
      const anchor = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!anchor) {
        void vscode.window.showErrorMessage('Open a file or folder in a Git repository first.');
        return;
      }
      try {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(anchor))?.uri.fsPath;
        const repo = gitRoot(path.extname(anchor) ? path.dirname(anchor) : anchor);
        const choice = refArg ? { ref: refArg, label: refArg } : await pickRef(repo);
        if (!choice) {
          return;
        }
        return runAnalysis(view, `Comparing dependencies with ${choice.label}`, () => {
          // The graph covers the compiler project's directory, or the workspace folder without one.
          const { configPath, parsed } = path.extname(anchor) ? projects.resolve(anchor, folder) : { configPath: undefined, parsed: { options: {} } };
          const directory = configPath ? path.dirname(configPath) : (folder ?? repo);
          // Unsaved editor text only: a saved document can lag behind a change made on disk, such as a checkout.
          const overlay = (fileName: string) => vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.fsPath.toLowerCase() === path.resolve(fileName).toLowerCase())?.getText();
          const afterFiles = workingTreeFiles(directory, overlay);
          const diff = diffGraphs(graphOf(filesAtRef(repo, choice.ref, directory), parsed.options), graphOf(afterFiles, parsed.options), directory);
          return graphDiffReport(diff, afterFiles, directory, choice.label);
        });
      } catch (error) {
        reportError(error, 'Dependency Graph Diff');
      }
    }),
  );
}
