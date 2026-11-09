import { execFileSync } from 'child_process';
import { remedies, showProblem } from './problems';
import * as path from 'path';
import ts = require('typescript');
import * as vscode from 'vscode';
import { findNode } from '../analysis/impact';
import { ReportNode } from '../structure/report';
import { parse } from './codeActions';
import { publicTagEdit } from '../inspect/deadExports';
import { StructureView } from './structureView';
import { TestCase } from '../analysis/types';
import { runTests } from '../runner';
import { registerCommand } from './features';

const fragmentScheme = 'ts-structure-fragment';
const fragments = new Map<string, string>();

/** Context-menu actions on analysis rows: comparing duplicates, deleting dead code and removing unneeded `export` keywords. */
export function registerReportActions(context: vscode.ExtensionContext, view: StructureView): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(fragmentScheme, { provideTextDocumentContent: (uri) => fragments.get(uri.query) ?? '' }),
    registerCommand('tsStructure.report.compareDuplicates', async (node: ReportNode) => {
      let copies = node?.action?.copies as { file: string; label: string; text: string }[] | undefined;
      if (!copies || copies.length < 2) {
        return;
      }
      // With more than two copies, choose which one to set beside the first.
      if (copies.length > 2) {
        const first = copies[0];
        const picked = await vscode.window.showQuickPick(
          copies.slice(1).map((copy) => ({ label: copy.label, copy })),
          { title: `Compare ${first.label} with…`, placeHolder: `${copies.length - 1} other copies` },
        );
        if (!picked) {
          return;
        }
        copies = [first, picked.copy];
      }
      const uris = copies.map((copy, i) => {
        const key = `${Date.now()}-${i}`;
        fragments.set(key, dedent(copy.text));
        return vscode.Uri.from({ scheme: fragmentScheme, path: `/${path.basename(copy.file)}`, query: key });
      });
      await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${copies[0].label} ↔ ${copies[1].label}`);
    }),
    // Run another analysis where the row points, such as the data flow of the parameter a value is passed to.
    registerCommand('tsStructure.report.follow', followRow),
    registerCommand('tsStructure.report.traceValue', followRow),
    registerCommand('tsStructure.report.showSideEffects', followRow),
    registerCommand('tsStructure.report.findUsages', followRow),
    registerCommand('tsStructure.report.showHierarchy', followRow),
    registerCommand('tsStructure.report.overrideImpact', followRow),
    registerCommand('tsStructure.report.runTests', (node: ReportNode) => {
      const tests = node?.action?.tests as TestCase[] | undefined;
      if (tests?.length) {
        void runTests(tests);
      }
    }),
    // Renames the symbol defined at the row, after reviewing its usages.
    registerCommand('tsStructure.report.rename', async (node: ReportNode) => {
      if (node?.location) {
        await view.open(node.location);
        await vscode.commands.executeCommand('editor.action.rename');
      }
    }),
    // Selects the row's code and opens the refactor menu, such as Extract to function for a duplicate.
    registerCommand('tsStructure.report.refactor', async (node: ReportNode) => {
      if (node?.location) {
        await view.open(node.location);
        await vscode.commands.executeCommand('editor.action.refactor');
      }
    }),
    // Opens the row's code with the lightbulb menu, for rows that inspections have fixes for.
    registerCommand('tsStructure.report.quickFix', async (node: ReportNode) => {
      if (node?.location) {
        await view.open(node.location);
        await vscode.commands.executeCommand('editor.action.quickFix');
      }
    }),
    // A file as it was at a Git revision, next to its current version.
    registerCommand('tsStructure.report.compareRevision', async (node: ReportNode) => {
      const { repo, ref, file } = (node?.action ?? {}) as { repo?: string; ref?: string; file?: string };
      if (!repo || !ref || !file) {
        return;
      }
      const relative = path.relative(repo, file).replace(/\\/g, '/');
      let before = '';
      try {
        before = execFileSync('git', ['show', `${ref}:${relative}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch {
        // Not in that revision: compare with an empty file.
      }
      const key = `${Date.now()}-revision`;
      fragments.set(key, before);
      const old = vscode.Uri.from({ scheme: fragmentScheme, path: `/${path.basename(file)}`, query: key });
      await vscode.commands.executeCommand('vscode.diff', old, vscode.Uri.file(file), `${path.basename(file)} (${ref.length === 40 ? ref.slice(0, 8) : ref} ↔ working tree)`);
    }),
    registerCommand('tsStructure.report.safeDelete', async (node: ReportNode) => {
      if (node?.location) {
        await view.open(node.location);
        await vscode.commands.executeCommand('tsStructure.safeDelete');
      }
    }),
    registerCommand('tsStructure.report.safeDeleteFile', async (node: ReportNode) => {
      const file = node?.action?.file;
      if (typeof file === 'string') {
        await vscode.commands.executeCommand('tsStructure.safeDeleteFile', vscode.Uri.file(file));
      }
    }),
    // Every export in the file that is only used locally, as one edit; on the group row, in every file below it.
    registerCommand('tsStructure.report.unexportAll', async (node: ReportNode) => {
      const files = typeof node?.action?.file === 'string' ? [node] : (node?.children ?? []).filter((c) => typeof c.action?.file === 'string' && !view.isDone(c));
      const edit = new vscode.WorkspaceEdit();
      let removed = 0;
      for (const fileRow of files) {
        const document = await vscode.workspace.openTextDocument(fileRow.action!.file as string);
        const sourceFile = parse(document);
        for (const child of fileRow.children ?? []) {
          const range = !view.isDone(child) && child.location && exportKeywordRange(sourceFile, document.offsetAt(new vscode.Position(child.location.line, child.location.character)));
          if (range) {
            edit.delete(document.uri, new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)));
            removed++;
          }
        }
      }
      if (removed > 0 && (await vscode.workspace.applyEdit(edit))) {
        view.markDone(node, 'export removed');
        void vscode.window.setStatusBarMessage(`Removed ${removed} export keyword${removed === 1 ? '' : 's'}${files.length === 1 ? ` from ${files[0].label}` : ` in ${files.length} files`}`, 3000);
      }
    }),
    // Keeps an export that is public API on purpose: tagged @public, the analyzer stops reporting it.
    registerCommand('tsStructure.report.markPublic', async (node: ReportNode) => {
      if (!node?.location) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(node.location.file);
      const sourceFile = parse(document);
      const insert = publicTagEdit(sourceFile, document.offsetAt(new vscode.Position(node.location.line, node.location.character)));
      if (!insert) {
        void showProblem(`${node.label}: declaration not found; the code changed since the analysis.`, [remedies.rerun], 'warning');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(insert.offset), insert.text);
      if (await vscode.workspace.applyEdit(edit)) {
        view.markDone(node, 'marked @public', (n) => n === node);
      }
    }),
    registerCommand('tsStructure.report.unexport', async (node: ReportNode) => {
      if (!node?.location) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(node.location.file);
      const offset = document.offsetAt(new vscode.Position(node.location.line, node.location.character));
      const range = exportKeywordRange(parse(document), offset);
      if (!range) {
        void showProblem(`${node.label}: export not found; the code changed since the analysis.`, [remedies.rerun], 'warning');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.delete(document.uri, new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)));
      if (await vscode.workspace.applyEdit(edit)) {
        view.markDone(node, 'export removed', (n) => n === node);
      }
    }),
  );
}

/** Opens the row's target ({ command, file, offset } in its action) and runs the command there. */
async function followRow(node: ReportNode): Promise<void> {
  const { command, file, offset } = (node?.action ?? {}) as { command?: string; file?: string; offset?: number };
  if (!command || !file || offset === undefined) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(file);
  const position = document.positionAt(offset);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
  await vscode.commands.executeCommand(command);
}

/** The `export ` modifier (with its trailing space) of the declaration at the offset. */
export function exportKeywordRange(sourceFile: ts.SourceFile, offset: number): { start: number; end: number } | undefined {
  for (let node: ts.Node | undefined = findNode(sourceFile, offset); node && !ts.isSourceFile(node); node = node.parent) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const keyword = modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (keyword) {
      const next = modifiers![modifiers!.indexOf(keyword) + 1];
      if (next?.kind === ts.SyntaxKind.DefaultKeyword) {
        return undefined;
      }
      const start = keyword.getStart(sourceFile);
      let end = keyword.end;
      while (/\s/.test(sourceFile.text[end] ?? '')) {
        end++;
      }
      return { start, end };
    }
  }
  return undefined;
}

/** Removes the common leading indentation, so copies at different nesting levels line up in the diff. */
function dedent(text: string): string {
  const lines = text.split('\n');
  // The first line starts at the fragment, without its indentation.
  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
  const indents = lines.slice(1).filter((l) => l.trim()).map(indentOf);
  const common = indents.length ? Math.min(...indents) : 0;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(common, indentOf(l))))].join('\n');
}
