/** Every action the sidebar's Actions view offers, by tab and category, with words people may search for. */
export interface CatalogAction {
  command: string;
  label: string;
  /** One short line under the label, short enough for a narrow sidebar. */
  detail: string;
  /** What the action does in full, shown in its info tooltip. */
  info: string;
  tab: 'analyze' | 'edit';
  category: string;
  /** Extra words for search, such as "references" for Find Usages. */
  keywords?: string;
  /** The icon, when the command has none of its own in commandIcons. */
  icon?: string;
}

export const actionTabs: { id: CatalogAction['tab']; label: string; icon: string }[] = [
  { id: 'analyze', label: 'Analyze', icon: 'search-fuzzy' },
  { id: 'edit', label: 'Edit', icon: 'edit' },
];

/** The longest description line, so it fits a narrow sidebar without being cut off. */
export const maxDetailLength = 32;

const a = (tab: CatalogAction['tab'], category: string, command: string, label: string, detail: string, info: string, keywords?: string, icon?: string): CatalogAction => ({
  tab,
  category,
  command,
  label,
  detail,
  info,
  keywords,
  icon,
});

export const actionCatalog: CatalogAction[] = [
  a('analyze', 'Values', 'tsStructure.dataFlow', 'Data Flow', 'Where values come from and go',
    'Traces the variable at the cursor from every assignment to every read, across functions, and draws it as a diagram you can explore.', 'trace variable assignments'),
  a('analyze', 'Values', 'tsStructure.explainValue', 'Explain Value Path', 'Every value it can have here',
    'Lists each value the variable can hold at the cursor, with the assignments and conditions on the path that lead to it.', 'why condition'),
  a('analyze', 'Values', 'tsStructure.nullability', 'Nullability', 'Paths that make it null',
    'Shows which paths can leave the value null or undefined at the cursor, and which checks rule that out.', 'null undefined optional'),
  a('analyze', 'Values', 'tsStructure.sliceBackward', 'What Affects This Value', 'Code this value depends on',
    'A backward slice: highlights every statement and decision that can change the value at the cursor.', 'backward slice dependencies'),
  a('analyze', 'Values', 'tsStructure.sliceForward', 'What This Value Affects', 'Code that depends on this value',
    'A forward slice: highlights every statement the value flows into and every decision it controls.', 'forward slice impact'),
  a('analyze', 'Values', 'tsStructure.mutationTrackingVariable', 'Mutation Tracking for This Variable', 'Every change to it',
    'Lists every write to the variable and flags the ones after an await, where other code may run in between.', 'writes changes'),
  a('analyze', 'Values', 'tsStructure.raceConditions', 'Race Conditions', 'Async changes between uses',
    'Finds code where an await sits between reading a value and writing it back, so another task may change it in the meantime.', 'await concurrency'),

  a('analyze', 'Control flow and errors', 'tsStructure.controlFlow', 'Control Flow Graph', 'A function as a flowchart',
    'Draws the function at the cursor as a flowchart, with a Path Explorer that lists, compares and filters every path and flags the impossible ones.', 'paths branches flowchart cfg'),
  a('analyze', 'Control flow and errors', 'tsStructure.exceptionFlow', 'Exception Flow', 'Errors thrown, caught or lost',
    'Shows where a function throws, where each error is caught, and which catch blocks swallow errors.', 'throw catch errors'),
  a('analyze', 'Control flow and errors', 'tsStructure.promiseRejections', 'Promise Rejections', 'Rejections handled or lost',
    'Finds promises whose rejections are never handled, such as calls without await or catch.', 'async promise catch'),
  a('analyze', 'Control flow and errors', 'tsStructure.sideEffects', 'Side Effects', 'What a function changes',
    'Lists what the function changes besides its result: parameters, outer variables, globals, I/O and the DOM.', 'pure impure io'),

  a('analyze', 'Navigate', 'tsStructure.semanticUsages', 'Find Usages', 'Reads, writes and calls, grouped',
    'Finds every usage of the symbol at the cursor, grouped into reads, writes, calls, imports and type references.', 'references callers'),
  a('analyze', 'Navigate', 'tsStructure.semanticUsagesInFile', 'Find Usages in Current File', 'Usages in this file only',
    'Finds the usages of the symbol at the cursor in the current file, grouped like Find Usages.', 'references'),
  a('analyze', 'Navigate', 'tsStructure.argumentFlow', 'Argument Propagation', 'Values passed to a parameter',
    'Follows a parameter back through every call to the values passed into it.', 'parameter callers values'),
  a('analyze', 'Navigate', 'tsStructure.typeHierarchy', 'Inheritance Hierarchy', 'Supertypes, subtypes, overrides',
    'Shows what a class or interface extends and implements, what extends it, and the members they override.', 'class interface extends implements'),
  a('analyze', 'Navigate', 'tsStructure.overrideImpact', 'Override Impact', 'What changing a member reaches',
    'Lists every override and implementation of a member, and their callers, that a change to it would reach.', 'override method'),
  a('analyze', 'Navigate', 'tsStructure.reexportChain', 'Re-export Chain', 'A name through barrel files',
    'Follows an imported name through aliases and barrel (index) files back to its declaration.', 'import export barrel'),

  a('analyze', 'Modules', 'tsStructure.whoImports', 'Who Imports This File', 'Modules that import this one',
    'Lists the modules that import this file, directly or through re-exports.', 'dependents importers'),
  a('analyze', 'Modules', 'tsStructure.dependencyPath', 'Dependency Path…', 'Why one module needs another',
    'Shows the chain of imports that makes one module depend on another.', 'import chain'),
  a('analyze', 'Modules', 'tsStructure.findImportCycles', 'Find Import Cycles', 'Modules importing each other',
    'Finds circular imports in the project and shows each cycle.', 'circular dependency'),
  a('analyze', 'Modules', 'tsStructure.dependencyGraphDiff', 'Dependency Graph Diff…', 'Import changes since a revision',
    'Compares the import graph with a Git revision and lists the dependencies added and removed.', 'git branch compare'),

  a('analyze', 'Project health', 'tsStructure.inspectCode', 'Inspect Code…', 'Run every inspection',
    'Runs every inspection over the current file or the whole project and lists the problems found.', 'lint problems warnings'),
  a('analyze', 'Project health', 'tsStructure.auditTypeAssertions', 'Audit Type Assertions', 'Risky casts, worst first',
    'Lists every type assertion (as, <T> and the non-null !), ranked by how likely each is to hide a bug.', 'cast unsafe'),
  a('analyze', 'Project health', 'tsStructure.findDuplicates', 'Find Duplicates…', 'Copied code, even renamed',
    'Finds blocks of code that are copies of each other, even when variables were renamed.', 'copy paste clones'),
  a('analyze', 'Project health', 'tsStructure.deadExports', 'Dead Exports', 'Exports nothing uses',
    'Finds exports that no reachable module imports, so they can be removed.', 'unused code'),
  a('analyze', 'Project health', 'tsStructure.detectPatterns', 'Design Patterns…', 'Factories, observers and more',
    'Detects design patterns such as factories, observers, strategies, singletons and React hooks.', 'architecture react hooks'),
  a('analyze', 'Project health', 'tsStructure.mutationTracking', 'Mutation Tracking', 'Shared state this file changes',
    'Lists the functions in this file that change state shared with other code.', 'side effects state'),
  a('analyze', 'Project health', 'tsStructure.mutationTrackingProject', 'Mutation Tracking (Project)', 'Shared state changes, everywhere',
    'Lists the functions in the whole project that change shared state.', 'state'),

  a('analyze', 'Tests', 'tsImpact.analyze', 'Test Impact', 'Tests that cover this code',
    'Finds the tests that depend on the symbol or file at the cursor, directly or through imports.', 'which tests run'),
  a('analyze', 'Tests', 'tsImpact.analyzeChanged', 'Test Impact of Changed Files', 'Tests for uncommitted changes',
    'Finds the tests that depend on every file changed since the last commit.', 'git diff tests'),

  a('edit', 'Refactor', 'tsStructure.changeSignature', 'Change Signature…', 'Edit parameters everywhere',
    'Rename, add, remove or reorder a function’s parameters, and update every call to match.', 'parameters arguments rename'),
  a('edit', 'Refactor', 'tsStructure.introduceParameter', 'Introduce Parameter…', 'Make a selection a parameter',
    'Turns the selected expression into a new parameter and passes it at every call.', 'extract argument'),
  a('edit', 'Refactor', 'tsStructure.moveMembers', 'Move Members to Module…', 'Move code to another file',
    'Moves declarations to another module and fixes the imports everywhere they are used.', 'move file'),
  a('edit', 'Refactor', 'tsStructure.safeDelete', 'Safe Delete…', 'Delete after checking usages',
    'Deletes a declaration only after checking that nothing still uses it, and shows what does.', 'remove'),
  a('edit', 'Rewrite', 'tsStructure.showRewrites', 'Show Rewrites Here', 'Rewrites for the cursor',
    'Lists the intention actions (rewrites) that apply to the code at the cursor.', 'intentions convert lightbulb', 'wand'),
  a('edit', 'Rewrite', 'tsStructure.chooseIntentions', 'Choose Rewrites…', 'Turn rewrites on or off',
    'Picks which rewrites the light bulb menu offers.', 'intentions settings'),
  a('edit', 'Search and replace', 'tsStructure.structuralSearch', 'Structural Search…', 'Find and replace by shape',
    'Finds code by its structure rather than its text, with placeholders, and can replace each match.', 'pattern regex replace'),
  a('edit', 'Search and replace', 'tsStructure.manageCustomInspections', 'Custom Inspections…', 'Saved patterns that warn',
    'Your saved structural search patterns, reported as problems wherever they match.', 'rules'),
  a('edit', 'Problems', 'tsStructure.nextProblem', 'Next Problem', 'Go to the next problem',
    'Moves the cursor to the next problem in this file.', 'inspection warning', 'arrow-down'),
  a('edit', 'Problems', 'tsStructure.configureInspections', 'Configure Inspections…', 'Severity of each inspection',
    'Sets how each inspection is reported (error, warning or hint), or turns it off.', 'settings severity', 'settings'),
];

/** Starting points before anything has been used, so the Most Used section is never empty. */
export const defaultMostUsed = [
  'tsStructure.dataFlow',
  'tsStructure.semanticUsages',
  'tsStructure.controlFlow',
  'tsStructure.inspectCode',
  'tsImpact.analyze',
  'tsStructure.changeSignature',
  'tsStructure.showRewrites',
  'tsStructure.structuralSearch',
  'tsStructure.safeDelete',
];

/** The most used actions, by how often each was run, then the defaults to fill up to `count`. */
export function mostUsed(usage: Readonly<Record<string, number>>, available: readonly string[], count = 5): string[] {
  const used = Object.entries(usage)
    .filter(([command, n]) => n > 0 && available.includes(command))
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([command]) => command);
  return [...new Set([...used, ...defaultMostUsed.filter((c) => available.includes(c))])].slice(0, count);
}

/**
 * How someone arranged the Actions view: pinned actions in their order, hidden actions, collapsed sections, and
 * whether descriptions and the Most Used section show. Kept in global state, so it is the same in every window.
 */
export interface ActionLayout {
  pinned: string[];
  hidden: string[];
  collapsed: string[];
  compact: boolean;
  hideMostUsed: boolean;
}

/** The section ids the view uses besides categories, which are `category:<name>`. */
export const sectionIds = { pinned: 'pinned', mostUsed: 'mostUsed', hidden: 'hidden' } as const;

/** Before anything is arranged: nothing pinned or hidden, and the Hidden section folded. */
export const defaultLayout = (): ActionLayout => ({ pinned: [], hidden: [], collapsed: [sectionIds.hidden], compact: false, hideMostUsed: false });

const known = new Set(actionCatalog.map((x) => x.command));

/** A stored layout made safe: unknown or repeated commands dropped, missing parts filled in. */
export function normalizeLayout(raw: unknown): ActionLayout {
  const base = defaultLayout();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Record<keyof ActionLayout, unknown>>;
  const commands = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((c): c is string => typeof c === 'string' && known.has(c)))] : []);
  const hidden = commands(r.hidden);
  return {
    pinned: commands(r.pinned).filter((c) => !hidden.includes(c)),
    hidden,
    collapsed: Array.isArray(r.collapsed) ? [...new Set(r.collapsed.filter((c): c is string => typeof c === 'string'))] : base.collapsed,
    compact: r.compact === true,
    hideMostUsed: r.hideMostUsed === true,
  };
}

/** A change someone makes to the layout from the view. */
export type LayoutChange =
  | { kind: 'pin' | 'unpin' | 'hide' | 'show'; command: string }
  | { kind: 'move'; command: string; to: number }
  | { kind: 'showAll' }
  | { kind: 'toggleSection'; id: string }
  | { kind: 'setCollapsed'; ids: string[] }
  | { kind: 'compact' | 'hideMostUsed'; value: boolean };

/** The layout after a change; a change that names an unknown action leaves it as it was. */
export function changeLayout(layout: ActionLayout, change: LayoutChange): ActionLayout {
  const next: ActionLayout = { ...layout, pinned: [...layout.pinned], hidden: [...layout.hidden], collapsed: [...layout.collapsed] };
  const without = (list: string[], c: string) => list.filter((x) => x !== c);
  if ('command' in change && !known.has(change.command)) return layout;
  switch (change.kind) {
    case 'pin':
      if (!next.pinned.includes(change.command)) next.pinned.push(change.command);
      next.hidden = without(next.hidden, change.command);
      break;
    case 'unpin':
      next.pinned = without(next.pinned, change.command);
      break;
    case 'move': {
      // Within the pinned actions: to a position, clamped to the list.
      if (!next.pinned.includes(change.command)) return layout;
      const rest = without(next.pinned, change.command);
      const to = Math.max(0, Math.min(rest.length, Math.floor(change.to)));
      rest.splice(to, 0, change.command);
      next.pinned = rest;
      break;
    }
    case 'hide':
      if (!next.hidden.includes(change.command)) next.hidden.push(change.command);
      next.pinned = without(next.pinned, change.command);
      break;
    case 'show':
      next.hidden = without(next.hidden, change.command);
      break;
    case 'showAll':
      next.hidden = [];
      break;
    case 'toggleSection':
      next.collapsed = next.collapsed.includes(change.id) ? without(next.collapsed, change.id) : [...next.collapsed, change.id];
      break;
    case 'setCollapsed':
      next.collapsed = [...new Set(change.ids.filter((id) => typeof id === 'string'))];
      break;
    case 'compact':
      next.compact = change.value === true;
      break;
    case 'hideMostUsed':
      next.hideMostUsed = change.value === true;
      break;
    default:
      return layout;
  }
  return next;
}
