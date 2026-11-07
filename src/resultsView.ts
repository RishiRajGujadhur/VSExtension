import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ImpactedTest, ImpactResult, PathStep, SourceLocation, TestCase } from './analysis/types';
import { hashText, pathKey } from './analysis/paths';

type Item =
  | { kind: 'file'; file: string; tests: ImpactedTest[] }
  | { kind: 'test'; impacted: ImpactedTest }
  | { kind: 'step'; step: PathStep; index: number };

export class ResultsProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private current: ImpactResult | undefined;
  view: vscode.TreeView<Item> | undefined;

  get result(): ImpactResult | undefined {
    return this.current;
  }

  /** How many tests the last analysis found, until it is cleared; clicking shows them. */
  private readonly status = vscode.window.createStatusBarItem('tsImpact.summary', vscode.StatusBarAlignment.Left, 50);

  set(result: ImpactResult | undefined): void {
    this.current = result;
    if (result) {
      this.status.name = 'Impacted Tests';
      this.status.text = `$(beaker) ${countLabel(result.tests.length)}`;
      this.status.tooltip = `Tests impacted by ${result.target.name}. Click to see or run them.`;
      this.status.command = 'tsImpact.showLastResults';
      this.status.show();
    } else {
      this.status.hide();
    }
    if (this.view) {
      this.view.description = result ? `${result.target.name} · ${countLabel(result.tests.length)}` : undefined;
      this.view.message = result?.warnings.length ? result.warnings.join(' ') : undefined;
    }
    this.changed.fire();
  }

  getChildren(item?: Item): Item[] {
    const result = this.current;
    if (!result) {
      return [];
    }
    if (!item) {
      const byFile = new Map<string, ImpactedTest[]>();
      for (const impacted of result.tests) {
        const list = byFile.get(impacted.test.file) ?? [];
        list.push(impacted);
        byFile.set(impacted.test.file, list);
      }
      return [...byFile].map(([file, tests]) => ({ kind: 'file', file, tests }));
    }
    if (item.kind === 'file') {
      return item.tests.map((impacted) => ({ kind: 'test', impacted }));
    }
    if (item.kind === 'test') {
      return item.impacted.path.map((step, index) => ({ kind: 'step', step, index }));
    }
    return [];
  }

  getTreeItem(item: Item): vscode.TreeItem {
    switch (item.kind) {
      case 'file': {
        const tree = new vscode.TreeItem(path.basename(item.file), vscode.TreeItemCollapsibleState.Expanded);
        tree.description = vscode.workspace.asRelativePath(path.dirname(item.file));
        tree.resourceUri = vscode.Uri.file(item.file);
        tree.iconPath = vscode.ThemeIcon.File;
        tree.contextValue = 'file';
        return tree;
      }
      case 'test': {
        const { test, confidence } = item.impacted;
        const tree = new vscode.TreeItem(testLabel(test), vscode.TreeItemCollapsibleState.Collapsed);
        tree.description = [confidence === 'possible' ? 'possible' : '', test.parameterized ? 'parameterized' : ''].filter(Boolean).join(' · ');
        tree.tooltip = testTooltip(item.impacted);
        tree.iconPath = new vscode.ThemeIcon(confidence === 'confirmed' ? 'beaker' : 'question');
        tree.contextValue = 'test';
        tree.command = openCommand(test.location);
        return tree;
      }
      case 'step': {
        const { step } = item;
        const tree = new vscode.TreeItem(step.name, vscode.TreeItemCollapsibleState.None);
        tree.description = step.note ?? step.kind;
        tree.iconPath = new vscode.ThemeIcon(item.index === 0 ? 'symbol-event' : step.kind === 'test' || step.kind === 'test file' ? 'beaker' : 'arrow-small-down');
        tree.tooltip = `${step.kind} · ${vscode.workspace.asRelativePath(step.location.file)}:${step.location.line + 1}`;
        tree.contextValue = 'step';
        tree.command = openCommand(step.location);
        return tree;
      }
    }
  }

  /** Tests represented by a tree item, for the inline run action. */
  testsOf(item: Item): TestCase[] {
    if (item.kind === 'file') {
      return item.tests.map((t) => t.test);
    }
    return item.kind === 'test' ? [item.impacted.test] : [];
  }
}

export async function showResultsPicker(result: ImpactResult, run: (tests: TestCase[]) => void): Promise<void> {
  type PickItem = vscode.QuickPickItem & { impacted?: ImpactedTest };
  const runButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Run this test' };
  const items: PickItem[] = [];
  for (const confidence of ['confirmed', 'possible'] as const) {
    const group = result.tests.filter((t) => t.confidence === confidence);
    if (group.length === 0) {
      continue;
    }
    // The separators double as the explanation of the two confidence levels.
    items.push({ label: confidence === 'confirmed' ? 'Confirmed: the test calls or references it' : 'Possible: reached through a module import or an interface, so it may not run it', kind: vscode.QuickPickItemKind.Separator });
    for (const impacted of group) {
      items.push({
        label: `$(${confidence === 'confirmed' ? 'beaker' : 'question'}) ${testLabel(impacted.test)}`,
        description: `${vscode.workspace.asRelativePath(impacted.test.file)}:${impacted.test.location.line + 1}`,
        detail: impacted.path.map((s) => s.name).join('  →  '),
        buttons: [runButton],
        impacted,
      });
    }
  }

  const picker = vscode.window.createQuickPick<PickItem>();
  const confirmed = result.tests.filter((t) => t.confidence === 'confirmed').length;
  picker.title = `Tests impacted by ${result.target.name}: ${countLabel(result.tests.length)} (${confirmed} confirmed, ${result.tests.length - confirmed} possible)`;
  picker.placeholder = 'Search by test name, file or dependency chain. Select a test to open its registration.';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = items;
  // Run every impacted test without closing the list first.
  const runAll: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('run-all'), tooltip: `Run All ${countLabel(result.tests.length)}` };
  const copy: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy Impacted Tests…' };
  picker.buttons = [runAll, copy];
  picker.onDidTriggerButton((button) => {
    picker.hide();
    if (button === runAll) {
      run(result.tests.map((t) => t.test));
    } else {
      void vscode.commands.executeCommand('tsImpact.copyTests');
    }
  });
  picker.onDidTriggerItemButton((e) => {
    if (e.item.impacted) {
      run([e.item.impacted.test]);
    }
  });
  picker.onDidAccept(() => {
    const selected = picker.selectedItems[0]?.impacted;
    picker.hide();
    if (selected) {
      void openLocation(selected.test.location);
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

let activeResult: () => ImpactResult | undefined = () => undefined;

export function trackResult(provider: () => ImpactResult | undefined): void {
  activeResult = provider;
}

/** Opens a result location unless its file changed after the analysis, in which case the position may be wrong. */
export async function openLocation(location: SourceLocation): Promise<void> {
  const result = activeResult();
  const expected = result?.fileHashes[location.file];
  const uri = vscode.Uri.file(location.file);
  if (expected && currentHash(uri) !== expected) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(location.file)} has changed since the impact analysis ran, so this result may point to the wrong place.`,
      'Re-run Analysis',
    );
    if (choice) {
      await vscode.commands.executeCommand('tsImpact.analyze');
    }
    return;
  }
  const position = new vscode.Position(location.line, location.character);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), preview: true });
}

export function currentHash(uri: vscode.Uri): string | undefined {
  const open = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === pathKey(uri.fsPath));
  if (open) {
    return hashText(open.getText());
  }
  try {
    return hashText(fs.readFileSync(uri.fsPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function openCommand(location: SourceLocation): vscode.Command {
  return { command: 'tsImpact.open', title: 'Open', arguments: [location] };
}

function testLabel(test: TestCase): string {
  if (test.isFileEntry) {
    return `${test.title} (whole file, no static test registrations)`;
  }
  return test.titlePath.join(' › ') + (test.dynamic && !test.parameterized ? ' (dynamic title)' : '');
}

function testTooltip(impacted: ImpactedTest): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${impacted.confidence === 'confirmed' ? 'Confirmed' : 'Possible'} impact** — ${impacted.reason}\n\n`);
  impacted.path.forEach((step, i) => {
    md.appendMarkdown(`${i + 1}. \`${step.name}\` (${step.kind})${step.note ? ` — ${step.note}` : ''}\n`);
  });
  return md;
}

export function countLabel(count: number): string {
  return `${count} test${count === 1 ? '' : 's'}`;
}
