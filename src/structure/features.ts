/** A part of the extension that can be turned off with `tsStructure.features.<id>`. */
export interface Feature {
  id: string;
  title: string;
  description: string;
  /** Commands that belong to the feature: hidden from menus and refused while it is off. */
  commands: string[];
  /** On by default. The rest are turned on in the settings or with Choose Features, so a first look isn't overwhelming. */
  core?: boolean;
}

export const features: Feature[] = [
  {
    id: 'testImpact',
    core: true,
    title: 'Test Impact Analysis',
    description: 'Find and run the tests that depend on a symbol or file, and the Impacted Tests view.',
    commands: ['tsImpact.analyze', 'tsImpact.showLastResults', 'tsImpact.runImpactedTests', 'tsImpact.runTest', 'tsImpact.clear', 'tsStructure.report.runTests', 'tsImpact.analyzeFile'],
  },
  {
    id: 'refactorings',
    core: true,
    title: 'Refactorings',
    description: 'Change Signature, Safe Delete, Introduce Parameter and Move Members, with their lightbulb entries.',
    commands: ['tsStructure.changeSignature', 'tsStructure.safeDelete', 'tsStructure.safeDeleteFile', 'tsStructure.introduceParameter', 'tsStructure.moveMembers', 'tsStructure.report.safeDelete', 'tsStructure.report.safeDeleteFile'],
  },
  {
    id: 'intentions',
    core: true,
    title: 'Intention Actions',
    description: 'Small rewrites in the lightbulb menu, such as flipping an if or converting to a template string.',
    commands: ['tsStructure.chooseIntentions'],
  },
  {
    id: 'inspections',
    core: true,
    title: 'Inspections',
    description: 'Live inspections in the Problems panel, Inspect Code and Audit Type Assertions.',
    commands: ['tsStructure.inspectCode', 'tsStructure.auditTypeAssertions', 'tsStructure.report.applyFix', 'tsStructure.configureInspections', 'tsStructure.inspectionsMenu'],
  },
  {
    id: 'dataFlow',
    core: true,
    title: 'Data Flow and Mutation Tracking',
    description: 'Data Flow Path Explorer and Mutation Tracking.',
    commands: ['tsStructure.dataFlow', 'tsStructure.mutationTracking', 'tsStructure.mutationTrackingProject', 'tsStructure.report.traceValue'],
  },
  {
    id: 'sideEffects',
    title: 'Side-Effect Analyzer',
    description: 'Side-Effect Analyzer and its CodeLens.',
    commands: ['tsStructure.sideEffects', 'tsStructure.report.showSideEffects', 'tsStructure.toggleSideEffectLens'],
  },
  {
    id: 'nullability',
    core: true,
    title: 'Nullability Path Explorer',
    description: 'Nullability Path Explorer and the "Explain why this may be undefined" action on TypeScript errors.',
    commands: ['tsStructure.nullability'],
  },
  {
    id: 'promiseRejections',
    title: 'Promise Rejection Analyzer',
    description: 'Where a function’s promise rejections are handled or lost.',
    commands: ['tsStructure.promiseRejections'],
  },
  {
    id: 'deadExports',
    title: 'Dead Export Analyzer',
    description: 'Exports and files nothing reachable from the entry points uses.',
    commands: ['tsStructure.deadExports', 'tsStructure.report.unexport', 'tsStructure.report.unexportAll', 'tsStructure.deadExportsInFolder'],
  },
  {
    id: 'exceptionFlow',
    title: 'Exception Flow Visualizer',
    description: 'Where errors are thrown, caught, transformed or swallowed.',
    commands: ['tsStructure.exceptionFlow'],
  },
  {
    id: 'duplicates',
    title: 'Structural Duplicates',
    description: 'Find code copied with renamed variables or changed values.',
    commands: ['tsStructure.findDuplicates', 'tsStructure.report.compareDuplicates', 'tsStructure.findDuplicatesInFolder'],
  },
  {
    id: 'usages',
    core: true,
    title: 'Semantic Find Usages',
    description: 'References grouped by reads, writes, calls, imports, types and JSX.',
    commands: ['tsStructure.semanticUsages', 'tsStructure.report.findUsages'],
  },
  {
    id: 'reexports',
    title: 'Re-export Chain Navigator',
    description: 'Follow a name through aliases and barrel files.',
    commands: ['tsStructure.reexportChain'],
  },
  {
    id: 'structuralSearch',
    title: 'Structural Search and Replace',
    description: 'Search and replace code by shape, and build custom inspections.',
    commands: ['tsStructure.structuralSearch', 'tsStructure.manageCustomInspections', 'tsStructure.editCustomInspection', 'tsStructure.disableCustomInspection'],
  },
  {
    id: 'hierarchy',
    title: 'Inheritance Hierarchy and Override Impact',
    description: 'Supertypes, subtypes and overrides, and what a change to a member reaches.',
    commands: ['tsStructure.typeHierarchy', 'tsStructure.overrideImpact', 'tsStructure.report.showHierarchy', 'tsStructure.report.overrideImpact'],
  },
  {
    id: 'dependencyPath',
    title: 'Dependency Path Finder',
    description: 'Why one module depends on another.',
    commands: ['tsStructure.dependencyPath', 'tsStructure.report.swapDependency'],
  },
  {
    id: 'graphDiff',
    title: 'Dependency Graph Diff',
    description: 'How imports changed since a Git revision.',
    commands: ['tsStructure.dependencyGraphDiff', 'tsStructure.report.compareRevision'],
  },
  {
    id: 'argumentFlow',
    title: 'Argument Propagation Explorer',
    description: 'Where a parameter’s values come from and where they go.',
    commands: ['tsStructure.argumentFlow'],
  },
];

const byCommand = new Map(features.flatMap((f) => f.commands.map((c) => [c, f] as const)));

/** The feature a command belongs to; undefined for commands that are always available, such as the results view's. */
export function featureOf(command: string): Feature | undefined {
  return byCommand.get(command);
}

/** The when-clause key that is true while the feature is on. */
export function featureWhen(feature: Feature): string {
  return `config.tsStructure.features.${feature.id}`;
}

/** Whether the feature is on when the settings don't say. */
export function enabledByDefault(feature: Feature): boolean {
  return feature.core === true;
}
