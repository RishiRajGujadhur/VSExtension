import * as vscode from 'vscode';
import { sourceEditor } from './refactorCommands';
import { Keybinding, shortcuts } from '../structure/keys';
import { featureOf, features } from '../structure/features';
import { isFeatureEnabled } from './features';
import { commandIcons } from '../structure/icons';
import { intentionsAtCursor } from './intentionProvider';

interface Action {
  command: string;
  label: string;
  detail: string;
  /** Only offered when text is selected. */
  needsSelection?: boolean;
}

const groups: { title: string; actions: Action[] }[] = [
  {
    title: 'Refactor',
    actions: [
      { command: 'tsStructure.changeSignature', label: 'Change Signature…', detail: 'Rename, add, remove or reorder parameters and update every call' },
      { command: 'tsStructure.introduceParameter', label: 'Introduce Parameter…', detail: 'Turn the selected expression into a parameter', needsSelection: true },
      { command: 'tsStructure.moveMembers', label: 'Move Members to Module…', detail: 'Move declarations to another file and update imports' },
      { command: 'tsStructure.safeDelete', label: 'Safe Delete…', detail: 'Delete after checking every usage' },
    ],
  },
  {
    title: 'Inspect',
    actions: [
      { command: 'tsStructure.dataFlow', label: 'Data Flow', detail: 'How the value changes through assignments, checks and calls' },
      { command: 'tsStructure.nullability', label: 'Nullability', detail: 'Which paths make this value null or undefined' },
      { command: 'tsStructure.sideEffects', label: 'Side Effects', detail: 'What this function changes or reads besides its result' },
      { command: 'tsStructure.mutationTracking', label: 'Mutation Tracking', detail: 'Functions in this file that mutate shared state' },
      { command: 'tsStructure.mutationTrackingProject', label: 'Mutation Tracking (Project)', detail: 'Every function in the project that mutates shared state' },
      { command: 'tsStructure.promiseRejections', label: 'Promise Rejections', detail: 'Where this function’s rejections are handled or lost' },
      { command: 'tsStructure.exceptionFlow', label: 'Exception Flow', detail: 'Where errors are thrown, caught, transformed or swallowed' },
      { command: 'tsStructure.inspectCode', label: 'Inspect Code…', detail: 'Run every inspection over the file or project' },
      { command: 'tsStructure.auditTypeAssertions', label: 'Audit Type Assertions', detail: 'Every as, <T> and ! in the project, riskiest first' },
      { command: 'tsStructure.findDuplicates', label: 'Find Structural Duplicates…', detail: 'Copies of code with renamed variables or changed values' },
      { command: 'tsStructure.deadExports', label: 'Dead Exports', detail: 'Exports nothing reachable from the entry points uses' },
      { command: 'tsImpact.analyze', label: 'Test Impact Analysis', detail: 'Tests that depend on this symbol or file' },
    ],
  },
  {
    title: 'Navigate',
    actions: [
      { command: 'tsStructure.semanticUsages', label: 'Semantic Find Usages', detail: 'References grouped by reads, writes, calls, imports, types and JSX' },
      { command: 'tsStructure.argumentFlow', label: 'Argument Propagation', detail: 'Where a parameter’s values come from and where they go' },
      { command: 'tsStructure.reexportChain', label: 'Re-export Chain', detail: 'Follow this name through aliases and barrel files' },
      { command: 'tsStructure.typeHierarchy', label: 'Inheritance Hierarchy', detail: 'Supertypes, subtypes and overrides' },
      { command: 'tsStructure.overrideImpact', label: 'Override Impact', detail: 'What a change to this member reaches through overrides' },
      { command: 'tsStructure.dependencyPath', label: 'Dependency Path…', detail: 'Why this module depends on another one' },
      { command: 'tsStructure.dependencyGraphDiff', label: 'Dependency Graph Diff…', detail: 'How imports changed since a Git revision' },
      { command: 'tsStructure.structuralSearch', label: 'Structural Search…', detail: 'Find and replace code by shape, with typed placeholders' },
    ],
  },
];

const recentKey = 'tsStructure.recentActions';
const maxRecent = 3;

/** "Analyze or Refactor This": every refactoring and analysis for the cursor in one searchable list, the last ones used first. */
export async function showActionsAtCursor(memento?: vscode.Memento, keybindings: readonly Keybinding[] = []): Promise<void> {
  const editor = sourceEditor();
  if (!editor) {
    return;
  }
  type Item = vscode.QuickPickItem & { command?: string; rewrite?: ReturnType<typeof intentionsAtCursor>[number] };
  const available = (action: Action) => {
    const feature = featureOf(action.command);
    return !(action.needsSelection && editor.selection.isEmpty) && !(feature && !isFeatureEnabled(feature.id));
  };
  const keys = shortcuts(keybindings);
  // Each entry's keyboard button opens its shortcut for remapping.
  const remap: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('keyboard'), tooltip: 'Change Keyboard Shortcut' };
  const item = (action: Action): Item => ({ label: `$(${commandIcons[action.command] ?? 'symbol-misc'}) ${action.label}`, description: keys.get(action.command), detail: action.detail, command: action.command, buttons: [remap] });
  const all = groups.flatMap((g) => g.actions);
  const recent = (memento?.get<string[]>(recentKey) ?? [])
    .map((command) => all.find((a) => a.command === command))
    .filter((a): a is Action => !!a && available(a));
  const items: Item[] = recent.length ? [{ label: 'Recently used', kind: vscode.QuickPickItemKind.Separator }, ...recent.map(item)] : [];
  for (const group of groups) {
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    // A recent action is listed once, at the top.
    items.push(...group.actions.filter((a) => available(a) && !recent.includes(a)).map(item));
  }
  // The lightbulb's rewrites that apply here, so one list holds everything that can be done at the cursor.
  const disabled = new Set(vscode.workspace.getConfiguration('tsStructure').get<string[]>('intentions.disabled', []));
  const rewrites = isFeatureEnabled('intentions') ? intentionsAtCursor(editor, disabled) : [];
  if (rewrites.length) {
    items.push({ label: 'Rewrite', kind: vscode.QuickPickItemKind.Separator }, ...rewrites.map((rewrite) => ({ label: `$(wand) ${rewrite.title}`, detail: 'Intention action at the cursor', rewrite })));
  }
  const hidden = features.filter((f) => !isFeatureEnabled(f.id)).length;
  if (hidden > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) More Features…', detail: `${hidden} more analyses and tools are turned off; choose which to turn on`, command: 'tsStructure.configureFeatures' });
  }
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'Analyze or Refactor This';
  picker.placeholder = 'Type to filter refactorings, inspections and navigation';
  picker.matchOnDetail = true;
  picker.items = items;
  const allShortcuts: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('keyboard'), tooltip: 'Keyboard Shortcuts for TypeScript Structure' };
  picker.buttons = [allShortcuts];
  const picked = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]));
    picker.onDidTriggerButton(() => {
      resolve(undefined);
      void vscode.commands.executeCommand('tsStructure.editKeybindings');
    });
    picker.onDidTriggerItemButton((e) => {
      resolve(undefined);
      void vscode.commands.executeCommand('tsStructure.editKeybindings', e.item.command);
    });
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (picked?.rewrite) {
    const edit = new vscode.WorkspaceEdit();
    for (const e of picked.rewrite.edits) {
      edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(e.start), editor.document.positionAt(e.end)), e.text);
    }
    await vscode.workspace.applyEdit(edit);
    return;
  }
  if (picked?.command) {
    if (all.some((a) => a.command === picked.command)) {
      const previous = memento?.get<string[]>(recentKey) ?? [];
      await memento?.update(recentKey, [picked.command, ...previous.filter((c) => c !== picked.command)].slice(0, maxRecent));
    }
    await vscode.commands.executeCommand(picked.command);
  }
}
