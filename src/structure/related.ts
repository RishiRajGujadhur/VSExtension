/** Analyses worth running next on the same symbol, offered in a Next group at the end of each report kind. */
export const relatedAnalyses: Record<string, { command: string; title: string }[]> = {};

relatedAnalyses.dataFlow = [
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
