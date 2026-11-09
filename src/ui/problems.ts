import * as vscode from 'vscode';
import { AnalysisError, AnalysisErrorReason } from '../analysis/types';
import { parse } from './codeActions';

/**
 * Error messages that lead somewhere: each problem comes with the buttons that fix it, such as choosing a function
 * when the cursor wasn't in one, going to the syntax error that stopped the analysis, or opening the log.
 */
export interface Remedy {
  title: string;
  run: () => unknown;
}

/** The fixes offered by recent messages, by id, for the links in those messages. */
const pending = new Map<string, Remedy>();
let nextId = 0;

/** Runs a fix from a link in a message (the tsStructure.runRemedy command). */
export async function runRemedy(id: unknown): Promise<void> {
  const remedy = typeof id === 'string' ? pending.get(id) : undefined;
  if (remedy) await remedy.run();
}

/**
 * Shows a message with its fixes as links right after the text, on the left where they are read, rather than as
 * buttons at the far right of the notification. At most three are offered, the most useful first.
 */
export async function showProblem(message: string, remedies: readonly Remedy[], severity: 'error' | 'warning' | 'info' = 'error'): Promise<void> {
  const shown = remedies.slice(0, 3);
  const links = shown.map((r) => {
    const id = String(nextId++);
    pending.set(id, r);
    return `[${r.title.replace(/[[\]]/g, '')}](command:tsStructure.runRemedy?${encodeURIComponent(JSON.stringify([id]))})`;
  });
  // Old fixes are forgotten once enough newer ones were offered.
  for (const key of [...pending.keys()].slice(0, Math.max(0, pending.size - 30))) pending.delete(key);
  const show = severity === 'error' ? vscode.window.showErrorMessage : severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  await show(links.length ? `${message} ${links.join(' · ')}` : message);
}

const command = (title: string, id: string, ...args: unknown[]): Remedy => ({ title, run: () => vscode.commands.executeCommand(id, ...args) });

/** Buttons shared by many messages. */
export const remedies = {
  openFile: command('Open a File…', 'workbench.action.quickOpen'),
  findInProject: command('Search the Project…', 'workbench.action.showAllSymbols'),
  howDoI: command('How Do I…?', 'tsStructure.howDoI'),
  showLog: command('Show Log', 'tsStructure.showLog'),
  analyzeSymbol: command('Choose a Symbol…', 'tsStructure.analyzeSymbol'),
  rerun: command('Run Again', 'tsStructure.rerunAnalysis'),
  scope: command('Edit Analysis Scope…', 'tsStructure.editAnalysisScope'),
  sourceControl: command('Open Source Control', 'workbench.view.scm'),
  initGit: command('Initialize Repository', 'git.init'),
  wholeProject: (id: string): Remedy => command('Use the Whole Project', id),
  runAgain: (id: string): Remedy => command('Run Again', id),
  goToDefinition: command('Go to Definition', 'editor.action.revealDefinition'),
  findUsages: command('Find Usages', 'tsStructure.semanticUsages'),
};

/** The syntax errors of a file as the parser sees them: broken code can hide the declaration an analysis needs. */
export function syntaxErrors(document: vscode.TextDocument): vscode.Range[] {
  const sourceFile = parse(document) as unknown as { parseDiagnostics?: { start?: number; length?: number }[] };
  return (sourceFile.parseDiagnostics ?? [])
    .filter((d) => d.start !== undefined)
    .map((d) => new vscode.Range(document.positionAt(d.start!), document.positionAt(d.start! + (d.length ?? 0))));
}

/** A button that moves the cursor to the syntax error nearest it, or none when the file parses. */
export function syntaxErrorRemedy(editor: vscode.TextEditor): { remedy: Remedy; count: number } | undefined {
  const errors = syntaxErrors(editor.document);
  if (!errors.length) return undefined;
  const line = editor.selection.active.line;
  const nearest = [...errors].sort((a, b) => Math.abs(a.start.line - line) - Math.abs(b.start.line - line))[0];
  return {
    count: errors.length,
    remedy: {
      title: 'Go to Syntax Error',
      run: async () => {
        const shown = await vscode.window.showTextDocument(editor.document, { selection: nearest });
        shown.revealRange(nearest, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      },
    },
  };
}

/** The message with a note about syntax errors added, when the file has some. */
export function withSyntaxNote(message: string, count: number | undefined): string {
  if (!count) return message;
  return `${message} The file has ${count === 1 ? 'a syntax error' : `${count} syntax errors`}, which can hide the code to analyze.`;
}

/** The project's tsconfig.json or jsconfig.json, if the workspace has one. */
async function openConfig(): Promise<void> {
  const [config] = await vscode.workspace.findFiles('**/{tsconfig,jsconfig}.json', '**/node_modules/**', 1);
  if (config) await vscode.window.showTextDocument(config);
  else void vscode.window.showInformationMessage('This workspace has no tsconfig.json or jsconfig.json; files are analyzed with default settings.');
}

/** Buttons for an expected analysis error, by its reason, when nothing more is known about where it happened. */
export function remediesFor(error: AnalysisError): Remedy[] {
  switch (error.reason) {
    case 'library':
      return [remedies.goToDefinition, remedies.findUsages, remedies.analyzeSymbol];
    case 'project':
      return [{ title: 'Open tsconfig.json', run: openConfig }, remedies.scope, remedies.openFile];
    case 'git':
      return [remedies.sourceControl, remedies.showLog];
    case 'selection':
      return [remedies.howDoI];
    default:
      return [remedies.analyzeSymbol, remedies.howDoI];
  }
}

/** An unexpected failure: the log has the details; the error can be copied or reported. */
export function unexpectedRemedies(label: string, error: unknown): Remedy[] {
  const text = error instanceof Error ? `${label} failed: ${error.message}\n\n${error.stack ?? ''}` : `${label} failed: ${String(error)}`;
  return [
    remedies.showLog,
    {
      title: 'Copy Details',
      run: async () => {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage('Copied the error details', 3000);
      },
    },
    {
      title: 'Report Issue',
      run: () => vscode.env.openExternal(vscode.Uri.parse(`https://github.com/RishiRajGujadhur/VSExtension/issues/new?title=${encodeURIComponent(`${label} failed`)}`)),
    },
  ];
}

export type { AnalysisErrorReason };
