import * as vscode from 'vscode';
import { sourceEditor } from './refactorCommands';
import { featureOf, features } from '../structure/features';
import { isFeatureEnabled } from './features';

interface Action {
  command: string;
  label: string;
  detail: string;
  icon: string;
  /** Only offered when text is selected. */
  needsSelection?: boolean;
}

const groups: { title: string; actions: Action[] }[] = [
  {
    title: 'Refactor',
    actions: [
      { command: 'tsStructure.changeSignature', label: 'Change Signature…', detail: 'Rename, add, remove or reorder parameters and update every call', icon: 'symbol-method' },
      { command: 'tsStructure.introduceParameter', label: 'Introduce Parameter…', detail: 'Turn the selected expression into a parameter', icon: 'symbol-parameter', needsSelection: true },
      { command: 'tsStructure.moveMembers', label: 'Move Members to Module…', detail: 'Move declarations to another file and update imports', icon: 'file-symlink-file' },
      { command: 'tsStructure.safeDelete', label: 'Safe Delete…', detail: 'Delete after checking every usage', icon: 'trash' },
    ],
  },
  {
    title: 'Inspect',
    actions: [
      { command: 'tsStructure.dataFlow', label: 'Data Flow', detail: 'How the value changes through assignments, checks and calls', icon: 'git-commit' },
      { command: 'tsStructure.nullability', label: 'Nullability', detail: 'Which paths make this value null or undefined', icon: 'circle-slash' },
      { command: 'tsStructure.sideEffects', label: 'Side Effects', detail: 'What this function changes or reads besides its result', icon: 'zap' },
      { command: 'tsStructure.mutationTracking', label: 'Mutation Tracking', detail: 'Functions in this file that mutate shared state', icon: 'edit' },
      { command: 'tsStructure.mutationTrackingProject', label: 'Mutation Tracking (Project)', detail: 'Every function in the project that mutates shared state', icon: 'edit' },
      { command: 'tsStructure.promiseRejections', label: 'Promise Rejections', detail: 'Where this function’s rejections are handled or lost', icon: 'debug-disconnect' },
      { command: 'tsStructure.exceptionFlow', label: 'Exception Flow', detail: 'Where errors are thrown, caught, transformed or swallowed', icon: 'error' },
      { command: 'tsStructure.inspectCode', label: 'Inspect Code…', detail: 'Run every inspection over the file or project', icon: 'checklist' },
      { command: 'tsStructure.auditTypeAssertions', label: 'Audit Type Assertions', detail: 'Every as, <T> and ! in the project, riskiest first', icon: 'shield' },
      { command: 'tsStructure.findDuplicates', label: 'Find Structural Duplicates…', detail: 'Copies of code with renamed variables or changed values', icon: 'files' },
      { command: 'tsStructure.deadExports', label: 'Dead Exports', detail: 'Exports nothing reachable from the entry points uses', icon: 'debug-disconnect' },
      { command: 'tsImpact.analyze', label: 'Test Impact Analysis', detail: 'Tests that depend on this symbol or file', icon: 'beaker' },
    ],
  },
  {
    title: 'Navigate',
    actions: [
      { command: 'tsStructure.semanticUsages', label: 'Semantic Find Usages', detail: 'References grouped by reads, writes, calls, imports, types and JSX', icon: 'references' },
      { command: 'tsStructure.argumentFlow', label: 'Argument Propagation', detail: 'Where a parameter’s values come from and where they go', icon: 'arrow-swap' },
      { command: 'tsStructure.reexportChain', label: 'Re-export Chain', detail: 'Follow this name through aliases and barrel files', icon: 'link' },
      { command: 'tsStructure.typeHierarchy', label: 'Inheritance Hierarchy', detail: 'Supertypes, subtypes and overrides', icon: 'type-hierarchy' },
      { command: 'tsStructure.overrideImpact', label: 'Override Impact', detail: 'What a change to this member reaches through overrides', icon: 'type-hierarchy-sub' },
      { command: 'tsStructure.dependencyPath', label: 'Dependency Path…', detail: 'Why this module depends on another one', icon: 'git-merge' },
      { command: 'tsStructure.dependencyGraphDiff', label: 'Dependency Graph Diff…', detail: 'How imports changed since a Git revision', icon: 'git-compare' },
      { command: 'tsStructure.structuralSearch', label: 'Structural Search…', detail: 'Find and replace code by shape, with typed placeholders', icon: 'search' },
    ],
  },
];

/** "Analyze or Refactor This": every refactoring and analysis for the cursor in one searchable list. */
export async function showActionsAtCursor(): Promise<void> {
  const editor = sourceEditor();
  if (!editor) {
    return;
  }
  type Item = vscode.QuickPickItem & { command?: string };
  const items: Item[] = [];
  for (const group of groups) {
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    for (const action of group.actions) {
      const feature = featureOf(action.command);
      if ((action.needsSelection && editor.selection.isEmpty) || (feature && !isFeatureEnabled(feature.id))) {
        continue;
      }
      items.push({ label: `$(${action.icon}) ${action.label}`, detail: action.detail, command: action.command });
    }
  }
  const hidden = features.filter((f) => !isFeatureEnabled(f.id)).length;
  if (hidden > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) More Features…', detail: `${hidden} more analyses and tools are turned off; choose which to turn on`, command: 'tsStructure.configureFeatures' });
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Analyze or Refactor This', placeHolder: 'Type to filter refactorings, inspections and navigation', matchOnDetail: true });
  if (picked?.command) {
    await vscode.commands.executeCommand(picked.command);
  }
}
