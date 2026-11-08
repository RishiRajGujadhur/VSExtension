/** Every action the sidebar's Actions view offers, by tab and category, with words people may search for. */
export interface CatalogAction {
  command: string;
  label: string;
  detail: string;
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

const a = (tab: CatalogAction['tab'], category: string, command: string, label: string, detail: string, keywords?: string, icon?: string): CatalogAction => ({ tab, category, command, label, detail, keywords, icon });

export const actionCatalog: CatalogAction[] = [
  a('analyze', 'Values', 'tsStructure.dataFlow', 'Data Flow', 'Where a value comes from and where it goes', 'trace variable assignments'),
  a('analyze', 'Values', 'tsStructure.explainValue', 'Explain Value Path', 'Every value a variable can have here, and why', 'why condition'),
  a('analyze', 'Values', 'tsStructure.nullability', 'Nullability', 'Which paths make a value null or undefined', 'null undefined optional'),
  a('analyze', 'Values', 'tsStructure.sliceBackward', 'What Affects This Value', 'The statements and decisions it depends on', 'backward slice dependencies'),
  a('analyze', 'Values', 'tsStructure.sliceForward', 'What This Value Affects', 'Everything it flows into or decides', 'forward slice impact'),
  a('analyze', 'Values', 'tsStructure.mutationTrackingVariable', 'Mutation Tracking for This Variable', 'Every change to it, and whether it runs after an await', 'writes changes'),
  a('analyze', 'Values', 'tsStructure.raceConditions', 'Race Conditions', 'Async code changing it between a read and a write', 'await concurrency'),

  a('analyze', 'Control flow and errors', 'tsStructure.controlFlow', 'Control Flow Graph', 'A function as a flowchart, with every path through it', 'paths branches flowchart cfg'),
  a('analyze', 'Control flow and errors', 'tsStructure.exceptionFlow', 'Exception Flow', 'Where errors are thrown, caught or swallowed', 'throw catch errors'),
  a('analyze', 'Control flow and errors', 'tsStructure.promiseRejections', 'Promise Rejections', 'Where rejections are handled or lost', 'async promise catch'),
  a('analyze', 'Control flow and errors', 'tsStructure.sideEffects', 'Side Effects', 'What a function changes besides its result', 'pure impure io'),

  a('analyze', 'Navigate', 'tsStructure.semanticUsages', 'Find Usages', 'Reads, writes, calls, imports and types, grouped', 'references callers'),
  a('analyze', 'Navigate', 'tsStructure.semanticUsagesInFile', 'Find Usages in Current File', 'The same, only in this file', 'references'),
  a('analyze', 'Navigate', 'tsStructure.argumentFlow', 'Argument Propagation', 'Where a parameter’s values come from', 'parameter callers values'),
  a('analyze', 'Navigate', 'tsStructure.typeHierarchy', 'Inheritance Hierarchy', 'Supertypes, subtypes and overrides', 'class interface extends implements'),
  a('analyze', 'Navigate', 'tsStructure.overrideImpact', 'Override Impact', 'What changing a member reaches', 'override method'),
  a('analyze', 'Navigate', 'tsStructure.reexportChain', 'Re-export Chain', 'A name through aliases and barrel files', 'import export barrel'),

  a('analyze', 'Modules', 'tsStructure.whoImports', 'Who Imports This File', 'Modules that depend on this one', 'dependents importers'),
  a('analyze', 'Modules', 'tsStructure.dependencyPath', 'Dependency Path…', 'Why one module depends on another', 'import chain'),
  a('analyze', 'Modules', 'tsStructure.findImportCycles', 'Find Import Cycles', 'Modules that import each other', 'circular dependency'),
  a('analyze', 'Modules', 'tsStructure.dependencyGraphDiff', 'Dependency Graph Diff…', 'How imports changed since a Git revision', 'git branch compare'),

  a('analyze', 'Project health', 'tsStructure.inspectCode', 'Inspect Code…', 'Every inspection over a file or the project', 'lint problems warnings'),
  a('analyze', 'Project health', 'tsStructure.auditTypeAssertions', 'Audit Type Assertions', 'Every as, <T> and !, riskiest first', 'cast unsafe'),
  a('analyze', 'Project health', 'tsStructure.findDuplicates', 'Find Duplicates…', 'Copies of code with renamed variables', 'copy paste clones'),
  a('analyze', 'Project health', 'tsStructure.deadExports', 'Dead Exports', 'Exports nothing reachable uses', 'unused code'),
  a('analyze', 'Project health', 'tsStructure.detectPatterns', 'Design Patterns…', 'Factories, observers, strategies and more', 'architecture react hooks'),
  a('analyze', 'Project health', 'tsStructure.mutationTracking', 'Mutation Tracking', 'Functions that change shared state in this file', 'side effects state'),
  a('analyze', 'Project health', 'tsStructure.mutationTrackingProject', 'Mutation Tracking (Project)', 'The same across the project', 'state'),

  a('analyze', 'Tests', 'tsImpact.analyze', 'Test Impact', 'Tests that depend on the symbol or file', 'which tests run'),
  a('analyze', 'Tests', 'tsImpact.analyzeChanged', 'Test Impact of Changed Files', 'Tests for every uncommitted change', 'git diff tests'),

  a('edit', 'Refactor', 'tsStructure.changeSignature', 'Change Signature…', 'Rename, add, remove or reorder parameters everywhere', 'parameters arguments rename'),
  a('edit', 'Refactor', 'tsStructure.introduceParameter', 'Introduce Parameter…', 'Turn the selected expression into a parameter', 'extract argument'),
  a('edit', 'Refactor', 'tsStructure.moveMembers', 'Move Members to Module…', 'Move declarations to another file, fixing imports', 'move file'),
  a('edit', 'Refactor', 'tsStructure.safeDelete', 'Safe Delete…', 'Delete after checking every usage', 'remove'),
  a('edit', 'Rewrite', 'tsStructure.showRewrites', 'Show Rewrites Here', 'Intention actions for the code at the cursor', 'intentions convert lightbulb', 'wand'),
  a('edit', 'Rewrite', 'tsStructure.chooseIntentions', 'Choose Rewrites…', 'Turn individual rewrites on or off', 'intentions settings'),
  a('edit', 'Search and replace', 'tsStructure.structuralSearch', 'Structural Search…', 'Find and replace code by its shape', 'pattern regex replace'),
  a('edit', 'Search and replace', 'tsStructure.manageCustomInspections', 'Custom Inspections…', 'Your saved search patterns that report problems', 'rules'),
  a('edit', 'Problems', 'tsStructure.nextProblem', 'Next Problem', 'Go to the next problem in this file', 'inspection warning', 'arrow-down'),
  a('edit', 'Problems', 'tsStructure.configureInspections', 'Configure Inspections…', 'Severity of each inspection, or turn it off', 'settings severity', 'settings'),
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
