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
    title: 'Affected tests',
    description: 'Find and run the tests that depend on a symbol or file, and the Impacted Tests view.',
    commands: ['tsImpact.analyze', 'tsImpact.showLastResults', 'tsImpact.runImpactedTests', 'tsImpact.runTest', 'tsImpact.clear', 'tsStructure.report.runTests', 'tsImpact.analyzeFile', 'tsImpact.copyTests', 'tsImpact.analyzeChanged', 'tsImpact.openTestFiles'],
  },
  {
    id: 'refactorings',
    core: true,
    title: 'Refactorings',
    description: 'Change Signature, Safe Delete, Introduce Parameter and Move Members, with their lightbulb entries.',
    commands: ['tsStructure.changeSignature', 'tsStructure.safeDelete', 'tsStructure.safeDeleteFile', 'tsStructure.introduceParameter', 'tsStructure.moveMembers', 'tsStructure.report.safeDelete', 'tsStructure.report.safeDeleteFile', 'tsStructure.togglePreview', 'tsStructure.introduceOptionalParameter'],
  },
  {
    id: 'intentions',
    core: true,
    title: 'Quick rewrites',
    description: 'Small rewrites in the lightbulb menu, such as flipping an if or converting to a template string.',
    commands: ['tsStructure.chooseIntentions', 'tsStructure.showRewrites'],
  },
  {
    id: 'inspections',
    core: true,
    title: 'Inspections',
    description: 'Live inspections in the Problems panel, Inspect Code and Audit Type Assertions.',
    commands: ['tsStructure.inspectCode', 'tsStructure.auditTypeAssertions', 'tsStructure.report.applyFix', 'tsStructure.configureInspections', 'tsStructure.inspectionsMenu', 'tsStructure.report.applyAllFixes', 'tsStructure.toggleLiveInspections', 'tsStructure.copyProblems', 'tsStructure.nextProblem', 'tsStructure.inspectChanged', 'tsStructure.inspectOpen', 'tsStructure.toggleAssertionTests'],
  },
  {
    id: 'dataFlow',
    core: true,
    title: 'Data flow and changes',
    description: 'Data Flow Path Explorer and Mutation Tracking.',
    commands: ['tsStructure.dataFlow', 'tsStructure.mutationTracking', 'tsStructure.mutationTrackingProject', 'tsStructure.report.traceValue', 'tsStructure.report.dataFlowHere', 'tsStructure.detectPatterns', 'tsStructure.mutationTrackingVariable', 'tsStructure.raceConditions', 'tsStructure.report.flowByDirection', 'tsStructure.report.flowByFunction', 'tsStructure.report.mutationsHere', 'tsStructure.report.racesHere', 'tsStructure.dataFlowDiagram', 'tsStructure.controlFlow', 'tsStructure.explainValue', 'tsStructure.sliceBackward', 'tsStructure.sliceForward', 'tsStructure.dependenceGraph', 'tsStructure.reactState'],
  },
  {
    id: 'sideEffects',
    title: 'Side effects',
    description: 'Side-Effect Analyzer and its CodeLens.',
    commands: ['tsStructure.sideEffects', 'tsStructure.report.showSideEffects', 'tsStructure.toggleSideEffectLens', 'tsStructure.report.sideEffectsHere'],
  },
  {
    id: 'nullability',
    core: true,
    title: 'Null checks',
    description: 'Nullability Path Explorer and the "Explain why this may be undefined" action on TypeScript errors.',
    commands: ['tsStructure.nullability', 'tsStructure.report.nullabilityHere'],
  },
  {
    id: 'promiseRejections',
    title: 'Promise rejections',
    description: 'Where a function’s promise rejections are handled or lost.',
    commands: ['tsStructure.promiseRejections'],
  },
  {
    id: 'deadExports',
    title: 'Ghost exports',
    description: 'Exports and files nothing reachable from the entry points uses.',
    commands: ['tsStructure.deadExports', 'tsStructure.report.unexport', 'tsStructure.report.unexportAll', 'tsStructure.deadExportsInFolder', 'tsStructure.report.markPublic'],
  },
  {
    id: 'exceptionFlow',
    title: 'Error paths',
    description: 'Where errors are thrown, caught, transformed or swallowed.',
    commands: ['tsStructure.exceptionFlow', 'tsStructure.report.exceptionsHere'],
  },
  {
    id: 'duplicates',
    title: 'Déjà vu (copied code)',
    description: 'Find code copied with renamed variables or changed values.',
    commands: ['tsStructure.findDuplicates', 'tsStructure.report.compareDuplicates', 'tsStructure.findDuplicatesInFolder'],
  },
  {
    id: 'usages',
    core: true,
    title: 'Find usages',
    description: 'References grouped by reads, writes, calls, imports, types and JSX.',
    commands: ['tsStructure.semanticUsages', 'tsStructure.report.findUsages', 'tsStructure.semanticUsagesInFile', 'tsStructure.report.usagesHere', 'tsStructure.callGraph'],
  },
  {
    id: 'reexports',
    title: 'Re-export trail',
    description: 'Follow a name through aliases and barrel files.',
    commands: ['tsStructure.reexportChain'],
  },
  {
    id: 'structuralSearch',
    title: 'Search by shape',
    description: 'Search and replace code by shape, and build custom inspections.',
    commands: ['tsStructure.structuralSearch', 'tsStructure.manageCustomInspections', 'tsStructure.editCustomInspection', 'tsStructure.disableCustomInspection', 'tsStructure.structuralSearchInFolder'],
  },
  {
    id: 'hierarchy',
    title: 'Family tree and override reach',
    description: 'Supertypes, subtypes and overrides, and what a change to a member reaches.',
    commands: ['tsStructure.typeHierarchy', 'tsStructure.overrideImpact', 'tsStructure.report.showHierarchy', 'tsStructure.report.overrideImpact'],
  },
  {
    id: 'dependencyPath',
    title: 'Why this import',
    description: 'Why one module depends on another.',
    commands: ['tsStructure.dependencyPath', 'tsStructure.report.swapDependency', 'tsStructure.findImportCycles', 'tsStructure.whoImports'],
  },
  {
    id: 'graphDiff',
    title: 'Import changes',
    description: 'How imports changed since a Git revision.',
    commands: ['tsStructure.dependencyGraphDiff', 'tsStructure.report.compareRevision'],
  },
  {
    id: 'argumentFlow',
    title: 'Arguments passed in',
    description: 'Where a parameter’s values come from and where they go.',
    commands: ['tsStructure.argumentFlow', 'tsStructure.report.traceDeeper', 'tsStructure.report.argumentsHere'],
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
