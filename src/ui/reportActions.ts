import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { findNode } from '../analysis/impact';
import { ReportNode } from '../structure/report';
import { parse } from './codeActions';
import { StructureView } from './structureView';

const fragmentScheme = 'ts-structure-fragment';
const fragments = new Map<string, string>();

/** Context-menu actions on analysis rows: comparing duplicates, deleting dead code and removing unneeded `export` keywords. */
export function registerReportActions(context: vscode.ExtensionContext, view: StructureView): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(fragmentScheme, { provideTextDocumentContent: (uri) => fragments.get(uri.query) ?? '' }),
    vscode.commands.registerCommand('tsStructure.report.compareDuplicates', async (node: ReportNode) => {
      const copies = node?.action?.copies as { file: string; label: string; text: string }[] | undefined;
      if (!copies || copies.length < 2) {
        return;
      }
      const uris = copies.map((copy, i) => {
        const key = `${Date.now()}-${i}`;
        fragments.set(key, dedent(copy.text));
        return vscode.Uri.from({ scheme: fragmentScheme, path: `/${path.basename(copy.file)}`, query: key });
      });
      await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${copies[0].label} ↔ ${copies[1].label}`);
    }),
    // Run another analysis where the row points, such as the data flow of the parameter a value is passed to.
    vscode.commands.registerCommand('tsStructure.report.follow', followRow),
    vscode.commands.registerCommand('tsStructure.report.showSideEffects', followRow),
    vscode.commands.registerCommand('tsStructure.report.safeDelete', async (node: ReportNode) => {
      if (node?.location) {
        await view.open(node.location);
        await vscode.commands.executeCommand('tsStructure.safeDelete');
      }
    }),
    vscode.commands.registerCommand('tsStructure.report.safeDeleteFile', async (node: ReportNode) => {
      const file = node?.action?.file;
      if (typeof file === 'string') {
        await vscode.commands.executeCommand('tsStructure.safeDeleteFile', vscode.Uri.file(file));
      }
    }),
    vscode.commands.registerCommand('tsStructure.report.unexport', async (node: ReportNode) => {
      if (!node?.location) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(node.location.file);
      const offset = document.offsetAt(new vscode.Position(node.location.line, node.location.character));
      const range = exportKeywordRange(parse(document), offset);
      if (!range) {
        void vscode.window.showWarningMessage(`Could not find the export keyword of ${node.label}; the file may have changed.`);
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.delete(document.uri, new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)));
      await vscode.workspace.applyEdit(edit);
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
