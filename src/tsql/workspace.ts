import * as path from 'path';
import * as vscode from 'vscode';
import { normalizePath } from '../analysis/paths';
import { CallDirection } from '../navigate/callGraph';
import { Report } from '../structure/report';
import { SqlFile, tsqlCallGraph, tsqlUsages } from './navigate';

/** The workspace's .sql files, with what is typed in open editors rather than what is saved. */
async function sqlFiles(): Promise<SqlFile[]> {
  const uris = await vscode.workspace.findFiles('**/*.sql', '{**/node_modules/**,**/bin/**,**/obj/**,**/.git/**}', 3000);
  const open = new Map(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').map((d) => [normalizePath(d.uri.fsPath), d]));
  const files: SqlFile[] = [];
  for (const uri of uris) {
    const file = normalizePath(uri.fsPath);
    const document = open.get(file);
    const text = document ? document.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    files.push({ file, text });
  }
  return files;
}

/** The files, with the editor's own document among them even when it is unsaved or outside the workspace. */
async function withDocument(document: vscode.TextDocument): Promise<{ files: SqlFile[]; file: string }> {
  const file = normalizePath(document.uri.fsPath);
  const files = (await sqlFiles()).filter((f) => f.file !== file);
  files.push({ file, text: document.getText() });
  return { files, file };
}

const folderOf = (file: string) => {
  const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath;
  return root ? path.relative(root, path.dirname(file)).split(path.sep).join('/') || '.' : '';
};

export async function tsqlUsagesReport(document: vscode.TextDocument, position: vscode.Position): Promise<Report> {
  const { files, file } = await withDocument(document);
  return tsqlUsages(files, file, document.offsetAt(position), folderOf);
}

export async function tsqlCallGraphReport(document: vscode.TextDocument, position: vscode.Position, options: { depth: number; direction: CallDirection }): Promise<Report> {
  const { files, file } = await withDocument(document);
  return tsqlCallGraph(files, file, document.offsetAt(position), options);
}
