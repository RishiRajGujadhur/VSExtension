import * as path from 'path';
import * as ts from 'typescript';
import { discoverTests } from '../analysis/testDiscovery';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, codeContext, lineSnippet, plural } from '../structure/report';
import { accessExpression, enclosingFunction, functionLabel, identifierAt, isTypePosition, referencesAt, skipParentheses, symbolAt, writeOf } from '../structure/util';

export type UsageKind = 'definition' | 'import' | 'export' | 'write' | 'call' | 'jsx' | 'inheritance' | 'type' | 'read';

const order: { kind: UsageKind; label: string; icon: string }[] = [
  { kind: 'definition', label: 'Definitions', icon: 'symbol-class' },
  { kind: 'call', label: 'Calls', icon: 'symbol-method' },
  { kind: 'jsx', label: 'JSX usages', icon: 'symbol-namespace' },
  { kind: 'write', label: 'Writes', icon: 'edit' },
  { kind: 'read', label: 'Reads', icon: 'eye' },
  { kind: 'inheritance', label: 'Extended or implemented', icon: 'type-hierarchy-sub' },
  { kind: 'type', label: 'Type references', icon: 'symbol-interface' },
  { kind: 'import', label: 'Imports', icon: 'package' },
  { kind: 'export', label: 'Exports and re-exports', icon: 'export' },
];

/**
 * What a reference does with the symbol, from the syntax around it. `ofProperty` says the symbol is a property,
 * so `const { price } = book` reads it rather than declaring it.
 */
export function classifyUsage(node: ts.Node, ofProperty = false): UsageKind {
  const parent = node.parent;
  if (ofProperty && ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node) {
    return 'read';
  }
  for (let current: ts.Node | undefined = parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current)) {
      return 'import';
    }
    if (ts.isExportDeclaration(current) || (ts.isExportAssignment(current) && current.expression === node)) {
      return 'export';
    }
    if (ts.isStatement(current) || ts.isExpression(current)) {
      break;
    }
  }
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node) {
    return 'jsx';
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return 'jsx';
  }
  if ((parent as ts.NamedDeclaration).name === node && !ts.isPropertyAccessExpression(parent)) {
    return ts.isShorthandPropertyAssignment(parent) ? 'read' : 'definition';
  }
  const heritage = ts.isExpressionWithTypeArguments(parent) ? parent.parent : undefined;
  if (heritage && ts.isHeritageClause(heritage)) {
    return 'inheritance';
  }
  if (isTypePosition(node) || ts.isTypeQueryNode(parent)) {
    return 'type';
  }
  const expression = accessExpression(node);
  const outer = skipParentheses(expression);
  const outerParent = outer.parent;
  if ((ts.isCallExpression(outerParent) || ts.isNewExpression(outerParent)) && outerParent.expression === outer) {
    return 'call';
  }
  if ((ts.isTaggedTemplateExpression(outerParent) && outerParent.tag === outer) || ts.isDecorator(outerParent)) {
    return 'call';
  }
  if (writeOf(expression)) {
    return 'write';
  }
  return 'read';
}

/** Semantic Find Usages: references grouped by reads, writes, calls, imports, type references and JSX. */
export function semanticUsagesReport(project: VirtualProject, fileName: string, offset: number, root?: string): Report {
  const sourceFile = project.sourceFile(fileName);
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a symbol to find its usages.');
  const references = referencesAt(project.service, fileName, identifier.getStart());
  const symbol = symbolAt(project.program().getTypeChecker(), identifier);
  const ofProperty = !!symbol && !!(symbol.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor));
  const builder = new ReportBuilder('usages', `Usages of ${identifier.text}`);
  const testFiles = new Map<ts.SourceFile, boolean>();
  const isTest = (sf: ts.SourceFile) => {
    if (!testFiles.has(sf)) {
      testFiles.set(sf, discoverTests(sf).isTestFile);
    }
    return testFiles.get(sf)!;
  };
  const byKind = new Map<UsageKind, ts.Node[]>();
  for (const reference of references) {
    const kind = classifyUsage(reference, ofProperty);
    byKind.set(kind, [...(byKind.get(kind) ?? []), reference]);
  }
  // Only declared, imported or forwarded: nothing actually uses it.
  const unused = [...byKind.keys()].every((kind) => kind === 'definition' || kind === 'import' || kind === 'export');
  if (unused) {
    builder.warnings.push(`${identifier.text} is never used: it is only declared${byKind.has('import') || byKind.has('export') ? ', imported or re-exported' : ''}. Use the trash button on its definition to delete it safely.`);
  }
  const roots: ReportNode[] = [];
  for (const { kind, label, icon } of order) {
    const nodes = byKind.get(kind);
    if (!nodes?.length) {
      continue;
    }
    const byFile = new Map<ts.SourceFile, ts.Node[]>();
    for (const node of nodes) {
      byFile.set(node.getSourceFile(), [...(byFile.get(node.getSourceFile()) ?? []), node]);
    }
    const tests = nodes.filter((n) => isTest(n.getSourceFile())).length;
    roots.push({
      label,
      description: `${nodes.length}${tests ? ` (${tests} in tests)` : ''}`,
      icon,
      expanded: kind !== 'import' && kind !== 'export',
      children: [...byFile].map(([sf, list]) => ({
        label: path.basename(sf.fileName),
        description: `${root ? path.relative(root, path.dirname(sf.fileName)).replace(/\\/g, '/') || '.' : ''}${isTest(sf) ? ' · test' : ''} · ${list.length}`,
        icon: isTest(sf) ? 'beaker' : 'file-code',
        expanded: byFile.size <= 6,
        children: list.map((node) => ({
          label: lineSnippet(node),
          description: `${functionLabel(enclosingFunction(node))} · line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}${node === identifier ? ' · at cursor' : ''}`,
          tooltip: codeContext(node),
          focus: node === identifier || undefined,
          action: unused && kind === 'definition' ? { kind: 'deadExport' } : undefined,
          icon,
          role: kind === 'write' ? ('write' as const) : kind === 'definition' ? ('definition' as const) : ('read' as const),
          location: builder.at(node),
        })),
      })),
    });
  }
  const counts = order
    .filter((o) => byKind.get(o.kind)?.length)
    .map((o) => {
      const word = o.label.toLowerCase().split(' ')[0];
      return plural(byKind.get(o.kind)!.length, word.replace(/s$/, ''), word);
    });
  return builder.finish(roots, `${plural(references.length, 'usage')}: ${counts.join(', ')}`);
}
