import * as vscode from 'vscode';
import { sourceEditor } from './refactorCommands';
import { Keybinding, shortcuts } from '../structure/keys';
import { featureOf, features } from '../structure/features';
import { isFeatureEnabled } from './features';
import { commandIcons } from '../structure/icons';
import { intentionsAtCursor } from './intentionProvider';
import { suggestedAt } from './analysisActions';
import { recordActionUse } from './actionsView';
import { nameOf } from '../structure/names';

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
      { command: 'tsStructure.changeSignature', label: 'Change signature…', detail: 'Rename, add, remove or reorder parameters and update every call' },
      { command: 'tsStructure.introduceParameter', label: 'Introduce parameter…', detail: 'Turn the selected expression into a parameter', needsSelection: true },
      { command: 'tsStructure.moveMembers', label: 'Move members to module…', detail: 'Move declarations to another file and update imports' },
      { command: 'tsStructure.safeDelete', label: 'Safe delete…', detail: 'Delete after checking every usage' },
    ],
  },
  {
    title: 'Inspect',
    actions: [
      { command: 'tsStructure.dataFlow', label: 'Data flow', detail: 'How the value changes through assignments, checks and calls' },
      { command: 'tsStructure.nullability', label: 'Nullability', detail: 'Which paths make this value null or undefined' },
      { command: 'tsStructure.sideEffects', label: 'Side effects', detail: 'What this function changes or reads besides its result' },
      { command: 'tsStructure.detectPatterns', label: 'Detect design patterns…', detail: 'Factories, observers, strategies, singletons and other patterns in the code' },
      { command: 'tsStructure.mutationTracking', label: 'Mutation tracking', detail: 'Functions in this file that mutate shared state' },
      { command: 'tsStructure.mutationTrackingVariable', label: 'Mutation tracking for this variable', detail: 'Every change to the variable at the cursor, and whether it runs after an await' },
      { command: 'tsStructure.controlFlow', label: 'Control flow graph', detail: 'Every decision, loop and return of this function as a flowchart, with its paths' },
      { command: 'tsStructure.dependenceGraph', label: 'Program dependence graph', detail: 'Where each value of this function comes from, and which decisions control each statement' },
      { command: 'tsStructure.callGraph', label: 'Call graph', detail: 'Who calls this function and what it calls, a few levels each way' },
      { command: 'tsStructure.reactState', label: 'React state graph', detail: 'Props, state, effects and memos of this component, and what each one triggers' },
      { command: 'tsStructure.sliceBackward', label: 'What affects this value', detail: 'The statements and decisions this value depends on (backward slice)' },
      { command: 'tsStructure.sliceForward', label: 'What this value affects', detail: 'Everything this value flows into or decides (forward slice)' },
      { command: 'tsStructure.explainValue', label: 'Explain value path', detail: 'Every value this variable can have here, and the conditions that lead to each' },
      { command: 'tsStructure.raceConditions', label: 'Race conditions', detail: 'Whether async code can change this variable between a read and a write' },
      { command: 'tsStructure.mutationTrackingProject', label: 'Mutation tracking (project)', detail: 'Every function in the project that mutates shared state' },
      { command: 'tsStructure.promiseRejections', label: 'Promise rejections', detail: 'Where this function’s rejections are handled or lost' },
      { command: 'tsStructure.exceptionFlow', label: 'Exception flow', detail: 'Where errors are thrown, caught, transformed or swallowed' },
      { command: 'tsStructure.inspectCode', label: 'Inspect Code…', detail: 'Run every inspection over the file or project' },
      { command: 'tsStructure.auditTypeAssertions', label: 'Audit type assertions', detail: 'Every as, <T> and ! in the project, riskiest first' },
      { command: 'tsStructure.findDuplicates', label: 'Find structural duplicates…', detail: 'Copies of code with renamed variables or changed values' },
      { command: 'tsStructure.deadExports', label: 'Dead exports', detail: 'Exports nothing reachable from the entry points uses' },
      { command: 'tsImpact.analyze', label: 'Test impact analysis', detail: 'Tests that depend on this symbol or file' },
    ],
  },
  {
    title: 'Navigate',
    actions: [
      { command: 'tsStructure.semanticUsagesInFile', label: 'Find usages in current file', detail: 'The same search, limited to this file' },
      { command: 'tsStructure.semanticUsages', label: 'Semantic find usages', detail: 'References grouped by reads, writes, calls, imports, types and JSX' },
      { command: 'tsStructure.argumentFlow', label: 'Argument propagation', detail: 'Where a parameter’s values come from and where they go' },
      { command: 'tsStructure.reexportChain', label: 'Re-export chain', detail: 'Follow this name through aliases and barrel files' },
      { command: 'tsStructure.typeHierarchy', label: 'Inheritance hierarchy', detail: 'Supertypes, subtypes and overrides' },
      { command: 'tsStructure.overrideImpact', label: 'Override impact', detail: 'What a change to this member reaches through overrides' },
      { command: 'tsStructure.dependencyPath', label: 'Dependency path…', detail: 'Why this module depends on another one' },
      { command: 'tsStructure.whoImports', label: 'Who imports this file', detail: 'Modules that import this file, directly or indirectly' },
      { command: 'tsStructure.findImportCycles', label: 'Find import cycles', detail: 'Modules that import each other at run time' },
      { command: 'tsStructure.dependencyGraphDiff', label: 'Dependency graph diff…', detail: 'How imports changed since a Git revision' },
      { command: 'tsStructure.structuralSearch', label: 'Structural search…', detail: 'Find and replace code by shape, with typed placeholders' },
    ],
  },
];

const recentKey = 'tsStructure.recentActions';
const maxRecent = 5;

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
  const remap: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('keyboard'), tooltip: 'Change keyboard shortcut' };
  const item = (action: Action): Item => ({ label: `$(${commandIcons[action.command] ?? 'symbol-misc'}) ${nameOf(action.command, action.label)}`, description: keys.get(action.command), detail: action.detail, command: action.command, buttons: [remap] });
  const all = groups.flatMap((g) => g.actions);
  const recent = (memento?.get<string[]>(recentKey) ?? [])
    .map((command) => all.find((a) => a.command === command))
    .filter((a): a is Action => !!a && available(a));
  // What fits the declaration under the cursor comes first, such as Side Effects on a function name.
  const suggested = suggestedAt(editor.document, editor.document.offsetAt(editor.selection.active))
    .map((command) => all.find((a) => a.command === command))
    .filter((a): a is Action => !!a && available(a) && !recent.includes(a));
  const items: Item[] = [
    ...(suggested.length ? [{ label: 'Suggested here', kind: vscode.QuickPickItemKind.Separator }, ...suggested.map(item)] : []),
    ...(recent.length ? [{ label: 'Recently used', kind: vscode.QuickPickItemKind.Separator }, ...recent.map(item)] : []),
  ];
  for (const group of groups) {
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    // A suggested or recent action is listed once, at the top.
    items.push(...group.actions.filter((a) => available(a) && !recent.includes(a) && !suggested.includes(a)).map(item));
  }
  // The lightbulb's rewrites that apply here, so one list holds everything that can be done at the cursor.
  const disabled = new Set(vscode.workspace.getConfiguration('tsStructure').get<string[]>('intentions.disabled', []));
  const rewrites = isFeatureEnabled('intentions') ? intentionsAtCursor(editor, disabled) : [];
  if (rewrites.length) {
    items.push({ label: 'Rewrite', kind: vscode.QuickPickItemKind.Separator }, ...rewrites.map((rewrite) => ({ label: `$(wand) ${rewrite.title}`, detail: 'Intention action at the cursor', rewrite })));
  }
  const hidden = features.filter((f) => !isFeatureEnabled(f.id)).length;
  if (hidden > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(tools) Toolshed…', detail: `${hidden} more analyses and tools are turned off; choose which to turn on`, command: 'tsStructure.configureFeatures' });
  }
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'Analyze or refactor this';
  picker.placeholder = 'Type to filter refactorings, inspections and navigation';
  picker.matchOnDetail = true;
  picker.items = items;
  const allShortcuts: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('keyboard'), tooltip: 'Keyboard shortcuts for Code X-Ray' };
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
      // The Actions view's Most Used section counts these too.
      if (memento) recordActionUse(memento, picked.command);
    }
    await vscode.commands.executeCommand(picked.command);
  }
}
