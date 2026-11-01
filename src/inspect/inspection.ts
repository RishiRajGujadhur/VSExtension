import * as ts from 'typescript';
import { TextEdit } from '../intentions/intentions';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Fix {
  title: string;
  edits: TextEdit[];
  /** Offered first in the lightbulb. */
  preferred?: boolean;
}

/** A problem an inspection found in one file. Offsets refer to the inspected text. */
export interface Finding {
  inspection: string;
  message: string;
  start: number;
  end: number;
  severity: Severity;
  /** Rendered faded, like unused code. */
  unnecessary?: boolean;
  fixes?: Fix[];
  /** Other places that explain the finding, such as the helper that drops a promise. */
  related?: { message: string; node: ts.Node }[];
  /** A finer classification within the inspection, such as `Unchecked narrowing`, for grouping. */
  category?: string;
  /** An analysis that explains the finding, run with the cursor at `offset`. */
  explain?: { title: string; command: string; offset: number };
}

export interface InspectionContext {
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  options?: InspectionOptions;
}

/** User settings that tune individual inspections. */
export interface InspectionOptions {
  /** Calls whose promises may be dropped on purpose, such as `track` or `logger.*`. */
  missingAwaitIgnore?: string[];
  /** Skip type assertions in test files, where mocks and fixtures often need them. */
  typeAssertionIgnoreTests?: boolean;
}

export interface Inspection {
  id: string;
  title: string;
  defaultSeverity: Severity;
  run(context: InspectionContext): Finding[];
}

/** `// ts-structure-ignore-next-line` or `// ts-structure-ignore-next-line missingAwait, typeAssertion` */
const ignorePattern = /\/\/\s*ts-structure-ignore-next-line\b([^\n]*)/g;
const ignoreFilePattern = /\/\/\s*ts-structure-ignore-file\b([^\n]*)/;

/** Runs inspections on a file, honoring suppression comments and per-inspection severities. */
export function runInspections(
  inspections: readonly Inspection[],
  context: InspectionContext,
  /** 'default' keeps the severity each finding was reported with. */
  severityOf: (inspection: Inspection) => Severity | 'off' | 'default' = () => 'default',
): Finding[] {
  const text = context.sourceFile.text;
  const fileIgnore = ignoreFilePattern.exec(text);
  const ignoredInFile = fileIgnore ? idsOf(fileIgnore[1]) : undefined;
  const ignoredLines = new Map<number, Set<string> | 'all'>();
  for (const match of text.matchAll(ignorePattern)) {
    const line = context.sourceFile.getLineAndCharacterOfPosition(match.index).line + 1;
    ignoredLines.set(line, idsOf(match[1]));
  }
  const findings: Finding[] = [];
  for (const inspection of inspections) {
    const severity = severityOf(inspection);
    if (severity === 'off' || matches(ignoredInFile, inspection.id)) {
      continue;
    }
    for (const finding of inspection.run(context)) {
      const line = context.sourceFile.getLineAndCharacterOfPosition(finding.start).line;
      if (!matches(ignoredLines.get(line), inspection.id)) {
        findings.push(severity === 'default' ? finding : { ...finding, severity });
      }
    }
  }
  return findings;
}

function idsOf(list: string): Set<string> | 'all' {
  const ids = list
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[\w-]+$/.test(s));
  return ids.length ? new Set(ids) : 'all';
}

function matches(ignored: Set<string> | 'all' | undefined, id: string): boolean {
  return ignored === 'all' || (!!ignored && ignored.has(id));
}

/** The edit that suppresses an inspection for the whole file, extending an existing file comment. */
export function fileSuppressionEdit(sourceFile: ts.SourceFile, id: string): TextEdit {
  const existing = /\/\/\s*ts-structure-ignore-file\b([^\n]*)/.exec(sourceFile.text);
  if (existing && existing[1].trim()) {
    const end = existing.index + existing[0].trimEnd().length;
    return { start: end, end, text: `, ${id}` };
  }
  // After a shebang, which must stay on the first line.
  const start = sourceFile.text.startsWith('#!') ? sourceFile.text.indexOf('\n') + 1 : 0;
  return { start, end: start, text: `// ts-structure-ignore-file ${id}\n` };
}

/** One fix per finding (the preferred one), skipping fixes that overlap an earlier one. */
export function fixAllEdits(findings: readonly Finding[], inspection?: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const finding of findings) {
    if (inspection && finding.inspection !== inspection) {
      continue;
    }
    const fix = finding.fixes?.find((f) => f.preferred) ?? finding.fixes?.[0];
    if (!fix || fix.edits.some((e) => edits.some((o) => e.start < o.end && o.start < e.end))) {
      continue;
    }
    edits.push(...fix.edits);
  }
  return edits;
}

/** The text edit that suppresses one inspection on the finding's line. */
export function suppressionEdit(sourceFile: ts.SourceFile, finding: Finding): TextEdit {
  const line = sourceFile.getLineAndCharacterOfPosition(finding.start).line;
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
  const indent = /^[ \t]*/.exec(sourceFile.text.slice(lineStart))![0];
  return { start: lineStart, end: lineStart, text: `${indent}// ts-structure-ignore-next-line ${finding.inspection}\n` };
}
