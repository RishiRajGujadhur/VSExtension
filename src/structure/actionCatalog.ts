import { nameOf } from './names';

/** Every action the sidebar's Actions view offers, by tab and category, with words people may search for. */
export interface CatalogAction {
  /** The entry's own id: its command, or `graph:<command>` for the same command in the Graphs tab. */
  id?: string;
  command: string;
  /** Draw the command's report as a chart after it runs (the Graphs tab). */
  graph?: boolean;
  /** What a graph starts from, such as "a function". */
  startsFrom?: string;
  /** What its levels control, for graphs that can go deeper. */
  levels?: string;
  label: string;
  /** One short line under the label, short enough for a narrow sidebar. */
  detail: string;
  /** What the action does in full, shown in its info tooltip. */
  info: string;
  tab: 'analyze' | 'edit' | 'graphs';
  category: string;
  /** Extra words for search, such as "references" for Find Usages. */
  keywords?: string;
  /** The icon, when the command has none of its own in commandIcons. */
  icon?: string;
  /** What it was called before the plain names, so people who knew it can find it. */
  formerly?: string;
}

export const actionTabs: { id: CatalogAction['tab']; label: string; icon: string }[] = [
  { id: 'analyze', label: 'Analyze', icon: 'search-fuzzy' },
  { id: 'edit', label: 'Edit', icon: 'edit' },
  { id: 'graphs', label: 'Charts', icon: 'graph-scatter' },
];

/** An entry's id: what the view pins, hides and counts uses by. */
export const actionId = (action: CatalogAction): string => action.id ?? action.command;

/** A graph of the Graphs tab: a command whose result opens as a chart. Opening one that already draws a chart is the same entry. */
/** The Graphs tab's categories: an icon and what the graphs in it show. */
export const graphCategories: Record<string, { icon: string; description: string }> = {
  'How it runs': { icon: 'run-all', description: 'Paths, calls and errors' },
  'How values move': { icon: 'symbol-variable', description: 'Where values come from, change and go' },
  'How it is built': { icon: 'symbol-structure', description: 'Types, overrides and imports' },
};

const g = (category: string, command: string, label: string, detail: string, info: string, keywords?: string, opensChart = false): CatalogAction => ({
  id: `graph:${command}`,
  tab: 'graphs',
  category,
  command,
  graph: !opensChart,
  label: nameOf(command, label),
  detail,
  info,
  // The old, technical name still finds it.
  keywords: `graph chart diagram ${label} ${keywords ?? ''}`.trim(),
  formerly: nameOf(command, label) !== label ? label : undefined,
  ...graphFacts[command],
});

/** What each graph starts from and, for those that can go deeper, what its levels control. */
const graphFacts: Record<string, { startsFrom: string; levels?: string }> = {
  'tsStructure.controlFlow': {
    'startsFrom': 'a function',
    'levels': 'calls expanded inside it'
  },
  'tsStructure.callGraph': {
    'startsFrom': 'a function',
    'levels': 'callers and callees'
  },
  'tsStructure.exceptionFlow': {
    'startsFrom': 'a function'
  },
  'tsStructure.promiseRejections': {
    'startsFrom': 'an async function'
  },
  'tsStructure.dataFlowDiagram': {
    'startsFrom': 'a variable, parameter or property'
  },
  'tsStructure.dependenceGraph': {
    'startsFrom': 'a function',
    'levels': 'calls expanded inside it'
  },
  'tsStructure.mutationTrackingVariable': {
    'startsFrom': 'a variable or property'
  },
  'tsStructure.argumentFlow': {
    'startsFrom': 'a parameter, or an argument in a call'
  },
  'tsStructure.reactState': {
    'startsFrom': 'a React component or hook',
    'levels': 'child components'
  },
  'tsStructure.typeHierarchy': {
    'startsFrom': 'a class or interface'
  },
  'tsStructure.overrideImpact': {
    'startsFrom': 'a method or property of a class'
  },
  'tsStructure.whoImports': {
    'startsFrom': 'the current file'
  },
  'tsStructure.dependencyPath': {
    'startsFrom': 'two files'
  }
};

/** The Charts tab: every analysis that can be drawn, by what it shows. */
const graphCatalog: CatalogAction[] = [
  g('How it runs', 'tsStructure.controlFlow', 'Control Flow Graph', 'Every path through a function',
    'The function at the cursor as a flowchart, with the Path Explorer to list, compare and filter its paths.', 'cfg paths', true),
  g('How it runs', 'tsStructure.callGraph', 'Call Graph', 'Callers and callees, levels deep',
    'Who calls the function at the cursor and what it calls, a few levels each way, as a butterfly chart.', 'callers callees butterfly', true),
  g('How it runs', 'tsStructure.exceptionFlow', 'Exception Flow Graph', 'Where errors go',
    'Where the function at the cursor throws, and where each error is caught or escapes, as a chart.', 'throw catch errors'),
  g('How it runs', 'tsStructure.promiseRejections', 'Async Rejection Graph', 'Where rejections end up',
    'The promises of an async function and where each rejection is handled or lost, as a chart.', 'async await promise'),
  g('How values move', 'tsStructure.dataFlowDiagram', 'Data Flow Graph', 'Where values come from and go',
    'The variable at the cursor in the middle, where its values come from on the left and where they go on the right.', 'dfg values', true),
  g('How values move', 'tsStructure.dependenceGraph', 'Program Dependence Graph', 'Data and control dependences',
    'The control flow chart with purple arcs from where each variable is set to where it is read, and orange arcs from each decision to what it controls.', 'pdg why', true),
  g('How values move', 'tsStructure.mutationTrackingVariable', 'Mutation Graph', 'Every change to a variable',
    'Every write to the variable at the cursor, by function, as a chart.', 'writes changes mutation'),
  g('How values move', 'tsStructure.argumentFlow', 'Argument Graph', 'Values passed to a parameter',
    'The values each call passes to the parameter at the cursor, traced back through callers, as a chart.', 'parameter callers'),
  g('How values move', 'tsStructure.reactState', 'React State Graph', 'What each state change triggers',
    'A React component or hook: props and context on the left; state, refs, memos and effects on the right, with what each sets, reads and triggers.', 'react hooks', true),
  g('How it is built', 'tsStructure.typeHierarchy', 'Inheritance Graph', 'Supertypes and subtypes',
    'What the class or interface at the cursor extends and implements, and what extends it, as a chart.', 'class interface extends implements'),
  g('How it is built', 'tsStructure.overrideImpact', 'Override Graph', 'Overrides and their callers',
    'Every override and implementation of the member at the cursor, and their callers, as a chart.', 'override method'),
  g('How it is built', 'tsStructure.whoImports', 'Importers Graph', 'Modules that import this one',
    'The modules that import this file, directly or through re-exports, as a chart.', 'dependents imports'),
  g('How it is built', 'tsStructure.dependencyPath', 'Dependency Path Graph', 'Why one module needs another',
    'The chain of imports from one module to another, as a chart.', 'import chain'),
];

/** The longest description line, so it fits a narrow sidebar without being cut off. */
export const maxDetailLength = 32;

const a = (tab: CatalogAction['tab'], category: string, command: string, label: string, detail: string, info: string, keywords?: string, icon?: string): CatalogAction => ({
  tab,
  category,
  command,
  label: nameOf(command, label),
  detail,
  info,
  // The old, technical name still finds it.
  keywords: `${label.replace(/…$/, '')} ${keywords ?? ''}`.trim(),
  formerly: nameOf(command, label) !== label ? label.replace(/…$/, '') : undefined,
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
  a('analyze', 'Values', 'tsStructure.reactState', 'React State Graph', 'What each state change triggers',
    'For a React component or hook: its props and context, and its state, refs, memos and effects, with where each is set, read, rendered and listed as a dependency, and dependencies an effect forgot.', 'react hooks useState useEffect useMemo rerender'),
  a('analyze', 'Values', 'tsStructure.raceConditions', 'Race Conditions', 'Async changes between uses',
    'Finds code where an await sits between reading a value and writing it back, so another task may change it in the meantime.', 'await concurrency'),

  a('analyze', 'Flow and errors', 'tsStructure.controlFlow', 'Control Flow Graph', 'A function as a flowchart',
    'Draws the function at the cursor as a flowchart, with a Path Explorer that lists, compares and filters every path and flags the impossible ones.', 'paths branches flowchart cfg'),
  a('analyze', 'Flow and errors', 'tsStructure.dependenceGraph', 'Program Dependence Graph', 'Data and control dependences',
    'The control flow chart with its dependences drawn on it: purple arcs from where each variable is set to where that value is read, orange arcs from each decision to the code it controls.', 'pdg data control dependence slice why'),
  a('analyze', 'Flow and errors', 'tsStructure.exceptionFlow', 'Exception Flow', 'Errors thrown, caught or lost',
    'Shows where a function throws, where each error is caught, and which catch blocks swallow errors.', 'throw catch errors'),
  a('analyze', 'Flow and errors', 'tsStructure.promiseRejections', 'Promise Rejections', 'Rejections handled or lost',
    'Finds promises whose rejections are never handled, such as calls without await or catch.', 'async promise catch'),
  a('analyze', 'Flow and errors', 'tsStructure.sideEffects', 'Side Effects', 'What a function changes',
    'Lists what the function changes besides its result: parameters, outer variables, globals, I/O and the DOM.', 'pure impure io'),

  a('analyze', 'Finding your way', 'tsStructure.semanticUsages', 'Find Usages', 'Reads, writes and calls, grouped',
    'Finds every usage of the symbol at the cursor, grouped into reads, writes, calls, imports and type references.', 'references callers'),
  a('analyze', 'Finding your way', 'tsStructure.semanticUsagesInFile', 'Find Usages in Current File', 'Usages in this file only',
    'Finds the usages of the symbol at the cursor in the current file, grouped like Find Usages.', 'references'),
  a('analyze', 'Finding your way', 'tsStructure.callGraph', 'Call Graph', 'Callers and callees, levels deep',
    'A butterfly chart of the function at the cursor: who calls it (and who calls them) on the left, what it calls (and what those call) on the right.', 'callers callees call hierarchy butterfly'),
  a('analyze', 'Finding your way', 'tsStructure.argumentFlow', 'Argument Propagation', 'Values passed to a parameter',
    'Follows a parameter back through every call to the values passed into it.', 'parameter callers values'),
  a('analyze', 'Finding your way', 'tsStructure.typeHierarchy', 'Inheritance Hierarchy', 'Supertypes, subtypes, overrides',
    'Shows what a class or interface extends and implements, what extends it, and the members they override.', 'class interface extends implements'),
  a('analyze', 'Finding your way', 'tsStructure.overrideImpact', 'Override Impact', 'What changing a member reaches',
    'Lists every override and implementation of a member, and their callers, that a change to it would reach.', 'override method'),
  a('analyze', 'Finding your way', 'tsStructure.reexportChain', 'Re-export Chain', 'A name through barrel files',
    'Follows an imported name through aliases and barrel (index) files back to its declaration.', 'import export barrel'),

  a('analyze', 'Imports', 'tsStructure.whoImports', 'Who Imports This File', 'Modules that import this one',
    'Lists the modules that import this file, directly or through re-exports.', 'dependents importers'),
  a('analyze', 'Imports', 'tsStructure.dependencyPath', 'Dependency Path…', 'Why one module needs another',
    'Shows the chain of imports that makes one module depend on another.', 'import chain'),
  a('analyze', 'Imports', 'tsStructure.findImportCycles', 'Find Import Cycles', 'Modules importing each other',
    'Finds circular imports in the project and shows each cycle.', 'circular dependency'),
  a('analyze', 'Imports', 'tsStructure.dependencyGraphDiff', 'Dependency Graph Diff…', 'Import changes since a revision',
    'Compares the import graph with a Git revision and lists the dependencies added and removed.', 'git branch compare'),

  a('analyze', 'Health check', 'tsStructure.inspectCode', 'Inspect Code…', 'Run every inspection',
    'Runs every inspection over the current file or the whole project and lists the problems found.', 'lint problems warnings'),
  a('analyze', 'Health check', 'tsStructure.auditTypeAssertions', 'Audit Type Assertions', 'Every as and !, riskiest first',
    'Lists every type assertion (as, <T> and the non-null !), ranked by how likely each is to hide a bug.', 'cast unsafe'),
  a('analyze', 'Health check', 'tsStructure.findDuplicates', 'Find Duplicates…', 'Copied code, even renamed',
    'Finds blocks of code that are copies of each other, even when variables were renamed.', 'copy paste clones'),
  a('analyze', 'Health check', 'tsStructure.deadExports', 'Dead Exports', 'Exports nothing uses',
    'Finds exports that no reachable module imports, so they can be removed.', 'unused code'),
  a('analyze', 'Health check', 'tsStructure.detectPatterns', 'Design Patterns…', 'Factories, observers and more',
    'Detects design patterns such as factories, observers, strategies, singletons and React hooks.', 'architecture react hooks'),
  a('analyze', 'Health check', 'tsStructure.mutationTracking', 'Mutation Tracking', 'Shared state this file changes',
    'Lists the functions in this file that change state shared with other code.', 'side effects state'),
  a('analyze', 'Health check', 'tsStructure.mutationTrackingProject', 'Mutation Tracking (Project)', 'Shared state changes, everywhere',
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
  a('edit', 'Quick rewrites', 'tsStructure.showRewrites', 'Show Rewrites Here', 'Rewrites for the cursor',
    'Lists the intention actions (rewrites) that apply to the code at the cursor.', 'intentions convert lightbulb', 'wand'),
  a('edit', 'Quick rewrites', 'tsStructure.chooseIntentions', 'Choose Rewrites…', 'Turn rewrites on or off',
    'Picks which rewrites the light bulb menu offers.', 'intentions settings'),
  a('edit', 'Search and replace', 'tsStructure.structuralSearch', 'Structural Search…', 'Find and replace by shape',
    'Finds code by its structure rather than its text, with placeholders, and can replace each match.', 'pattern regex replace'),
  a('edit', 'Search and replace', 'tsStructure.manageCustomInspections', 'Custom Inspections…', 'Saved patterns that warn',
    'Your saved structural search patterns, reported as problems wherever they match.', 'rules'),
  a('edit', 'Problems', 'tsStructure.nextProblem', 'Next Problem', 'Go to the next problem',
    'Moves the cursor to the next problem in this file.', 'inspection warning', 'arrow-down'),
  a('edit', 'Problems', 'tsStructure.configureInspections', 'Configure Inspections…', 'Severity of each inspection',
    'Sets how each inspection is reported (error, warning or hint), or turns it off.', 'settings severity', 'settings'),
  ...graphCatalog,
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

const known = new Set(actionCatalog.map(actionId));

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
