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
