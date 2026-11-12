import * as vscode from 'vscode';
import { FileSymbol, SymbolKind, fileSymbols, symbolAt } from '../structure/symbols';
import { parse, refactorKind } from './codeActions';
import { isFeatureEnabled } from './features';
import { commandIcons } from '../structure/icons';
import { AnalysisError } from '../analysis/types';
import { Remedy, remedies, showProblem, syntaxErrorRemedy, withSyntaxNote } from './problems';
import { nameOf } from '../structure/names';
import { all as lastSubjects } from './lastSubjects';

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
  { command: 'tsStructure.valueTimeline', feature: 'dataFlow', kinds: ['variable', 'parameter'], lightbulb: (s) => `Show how '${s.name}' changes, pass by pass` },
  { command: 'tsStructure.asyncTimeline', feature: 'promiseRejections', kinds: ['function', 'member'], accepts: (s) => notProperty(s) && !!s.async, lightbulb: (s) => `Show what ${qualified(s)}() waits for` },
  { command: 'tsStructure.dataFlowDiagram', feature: 'dataFlow', kinds: ['variable', 'parameter', 'member'], accepts: notMethod },
  { command: 'tsStructure.sliceBackward', feature: 'dataFlow', kinds: ['variable', 'parameter'] },
  { command: 'tsStructure.sliceForward', feature: 'dataFlow', kinds: ['variable', 'parameter'] },
  { command: 'tsStructure.controlFlow', feature: 'dataFlow', kinds: ['function', 'member'], accepts: notProperty, lightbulb: (s) => `Show the control flow of ${qualified(s)}()` },
  { command: 'tsStructure.dependenceGraph', feature: 'dataFlow', kinds: ['function', 'member'], accepts: notProperty },
  { command: 'tsStructure.callGraph', feature: 'usages', kinds: ['function', 'member'], accepts: notProperty, lightbulb: (s) => `Show the call graph of ${qualified(s)}()` },
  // Components (capitalized) and hooks (use…) only.
  { command: 'tsStructure.reactState', feature: 'dataFlow', kinds: ['function', 'variable'], accepts: (s) => /^[A-Z]|^use[A-Z]/.test(s.name), lightbulb: (s) => `Show the React state graph of ${s.name}` },
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

/** Every analysis (lightbulb or not) that fits the declaration at the offset, such as the graphs for the cursor. */
export function fittingAt(document: vscode.TextDocument, offset: number): string[] {
  const symbol = symbolAt(parse(document), offset);
  return symbol ? analyses.filter((a) => isFeatureEnabled(a.feature) && fits(a, symbol) && (a.command !== 'tsStructure.promiseRejections' || symbol.async)).map((a) => a.command) : [];
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

/** The symbol an analysis was just run on by itself, so it is not tried twice in a row. */
let lastAutoRun: string | undefined;

/**
 * After an analysis found nothing to start from at the cursor, offers the file's declarations it can
 * start from, and runs it on the one picked. When only one fits (on the cursor's line, or in the file), it runs
 * on that one straight away.
 */
export async function offerSymbols(command: string, error: string | AnalysisError, editor: vscode.TextEditor): Promise<void> {
  const message = typeof error === 'string' ? error : error.message;
  const reason = typeof error === 'string' ? 'cursor' : error.reason;
  const analysis = analyses.find((a) => a.command === command);
  const symbols = analysis ? fileSymbols(parse(editor.document)).filter((s) => fits(analysis, s)) : [];
  // One click less: when only one thing fits on the cursor's line, or in the whole file, it runs on that one.
  if (analysis && reason === 'cursor') {
    const line = editor.selection.active.line;
    const onLine = symbols.filter((s) => s.line === line);
    const only = onLine.length === 1 ? onLine[0] : symbols.length === 1 ? symbols[0] : undefined;
    // Once per symbol: if it fails there too, the message below explains, instead of trying again and again.
    const key = only && `${command}:${editor.document.uri.toString()}:${only.offset}`;
    if (only && key !== lastAutoRun) {
      lastAutoRun = key;
      setTimeout(() => { if (lastAutoRun === key) lastAutoRun = undefined; }, 3000);
      void vscode.window.setStatusBarMessage(`${nameOf(command)}: ran on ${only.name}, ${onLine.length === 1 ? 'on the cursor’s line' : `the only ${kindWord(only)} in this file`}`, 5000);
      await runOn(editor, only, command);
      return;
    }
  }
  const syntax = syntaxErrorRemedy(editor);
  const buttons: Remedy[] = [];
  // Broken code first: a syntax error is the likeliest reason nothing was found at the cursor.
  if (syntax && reason === 'cursor') buttons.push(syntax.remedy);
  if (reason === 'library') buttons.push(remedies.goToDefinition, remedies.findUsages);
  // On a function, a class or an import, offer the analysis that fits it, such as Side Effects for Data Flow on a function.
  const here = symbolAt(parse(editor.document), editor.document.offsetAt(editor.selection.active));
  const fitting = here && analyses.find((a) => a.command !== command && a.lightbulb && isFeatureEnabled(a.feature) && fits(a, here) && (a.command !== 'tsStructure.promiseRejections' || here.async));
  if (fitting) buttons.push({ title: `${nameOf(fitting.command, 'Analyze')} of ${here!.name}`, run: () => vscode.commands.executeCommand(fitting.command) });
  if (analysis && symbols.length) {
    buttons.push({
      title: chooseTitle(analysis),
      run: async () => {
        const picked = await pickSymbol(editor, symbols, `${nameOf(command, 'Analyze')}: ${chooseTitle(analysis).replace(/…$/, '')}`);
        if (picked) await runOn(editor, picked, command);
      },
    });
  } else {
    // Nothing in this file fits: look elsewhere in the project, or ask which analysis answers the question.
    buttons.push(remedies.findInProject, remedies.howDoI);
  }
  // The choose button matters most when there is no syntax error to fix.
  const ordered = syntax && reason === 'cursor' ? buttons : [...buttons.filter((b) => b.title.startsWith('Choose')), ...buttons.filter((b) => !b.title.startsWith('Choose'))];
  await showProblem(withSyntaxNote(message, reason === 'cursor' ? syntax?.count : undefined), ordered);
}

/**
 * Open a file…: the project's TypeScript and JavaScript files (open ones first); then, for an analysis that starts
 * from a variable, a function or a class, that file's declarations it can start from; and the analysis runs on the
 * one picked. Other commands just run on the file.
 */
export async function openFileThenRun(command?: string, note?: string): Promise<void> {
  const name = command ? nameOf(command) : undefined;
  const files = await vscode.workspace.findFiles('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '{**/node_modules/**,**/dist/**,**/out/**,**/*.d.ts}', 5000);
  if (!files.length) {
    void showProblem('This workspace has no TypeScript or JavaScript files.', [{ title: 'Open a folder…', run: () => vscode.commands.executeCommand('workbench.action.files.openFolder') }], 'info');
    return;
  }
  const open = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.toString() : '')));
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri };
  const item = (uri: vscode.Uri): Item => ({ label: `$(file-code) ${uri.path.split('/').pop()}`, description: vscode.workspace.asRelativePath(uri.with({ path: uri.path.replace(/\/[^/]*$/, '') })), uri });
  // Files the feature is likely to fit first: components for React state, then the rest by path.
  const likely = (u: vscode.Uri) => (command === 'tsStructure.reactState' ? /\.[jt]sx$/.test(u.path) : true) && !/(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(u.path);
  const sorted = [...files].sort((a, b) => Number(likely(b)) - Number(likely(a)) || vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
  // Where this feature last ran comes first of all.
  const lastFile = command ? lastSubjects()[command]?.file : undefined;
  const last = lastFile ? sorted.find((u) => u.fsPath.toLowerCase() === lastFile.toLowerCase()) : undefined;
  const opened = sorted.filter((u) => open.has(u.toString()) && u !== last);
  const rest = sorted.filter((u) => !open.has(u.toString()) && u !== last);
  const items: Item[] = [
    ...(last ? [{ label: 'Where it last ran', kind: vscode.QuickPickItemKind.Separator }, item(last)] : []),
    ...(opened.length ? [{ label: 'Open in the editor', kind: vscode.QuickPickItemKind.Separator }, ...opened.map(item)] : []),
    ...(last || opened.length ? [{ label: 'All files', kind: vscode.QuickPickItemKind.Separator }] : []),
    ...rest.map(item),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: note ?? (name ? `${name}: which file?` : 'Open a file'), placeHolder: 'Type to search the project', matchOnDescription: true });
  if (!picked?.uri) return;
  const editor = await vscode.window.showTextDocument(picked.uri);
  if (!command) return;
  const analysis = analyses.find((a) => a.command === command);
  if (!analysis) {
    // An analysis of the file itself, such as Inspect code or Who imports this: it runs now.
    await vscode.commands.executeCommand(command);
    return;
  }
  const symbols = fileSymbols(parse(editor.document)).filter((s) => fits(analysis, s));
  if (!symbols.length) {
    // Straight back to the file list, saying why, instead of a message to click through.
    await openFileThenRun(command, `Nothing in ${picked.uri.path.split('/').pop()} fits ${name} (it starts from ${chooseTitle(analysis).replace(/^Choose (a |an )?|…$/g, '').toLowerCase()}): pick another file`);
    return;
  }
  // Only one thing fits: no list to pick from.
  const symbol = symbols.length === 1 ? symbols[0] : await pickSymbol(editor, symbols, `${name}: ${chooseTitle(analysis).replace(/…$/, '')}`);
  if (symbol) await runOn(editor, symbol, command);
}

/** "variable", "function", "class": a symbol's kind in words. */
function kindWord(symbol: FileSymbol): string {
  return symbol.kind === 'member' ? (symbol.callable ? 'method' : 'property') : symbol.kind;
}

/** "Choose a Variable…", "Choose a Function…": what the analysis starts from, in words. */
function chooseTitle(analysis: CursorAnalysis): string {
  const kinds = new Set(analysis.kinds);
  if ([...kinds].every((k) => k === 'function' || k === 'member') && analysis.accepts === notProperty) return 'Choose a Function…';
  if ([...kinds].every((k) => k === 'variable' || k === 'parameter' || k === 'member')) return kinds.has('member') ? 'Choose a Variable or Property…' : 'Choose a Variable…';
  if ([...kinds].every((k) => k === 'class' || k === 'interface')) return 'Choose a Class or Interface…';
  if ([...kinds].every((k) => k === 'parameter')) return 'Choose a Parameter…';
  if ([...kinds].every((k) => k === 'member')) return 'Choose a Method or Property…';
  if ([...kinds].every((k) => k === 'import')) return 'Choose an Import…';
  return 'Choose a Symbol…';
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
  'tsStructure.dependenceGraph': 'Program Dependence Graph',
  'tsStructure.callGraph': 'Call Graph',
  'tsStructure.reactState': 'React State Graph',
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
    fitting.map((a) => ({ label: `$(${commandIcons[a.command] ?? 'symbol-misc'}) ${nameOf(a.command)}`, command: a.command })),
    { title: `Analyze ${symbol.name}`, placeHolder: 'Choose an analysis' },
  );
  if (picked) {
    await runOn(editor, symbol, picked.command);
  }
}
