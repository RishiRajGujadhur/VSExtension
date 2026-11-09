/** Analyses worth running next on the same symbol, offered in a Next group at the end of each report kind. */
export const relatedAnalyses: Record<string, { command: string; title: string }[]> = {};

relatedAnalyses.dataFlow = [
  { command: 'tsStructure.mutationTrackingVariable', title: 'Who changes it, and when (Mutation Tracking for This Variable)' },
  { command: 'tsStructure.nullability', title: 'Can it be null or undefined? (Nullability)' },
  { command: 'tsStructure.argumentFlow', title: 'What values can it receive? (Argument Propagation)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage (Find Usages)' },
];

relatedAnalyses.nullability = [
  { command: 'tsStructure.dataFlow', title: 'Where does it come from? (Data Flow)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage (Find Usages)' },
];

relatedAnalyses.sideEffects = [
  { command: 'tsStructure.exceptionFlow', title: 'What can it throw? (Exception Flow)' },
  { command: 'tsStructure.mutationTracking', title: 'Who else changes shared state in this file? (Mutation Tracking)' },
  { command: 'tsStructure.semanticUsages', title: 'Who calls it? (Find Usages)' },
];

relatedAnalyses.rejections = [
  { command: 'tsStructure.exceptionFlow', title: 'What it throws synchronously (Exception Flow)' },
  { command: 'tsStructure.sideEffects', title: 'What else it does (Side Effects)' },
];

relatedAnalyses.exceptions = [
  { command: 'tsStructure.promiseRejections', title: 'Where its rejections go (Promise Rejections)' },
  { command: 'tsStructure.sideEffects', title: 'What else it does (Side Effects)' },
  { command: 'tsStructure.semanticUsages', title: 'Who calls it? (Find Usages)' },
];

relatedAnalyses.argumentFlow = [
  { command: 'tsStructure.dataFlow', title: 'Its whole data flow (Data Flow)' },
  { command: 'tsStructure.nullability', title: 'Can it be undefined? (Nullability)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage (Find Usages)' },
];

relatedAnalyses.hierarchy = [
  { command: 'tsStructure.overrideImpact', title: 'What changing a member reaches (Override Impact)' },
  { command: 'tsStructure.semanticUsages', title: 'Where the type is used (Find Usages)' },
];

relatedAnalyses.overrideImpact = [
  { command: 'tsStructure.typeHierarchy', title: 'The whole hierarchy (Inheritance Hierarchy)' },
  { command: 'tsStructure.semanticUsages', title: 'Every call (Find Usages)' },
  { command: 'tsImpact.analyze', title: 'Tests to run after the change (Test Impact)' },
];

relatedAnalyses.reexports = [
  { command: 'tsStructure.semanticUsages', title: 'Every usage under any name (Find Usages)' },
  { command: 'tsStructure.whoImports', title: 'Which files import this one' },
];

relatedAnalyses.usages = [
  { command: 'tsStructure.dataFlow', title: 'How the value moves (Data Flow)' },
  { command: 'tsStructure.reexportChain', title: 'Which paths it is imported through (Re-export Chain)' },
  { command: 'tsImpact.analyze', title: 'Tests that use it (Test Impact)' },
];

relatedAnalyses.mutations = [
  { command: 'tsStructure.mutationTrackingVariable', title: 'Only the variable at the cursor (Mutation Tracking for This Variable)' },
  { command: 'tsStructure.sideEffects', title: 'Everything the function at the cursor does (Side Effects)' },
  { command: 'tsStructure.mutationTrackingProject', title: 'Mutations across the project' },
];

relatedAnalyses.variableMutations = [
  { command: 'tsStructure.raceConditions', title: 'Can async code interleave? (Race Conditions)' },
  { command: 'tsStructure.dataFlow', title: 'Where its values come from (Data Flow)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage (Find Usages)' },
];

relatedAnalyses.callGraph = [
  { command: 'tsStructure.controlFlow', title: 'Every path through the function (Control Flow Graph)' },
  { command: 'tsStructure.sideEffects', title: 'What else it does (Side Effects)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage, not only calls (Find Usages)' },
];

relatedAnalyses.reactState = [
  { command: 'tsStructure.dataFlow', title: 'Where a value comes from and goes (Data Flow)' },
  { command: 'tsStructure.raceConditions', title: 'Async code changing state at the wrong time (Race Conditions)' },
  { command: 'tsStructure.callGraph', title: 'Who renders this component (Call Graph)' },
];

relatedAnalyses.explainValue = [
  { command: 'tsStructure.controlFlow', title: 'Every path through the function (Control Flow Graph)' },
  { command: 'tsStructure.dataFlow', title: 'Where the value goes next (Data Flow)' },
];

relatedAnalyses.races = [
  { command: 'tsStructure.mutationTrackingVariable', title: 'Every change to it (Mutation Tracking for This Variable)' },
  { command: 'tsStructure.dataFlow', title: 'Its whole data flow (Data Flow)' },
];
