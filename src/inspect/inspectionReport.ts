import * as path from 'path';
import ts = require('typescript');
import { hashText, normalizePath } from '../analysis/paths';
import { ReportBuilder, ReportNode, Report, plural } from '../structure/report';
import { Finding, Inspection, fixAllEdits } from './inspection';

export interface InspectedFile {
  sourceFile: ts.SourceFile;
  findings: Finding[];
}

const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };

/** Inspect Code results: by inspection, then file, with a one-click fix where the finding has one. */
export function inspectionReport(files: readonly InspectedFile[], inspections: readonly Inspection[], root?: string): Report {
  const builder = new ReportBuilder('inspectCode', 'Inspection results');
  const relative = (sf: ts.SourceFile) => (root ? path.relative(root, sf.fileName).replace(/\\/g, '/') : path.basename(sf.fileName));
  const byInspection = new Map<string, InspectedFile[]>();
  for (const file of files) {
    for (const finding of file.findings) {
      const list = byInspection.get(finding.inspection) ?? [];
      let entry = list.find((e) => e.sourceFile === file.sourceFile);
      if (!entry) {
        entry = { sourceFile: file.sourceFile, findings: [] };
        list.push(entry);
      }
      entry.findings.push(finding);
      byInspection.set(finding.inspection, list);
    }
  }
  const total = files.reduce((n, f) => n + f.findings.length, 0);
  const roots: ReportNode[] = [...byInspection]
    .map(([id, entries]) => {
      const count = entries.reduce((n, e) => n + e.findings.length, 0);
      const worst = entries.flatMap((e) => e.findings).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0].severity;
      return {
        sortKey: severityOrder[worst],
        node: {
          label: inspections.find((i) => i.id === id)?.title ?? id,
          description: `${id} · ${plural(count, 'problem')}`,
          tooltip: `To skip one line, put // ts-structure-ignore-next-line ${id} above it; for a whole file, // ts-structure-ignore-file ${id}. Configure Inspections changes its severity or turns it off.`,
          icon: 'checklist',
          tone: worst === 'error' ? 'error' : worst === 'warning' ? 'warning' : 'info',
          expanded: byInspection.size <= 4,
          children: entries.map((entry) => {
            const fixable = fixAllEdits(entry.findings);
            return {
              label: path.basename(entry.sourceFile.fileName),
              description: `${relative(entry.sourceFile)} · ${entry.findings.length}${fixable.length ? ' · fixable' : ''}`,
              icon: 'file-code',
              expanded: entries.length <= 5,
              action: fixable.length ? { kind: 'applyFix', file: normalizePath(entry.sourceFile.fileName), hash: hashText(entry.sourceFile.text), edits: fixable, title: `Fix ${id} in ${path.basename(entry.sourceFile.fileName)}` } : undefined,
              children: entry.findings.map((finding) => {
                const fix = finding.fixes?.find((f) => f.preferred) ?? finding.fixes?.[0];
                return {
                  label: finding.message,
                  description: `line ${entry.sourceFile.getLineAndCharacterOfPosition(finding.start).line + 1}`,
                  icon: finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info',
                  tone: finding.severity === 'error' ? ('error' as const) : finding.severity === 'warning' ? ('warning' as const) : ('info' as const),
                  location: builder.span(entry.sourceFile, finding.start, finding.end),
                  action: fix ? { kind: 'applyFix', file: normalizePath(entry.sourceFile.fileName), hash: hashText(entry.sourceFile.text), edits: fix.edits, title: fix.title } : undefined,
                };
              }),
            };
          }),
        } as ReportNode,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((r) => r.node);
  const fixable = files.reduce((n, f) => n + f.findings.filter((x) => x.fixes?.length).length, 0);
  return builder.finish(roots, `${plural(total, 'problem')} in ${plural(files.filter((f) => f.findings.length).length, 'file')} (${plural(files.length, 'file')} inspected)${fixable ? `, ${fixable} with a fix` : ''}`);
}
