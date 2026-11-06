/**
 * One codicon per feature command, used wherever the command is offered: its package.json icon,
 * Analyze or Refactor This, Choose Features and the results view. No two features share one, and
 * row buttons that run a feature's analysis use that feature's icon.
 */
export const commandIcons: Record<string, string> = {
  'tsImpact.analyze': 'beaker',
  'tsStructure.changeSignature': 'symbol-method',
  'tsStructure.safeDelete': 'trash',
  'tsStructure.introduceParameter': 'symbol-parameter',
  'tsStructure.moveMembers': 'file-symlink-file',
  'tsStructure.chooseIntentions': 'wand',
  'tsStructure.inspectCode': 'checklist',
  'tsStructure.auditTypeAssertions': 'shield',
  'tsStructure.dataFlow': 'pulse',
  'tsStructure.detectPatterns': 'library',
  'tsStructure.mutationTracking': 'diff-modified',
  'tsStructure.mutationTrackingProject': 'project',
  'tsStructure.sideEffects': 'zap',
  'tsStructure.nullability': 'circle-slash',
  'tsStructure.promiseRejections': 'debug-disconnect',
  'tsStructure.deadExports': 'export',
  'tsStructure.exceptionFlow': 'flame',
  'tsStructure.findDuplicates': 'files',
  'tsStructure.semanticUsages': 'references',
  'tsStructure.semanticUsagesInFile': 'go-to-file',
  'tsStructure.reexportChain': 'link',
  'tsStructure.structuralSearch': 'symbol-structure',
  'tsStructure.manageCustomInspections': 'symbol-ruler',
  'tsStructure.typeHierarchy': 'type-hierarchy',
  'tsStructure.overrideImpact': 'type-hierarchy-sub',
  'tsStructure.dependencyPath': 'git-merge',
  'tsStructure.findImportCycles': 'sync',
  'tsStructure.whoImports': 'arrow-circle-up',
  'tsStructure.dependencyGraphDiff': 'git-compare',
  'tsStructure.argumentFlow': 'call-incoming',
};

/** Commands that run another feature's analysis from a result row share its icon. */
export const rowCommandFeatures: Record<string, string> = {
  'tsStructure.report.showSideEffects': 'tsStructure.sideEffects',
  'tsStructure.report.findUsages': 'tsStructure.semanticUsages',
  'tsStructure.report.showHierarchy': 'tsStructure.typeHierarchy',
  'tsStructure.report.overrideImpact': 'tsStructure.overrideImpact',
  'tsStructure.report.safeDelete': 'tsStructure.safeDelete',
  'tsStructure.report.safeDeleteFile': 'tsStructure.safeDelete',
  'tsStructure.report.compareRevision': 'tsStructure.dependencyGraphDiff',
  'tsStructure.report.usagesHere': 'tsStructure.semanticUsages',
  'tsStructure.report.dataFlowHere': 'tsStructure.dataFlow',
};

/** The icon of each report kind, for the history list and messages about a report. */
export const reportIcons: Record<string, string> = {
  dataFlow: commandIcons['tsStructure.dataFlow'],
  patterns: commandIcons['tsStructure.detectPatterns'],
  mutations: commandIcons['tsStructure.mutationTracking'],
  sideEffects: commandIcons['tsStructure.sideEffects'],
  nullability: commandIcons['tsStructure.nullability'],
  rejections: commandIcons['tsStructure.promiseRejections'],
  deadExports: commandIcons['tsStructure.deadExports'],
  exceptions: commandIcons['tsStructure.exceptionFlow'],
  duplicates: commandIcons['tsStructure.findDuplicates'],
  usages: commandIcons['tsStructure.semanticUsages'],
  reexports: commandIcons['tsStructure.reexportChain'],
  structuralSearch: commandIcons['tsStructure.structuralSearch'],
  hierarchy: commandIcons['tsStructure.typeHierarchy'],
  overrideImpact: commandIcons['tsStructure.overrideImpact'],
  dependencyPath: commandIcons['tsStructure.dependencyPath'],
  cycles: commandIcons['tsStructure.findImportCycles'],
  dependents: commandIcons['tsStructure.whoImports'],
  graphDiff: commandIcons['tsStructure.dependencyGraphDiff'],
  argumentFlow: commandIcons['tsStructure.argumentFlow'],
  inspectCode: commandIcons['tsStructure.inspectCode'],
  assertionAudit: commandIcons['tsStructure.auditTypeAssertions'],
};

/** A feature's icon: the refactorings as a group get a wrench, the others the icon of their first command. */
export function featureIcon(feature: { id: string; commands: readonly string[] }): string {
  return feature.id === 'refactorings' ? 'wrench' : (feature.commands.map((c) => commandIcons[c]).find(Boolean) ?? 'symbol-misc');
}
