import * as vscode from 'vscode';
import { normalizePath } from '../analysis/paths';
import { Report } from '../structure/report';
import { CSharpSource } from './charts';

/**
 * The workspace's C# files for the parser-based analyses: what is typed in open editors rather than what is saved,
 * and the editor's own file even when it is outside the workspace or unsaved.
 */
export async function csharpSources(document: vscode.TextDocument): Promise<CSharpSource[]> {
  const uris = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**,**/node_modules/**,**/.git/**}', 4000);
  const open = new Map(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').map((d) => [normalizePath(d.uri.fsPath), d]));
  const here = normalizePath(document.uri.fsPath);
  const files: CSharpSource[] = [{ file: here, text: document.getText() }];
  for (const uri of uris) {
    const file = normalizePath(uri.fsPath);
    if (file === here) continue;
    const text = open.get(file)?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    files.push({ file, text });
  }
  return files;
}

/** An analysis of the parser-based kind, run on the editor's file and cursor with the workspace's C# files. */
export const onWorkspace =
  (analysis: (sources: CSharpSource[], file: string, offset: number) => Promise<Report>) =>
  async (document: vscode.TextDocument, position: vscode.Position): Promise<Report> =>
    analysis(await csharpSources(document), normalizePath(document.uri.fsPath), document.offsetAt(position));

/** An analysis of the editor's file alone (one method's flow), at its cursor. */
export const onFile =
  (analysis: (code: string, file: string, offset: number) => Promise<Report>) =>
  async (document: vscode.TextDocument, position: vscode.Position): Promise<Report> =>
    analysis(document.getText(), normalizePath(document.uri.fsPath), document.offsetAt(position));
