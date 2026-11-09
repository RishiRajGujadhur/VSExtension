import * as vscode from 'vscode';
import { CatalogAction, actionCatalog, actionId, graphCategories } from '../structure/actionCatalog';
import { featureOf } from '../structure/features';
import { commandIcons } from '../structure/icons';
import { ReportLocation } from '../structure/report';
import { fittingAt } from './analysisActions';
import { isFeatureEnabled } from './features';
import { besideChartColumn } from './webviewPage';

/** The graphs of the Graph Explorer whose features are on. */
export function graphEntries(): CatalogAction[] {
  return actionCatalog.filter((a) => a.tab === 'graphs' && (!featureOf(a.command) || isFeatureEnabled(featureOf(a.command)!.id)));
}

/** Runs an entry of the Actions view; a graph's report is then drawn as a chart. */
export async function runEntry(entry: CatalogAction): Promise<unknown> {
  const result = await vscode.commands.executeCommand<unknown>(entry.command);
  if (entry.graph && result && typeof result === 'object' && 'roots' in result) await vscode.commands.executeCommand('tsStructure.report.showDiagram');
  return result;
}

/**
 * Open Graph…: every graph by category, those that fit the symbol at the cursor first. With a location (from a chart's
 * Other Graphs button), the graph runs on that subject: its code is opened there first.
 */
export async function pickGraph(at?: ReportLocation): Promise<void> {
  let document = vscode.window.activeTextEditor?.document;
  let offset = document ? document.offsetAt(vscode.window.activeTextEditor!.selection.active) : 0;
  if (at) {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(at.file));
    offset = document.offsetAt(new vscode.Position(at.line, at.character));
  }
  const fits = new Set(document ? fittingAt(document, offset) : []);
  type Item = vscode.QuickPickItem & { entry?: CatalogAction };
  const entries = graphEntries();
  const item = (e: CatalogAction): Item => ({ label: `$(${commandIcons[e.command] ?? 'graph'}) ${e.label}`, description: e.detail, detail: e.startsFrom ? `Starts from ${e.startsFrom}${e.levels ? ` · levels: ${e.levels}` : ''}` : undefined, entry: e });
  const items: Item[] = [];
  const fitting = entries.filter((e) => fits.has(e.command));
  if (fitting.length) items.push({ label: at ? 'For this subject' : 'For the cursor', kind: vscode.QuickPickItemKind.Separator }, ...fitting.map(item));
  for (const category of Object.keys(graphCategories)) {
    const inCategory = entries.filter((e) => e.category === category && !fitting.includes(e));
    if (inCategory.length) items.push({ label: category, kind: vscode.QuickPickItemKind.Separator }, ...inCategory.map(item));
  }
  const picked = await vscode.window.showQuickPick(items, { title: at ? 'Other Graphs of This Subject' : 'Open Graph', placeHolder: 'Choose a graph', matchOnDescription: true, matchOnDetail: true });
  if (!picked?.entry) return;
  if (at && document) {
    // The graph starts from the subject's code, so the editor goes there first.
    const position = new vscode.Position(at.line, at.character);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), viewColumn: besideChartColumn(), preserveFocus: false });
  }
  await runEntry(picked.entry);
}

/** The id of a graph entry, for the Actions view. */
export const graphId = (command: string) => actionId(actionCatalog.find((a) => a.tab === 'graphs' && a.command === command) ?? { command } as CatalogAction);
