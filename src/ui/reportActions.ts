import * as ts from 'typescript';
import * as vscode from 'vscode';
import { findNode } from '../analysis/impact';
import { ReportNode } from '../structure/report';
import { parse } from './codeActions';
import { StructureView } from './structureView';

/** Context-menu actions on analysis rows: deleting dead code and removing unneeded `export` keywords. */
export function registerReportActions(context: vscode.ExtensionContext, view: StructureView): void {
  context.subscriptions.push(
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
