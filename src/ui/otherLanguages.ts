import * as vscode from 'vscode';
import { showProblem } from './problems';
import { nameOf } from '../structure/names';
import { commandIcons } from '../structure/icons';
import { featureOf } from '../structure/features';
import { isFeatureEnabled } from './features';
import { awaitPick } from './quickPick';

/**
 * C# and T-SQL: the languages Code X-Ray reads without TypeScript, and which of its commands work in them. Everything
 * else is TypeScript and JavaScript only; asked for in a C# or T-SQL file, it says so and offers what does work,
 * rather than looking for a TypeScript file.
 */

export interface OtherLanguage {
  /** As people say it: C#, T-SQL. */
  name: string;
  /** The commands that work in its files, in the order they are offered. */
  commands: string[];
  /** Commands that need the language's own extension (a language server), marked so in the list. */
  needsServer?: string[];
}

export const otherLanguages: Record<string, OtherLanguage> = {
  csharp: {
    name: 'C#',
    commands: ['tsStructure.controlFlow', 'tsStructure.dependenceGraph', 'tsStructure.semanticUsages', 'tsStructure.semanticUsagesInFile', 'tsStructure.callGraph', 'tsStructure.typeHierarchy'],
    needsServer: ['tsStructure.callGraph', 'tsStructure.typeHierarchy'],
  },
  sql: {
    name: 'T-SQL',
    commands: ['tsStructure.controlFlow', 'tsStructure.dependenceGraph', 'tsStructure.semanticUsages', 'tsStructure.semanticUsagesInFile', 'tsStructure.callGraph'],
  },
};

/** The C# or T-SQL language of the active editor, if that is what it holds. */
export function otherLanguageInFront(): (OtherLanguage & { editor: vscode.TextEditor }) | undefined {
  const editor = vscode.window.activeTextEditor;
  const language = editor && otherLanguages[editor.document.languageId];
  return language && editor ? { ...language, editor } : undefined;
}

const usable = (language: OtherLanguage) =>
  language.commands.filter((command) => {
    const feature = featureOf(command);
    return !feature || isFeatureEnabled(feature.id);
  });

/** "Data flow works in TypeScript and JavaScript files. In C# files: Flowchart, Find usages…", with buttons for them. */
export function explainUnsupported(language: OtherLanguage, command: string | undefined): void {
  const what = command ? nameOf(command) : 'This';
  const offer = usable(language);
  const names = offer.slice(0, 4).map((c) => nameOf(c)).join(', ');
  void showProblem(
    `${what} works in TypeScript and JavaScript files. In ${language.name} files: ${names}${offer.length > 4 ? ' and more' : ''}.`,
    offer.slice(0, 2).map((c) => ({ title: nameOf(c), run: () => vscode.commands.executeCommand(c) })),
    'info',
  );
}

/** Analyze or refactor this…, in a C# or T-SQL file: the commands that work there. */
export async function otherLanguageActions(language: OtherLanguage): Promise<void> {
  type Item = vscode.QuickPickItem & { command?: string };
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `Analyze this ${language.name} code`;
  picker.placeholder = `What Code X-Ray can do here (inspections show in the Problems panel as you type)`;
  picker.items = usable(language).map((command) => ({
    label: `$(${commandIcons[command] ?? 'symbol-misc'}) ${nameOf(command)}`,
    description: language.needsServer?.includes(command) ? `needs the ${language.name} extension` : undefined,
    command,
  }));
  const picked = await awaitPick(picker, (p) => p.selectedItems[0] ?? p.activeItems[0]);
  if (picked?.command) await vscode.commands.executeCommand(picked.command);
}
