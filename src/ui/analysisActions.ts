import * as vscode from 'vscode';
import { FileSymbol, SymbolKind, fileSymbols, symbolAt } from '../structure/symbols';
import { parse, refactorKind } from './codeActions';
import { isFeatureEnabled } from './features';
import { commandIcons } from '../structure/icons';

/** An analysis that starts from a named thing at the cursor, and the things it can start from. */
interface CursorAnalysis {
  command: string;
  feature: string;
  kinds: readonly SymbolKind[];
  accepts?: (symbol: FileSymbol) => boolean;
  /** Its lightbulb entry; analyses without one are only offered by the symbol picker. */
  lightbulb?: (symbol: FileSymbol) => string;
}

const notMethod = (s: FileSymbol) => s.kind !== 'member' || !s.callable;
const notProperty = (s: FileSymbol) => s.kind !== 'member' || !!s.callable;
const qualified = (s: FileSymbol) => (s.container && s.kind === 'member' ? `${s.container.replace(/\(\)$/, '')}.${s.name}` : s.name);

const analyses: readonly CursorAnalysis[] = [
  { command: 'tsStructure.dataFlow', feature: 'dataFlow', kinds: ['variable', 'parameter', 'member'], accepts: notMethod, lightbulb: (s) => `Show data flow of '${s.name}'` },
  { command: 'tsStructure.mutationTrackingVariable', feature: 'dataFlow', kinds: ['variable', 'member'], accepts: notMethod, lightbulb: (s) => `Track every change to '${s.name}'` },
  { command: 'tsStructure.raceConditions', feature: 'dataFlow', kinds: ['variable', 'member'], accepts: notMethod, lightbulb: (s) => `Check '${s.name}' for race conditions` },
  { command: 'tsStructure.explainValue', feature: 'dataFlow', kinds: ['variable', 'parameter'], lightbulb: (s) => `Explain the possible values of '${s.name}' here` },
  { command: 'tsStructure.controlFlow', feature: 'dataFlow', kinds: ['function', 'member'], accepts: notProperty, lightbulb: (s) => `Show the control flow of ${qualified(s)}()` },
  { command: 'tsStructure.nullability', feature: 'nullability', kinds: ['variable', 'parameter', 'member', 'function'] },
  { command: 'tsStructure.argumentFlow', feature: 'argumentFlow', kinds: ['parameter'], lightbulb: (s) => `Trace values of parameter '${s.name}'` },
  { command: 'tsStructure.sideEffects', feature: 'sideEffects', kinds: ['function', 'member'], accepts: notProperty, lightbulb: (s) => `Show side effects of ${qualified(s)}()` },
  { command: 'tsStructure.exceptionFlow', feature: 'exceptionFlow', kinds: ['function', 'member'], accepts: notProperty, lightbulb: (s) => `Show errors thrown by ${qualified(s)}()` },
  { command: 'tsStructure.promiseRejections', feature: 'promiseRejections', kinds: ['function', 'member'], accepts: (s) => notProperty(s), lightbulb: (s) => `Trace rejections of ${qualified(s)}()` },
  { command: 'tsStructure.typeHierarchy', feature: 'hierarchy', kinds: ['class', 'interface'], lightbulb: (s) => `Show inheritance hierarchy of ${s.name}` },
  { command: 'tsStructure.overrideImpact', feature: 'hierarchy', kinds: ['member'], lightbulb: (s) => `Show impact of changing ${qualified(s)}` },
  { command: 'tsStructure.reexportChain', feature: 'reexports', kinds: ['import'], lightbulb: (s) => `Follow the re-exports of '${s.name}'` },
  { command: 'tsStructure.semanticUsages', feature: 'usages', kinds: ['variable', 'function', 'class', 'interface', 'member', 'parameter', 'import'] },
  { command: 'tsStructure.semanticUsagesInFile', feature: 'usages', kinds: ['variable', 'function', 'class', 'interface', 'member', 'import'], lightbulb: (s) => `Find usages of '${s.name}' in this file` },
];

const analyzeKind = refactorKind.append('analyze');

/** The analyses that fit the declaration at the cursor, for Analyze or Refactor This's Suggested section. */
export function suggestedAt(document: vscode.TextDocument, offset: number): string[] {
  const symbol = symbolAt(parse(document), offset);
  return symbol ? analyses.filter((a) => a.lightbulb && isFeatureEnabled(a.feature) && fits(a, symbol) && (a.command !== 'tsStructure.promiseRejections' || symbol.async)).map((a) => a.command) : [];
}

/** Lightbulb entries that run an analysis on the declaration under the cursor, such as "Show data flow of 'total'". */
export class AnalysisActionProvider implements vscode.CodeActionProvider {
  static readonly kinds = [analyzeKind];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    if ((context.only && !analyzeKind.intersects(context.only)) || !range.isEmpty || !vscode.workspace.getConfiguration('tsStructure', document.uri).get('lightbulbAnalyses', true)) {
      return [];
    }
    const symbol = symbolAt(parse(document), document.offsetAt(range.start));
    if (!symbol) {
      return [];
    }
    return analyses
      .filter((a) => a.lightbulb && isFeatureEnabled(a.feature) && fits(a, symbol) && (a.command !== 'tsStructure.promiseRejections' || symbol.async))
      .map((a) => {
        const action = new vscode.CodeAction(a.lightbulb!(symbol), analyzeKind);
        action.command = { command: a.command, title: action.title };
        return action;
      });
  }
}

function fits(analysis: CursorAnalysis, symbol: FileSymbol): boolean {
  return analysis.kinds.includes(symbol.kind) && (!analysis.accepts || analysis.accepts(symbol));
}

const icons: Record<SymbolKind, string> = {
  variable: 'symbol-variable',
  function: 'symbol-function',
  class: 'symbol-class',
  interface: 'symbol-interface',
  member: 'symbol-field',
  parameter: 'symbol-parameter',
  import: 'symbol-namespace',
};

/**
 * After an analysis found nothing to start from at the cursor, offers the file's declarations it can
 * start from, and runs it on the one picked.
 */
export async function offerSymbols(command: string, message: string, editor: vscode.TextEditor): Promise<void> {
  const analysis = analyses.find((a) => a.command === command);
  const symbols = analysis ? fileSymbols(parse(editor.document)).filter((s) => fits(analysis, s)) : [];
  if (!analysis || symbols.length === 0) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  // On a function, a class or an import, offer the analysis that fits it, such as Side Effects for Data Flow on a function.
  const here = symbolAt(parse(editor.document), editor.document.offsetAt(editor.selection.active));
  const fitting = here && analyses.find((a) => a.command !== command && a.lightbulb && isFeatureEnabled(a.feature) && fits(a, here) && (a.command !== 'tsStructure.promiseRejections' || here.async));
  const alternative = fitting ? `${titles[fitting.command] ?? 'Analyze'} of ${here!.name}` : undefined;
  const choice = await vscode.window.showErrorMessage(message, ...(alternative ? [alternative] : []), 'Choose a Symbol…');
  if (!choice) {
    return;
  }
  if (choice === alternative) {
    await vscode.commands.executeCommand(fitting!.command);
    return;
  }
  const picked = await pickSymbol(editor, symbols);
  if (picked) {
    await runOn(editor, picked, command);
  }
}

/** A list of declarations with the one nearest the cursor selected, so Enter takes the obvious one. */
async function pickSymbol(editor: vscode.TextEditor, symbols: readonly FileSymbol[], title = 'Start from…'): Promise<FileSymbol | undefined> {
  type Item = vscode.QuickPickItem & { symbol: FileSymbol };
  const line = editor.selection.active.line;
  const items: Item[] = symbols.map((s) => ({ label: `$(${icons[s.kind]}) ${s.kind === 'member' && s.callable ? `${s.name}()` : s.name}`, description: [s.container, `line ${s.line + 1}`].filter(Boolean).join(' · '), symbol: s }));
  // Functions, variables, classes and so on under their own headings when the file has several kinds.
  const kindTitles: Record<SymbolKind, string> = { function: 'Functions', variable: 'Variables', class: 'Classes', interface: 'Interfaces', member: 'Members', parameter: 'Parameters', import: 'Imports' };
  const kinds = [...new Set(items.map((i) => i.symbol.kind))];
  const sections: (Item | (vscode.QuickPickItem & { symbol?: undefined }))[] = kinds.length > 1 ? kinds.flatMap((k) => [{ label: kindTitles[k], kind: vscode.QuickPickItemKind.Separator }, ...items.filter((i) => i.symbol.kind === k)]) : items;
  const nearest = [...items].sort((a, b) => Math.abs(a.symbol.line - line) - Math.abs(b.symbol.line - line))[0];
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = title;
  picker.placeholder = `Declarations in ${vscode.workspace.asRelativePath(editor.document.uri)}`;
  picker.matchOnDescription = true;
  picker.items = sections as Item[];
  picker.activeItems = nearest ? [nearest] : [];
  const picked = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0] ?? picker.activeItems[0]));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  return picked?.symbol;
}

async function runOn(editor: vscode.TextEditor, symbol: FileSymbol, command: string): Promise<unknown> {
  const position = editor.document.positionAt(symbol.offset);
  const shown = await vscode.window.showTextDocument(editor.document, { selection: new vscode.Range(position, position) });
  shown.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return vscode.commands.executeCommand(command);
}

const titles: Record<string, string> = {
  'tsStructure.dataFlow': 'Data Flow',
  'tsStructure.nullability': 'Nullability',
  'tsStructure.mutationTrackingVariable': 'Mutation Tracking',
  'tsStructure.raceConditions': 'Race Conditions',
  'tsStructure.controlFlow': 'Control Flow Graph',
  'tsStructure.explainValue': 'Explain Value Path',
  'tsStructure.argumentFlow': 'Argument Propagation',
  'tsStructure.sideEffects': 'Side Effects',
  'tsStructure.exceptionFlow': 'Exception Flow',
  'tsStructure.promiseRejections': 'Promise Rejections',
  'tsStructure.typeHierarchy': 'Inheritance Hierarchy',
  'tsStructure.overrideImpact': 'Override Impact',
  'tsStructure.reexportChain': 'Re-export Chain',
  'tsStructure.semanticUsages': 'Find Usages',
  'tsStructure.semanticUsagesInFile': 'Find Usages in This File',
};

/** Analyze a Symbol…: pick a declaration of the file, then one of the analyses that fit it, without moving the cursor first. */
export async function analyzeSymbol(editor: vscode.TextEditor): Promise<void> {
  const symbol = await pickSymbol(editor, fileSymbols(parse(editor.document)), 'Analyze a Symbol');
  if (!symbol) {
    return;
  }
  const fitting = analyses.filter((a) => isFeatureEnabled(a.feature) && fits(a, symbol) && (a.command !== 'tsStructure.promiseRejections' || symbol.async));
  const picked = await vscode.window.showQuickPick(
    fitting.map((a) => ({ label: `$(${commandIcons[a.command] ?? 'symbol-misc'}) ${titles[a.command] ?? a.command}`, command: a.command })),
    { title: `Analyze ${symbol.name}`, placeHolder: 'Choose an analysis' },
  );
  if (picked) {
    await runOn(editor, symbol, picked.command);
  }
}
