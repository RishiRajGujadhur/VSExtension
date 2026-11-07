/** Analyses worth running next on the same symbol, offered in a Next group at the end of each report kind. */
export const relatedAnalyses: Record<string, { command: string; title: string }[]> = {};

relatedAnalyses.dataFlow = [
  { command: 'tsStructure.nullability', title: 'Can it be null or undefined? (Nullability)' },
  { command: 'tsStructure.argumentFlow', title: 'What values can it receive? (Argument Propagation)' },
  { command: 'tsStructure.semanticUsages', title: 'Every usage (Find Usages)' },
];
