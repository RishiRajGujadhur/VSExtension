import * as path from 'path';
import * as ts from 'typescript';
import { hashText, normalizePath } from '../analysis/paths';
import { ReportBuilder, ReportNode, Report, plural, shorten } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import { InspectionOptions, runInspections } from './inspection';
import { typeAssertions } from './typeAssertions';

/** Riskiest first. */
const categories = ['Unsafe', 'Unchecked narrowing', 'Unverified', 'Non-null on a nullable value', 'Widening', 'Unnecessary'];

const categoryInfo: Record<string, { icon: string; tone?: ReportNode['tone']; hint: string }> = {
  Unsafe: { icon: 'error', tone: 'error', hint: "as any and double assertions: the compiler checks nothing" },
  'Unchecked narrowing': { icon: 'warning', tone: 'warning', hint: 'assumes a more specific type without a runtime check' },
  Unverified: { icon: 'warning', tone: 'warning', hint: "asserts an 'any' value, such as JSON.parse()" },
  'Non-null on a nullable value': { icon: 'circle-slash', tone: 'info', hint: 'throws on the next access if the value is missing' },
  Widening: { icon: 'info', tone: 'info', hint: "safe, but 'satisfies' keeps more type information" },
  Unnecessary: { icon: 'circle-outline', hint: 'the value already has the type' },
};

/** Audit Type Assertions: every assertion in the files, grouped from riskiest to harmless. */
export function assertionAuditReport(program: ts.Program, files: readonly ts.SourceFile[], options?: InspectionOptions, root?: string): Report {
  const builder = new ReportBuilder('assertionAudit', 'Type assertions in the project');
  const checker = program.getTypeChecker();
  const groups = new Map<string, ReportNode[]>();
  for (const sourceFile of files) {
    for (const finding of runInspections([typeAssertions], { sourceFile, program, checker, options })) {
      const category = finding.category ?? 'Other';
      const { line } = sourceFile.getLineAndCharacterOfPosition(finding.start);
      const fix = finding.fixes?.find((f) => f.preferred) ?? finding.fixes?.[0];
      groups.set(category, [
        ...(groups.get(category) ?? []),
        {
          label: shorten(sourceFile.text.split(/\r?\n/)[line].trim(), 70),
          description: `${root ? path.relative(root, sourceFile.fileName).replace(/\\/g, '/') : path.basename(sourceFile.fileName)}:${line + 1}`,
          tooltip: finding.message,
          icon: categoryInfo[category]?.icon ?? 'info',
          tone: categoryInfo[category]?.tone,
          location: builder.span(sourceFile, finding.start, finding.end),
          action: fix ? { kind: 'applyFix', file: normalizePath(sourceFile.fileName), hash: hashText(sourceFile.text), edits: fix.edits, title: fix.title } : undefined,
        },
      ]);
    }
  }
  const roots: ReportNode[] = [...groups]
    .sort(([a], [b]) => (categories.indexOf(a) + 1 || 99) - (categories.indexOf(b) + 1 || 99))
    .map(([category, rows]) => ({
      label: category,
      description: `${rows.length} · ${categoryInfo[category]?.hint ?? ''}`,
      icon: categoryInfo[category]?.icon ?? 'info',
      tone: categoryInfo[category]?.tone,
      expanded: categoryInfo[category]?.tone === 'error' || categoryInfo[category]?.tone === 'warning',
      children: rows,
    }));
  const total = roots.reduce((n, r) => n + r.children!.length, 0);
  const risky = roots.filter((r) => r.tone === 'error' || r.tone === 'warning').reduce((n, r) => n + r.children!.length, 0);
  if (risky > 0) {
    roots.push(
      howToFix([
        'Replace as with a check that proves the type: typeof, instanceof, \'key\' in value, or a type guard function.',
        'Validate parsed data (JSON.parse, fetch().json()) with a schema or a hand-written guard before giving it a type.',
        'Use satisfies instead of as to check an object literal against a type without losing its precise type.',
        'Replace value! with a check, or with ?. and ?? when a missing value is acceptable.',
      ]),
    );
  }
  return builder.finish(roots, `${plural(total, 'assertion')}, ${risky} unchecked or unsafe, in ${plural(files.length, 'file')}`);
}
