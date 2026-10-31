import * as ts from 'typescript';
import { hashText, normalizePath } from '../analysis/paths';

/** Zero-based range, matching both the TypeScript API and VS Code. */
export interface ReportLocation {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export type Tone = 'error' | 'warning' | 'info' | 'ok';

/** One row of an analysis result tree. */
export interface ReportNode {
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id such as `symbol-function`. */
  icon?: string;
  tone?: Tone;
  location?: ReportLocation;
  children?: ReportNode[];
  expanded?: boolean;
  /** How the location uses the analyzed value; drives editor highlights. */
  role?: 'read' | 'write' | 'definition';
  /** Opaque data for context-menu actions on the row. */
  action?: { kind: string; [key: string]: unknown };
}

export interface Report {
  /** The analysis that produced the report, such as `dataFlow`. */
  kind: string;
  title: string;
  description?: string;
  roots: ReportNode[];
  warnings: string[];
  /** Content hash of every file a row points into, used to reject stale navigation. */
  fileHashes: Record<string, string>;
  /** How long the analysis took, set by the UI. */
  durationMs?: number;
}

/** Collects locations while a report is built, remembering the text each one was computed from. */
export class ReportBuilder {
  private readonly hashes = new Map<string, string>();
  readonly warnings: string[] = [];

  constructor(
    readonly kind: string,
    readonly title: string,
  ) {}

  at(node: ts.Node, sourceFile = node.getSourceFile()): ReportLocation {
    return this.span(sourceFile, node.getStart(sourceFile), node.end);
  }

  span(sourceFile: ts.SourceFile, start: number, end: number): ReportLocation {
    const file = normalizePath(sourceFile.fileName);
    if (!this.hashes.has(file)) {
      this.hashes.set(file, hashText(sourceFile.text));
    }
    const from = sourceFile.getLineAndCharacterOfPosition(start);
    const to = sourceFile.getLineAndCharacterOfPosition(end);
    return { file, line: from.line, character: from.character, endLine: to.line, endCharacter: to.character };
  }

  finish(roots: ReportNode[], description?: string): Report {
    return { kind: this.kind, title: this.title, description, roots, warnings: this.warnings, fileHashes: Object.fromEntries(this.hashes) };
  }
}

/** The trimmed source line a node starts on, shortened for display. */
export function lineSnippet(node: ts.Node, max = 90): string {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = line + 1 < sourceFile.getLineStarts().length ? sourceFile.getLineStarts()[line + 1] : sourceFile.text.length;
  return shorten(sourceFile.text.slice(lineStart, lineEnd).trim(), max);
}

/** Node text on one line, shortened for display. */
export function nodeSnippet(node: ts.Node, max = 60): string {
  return shorten(node.getText().replace(/\s+/g, ' '), max);
}

export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Visits every row of a report, depth first. */
export function forEachReportNode(nodes: readonly ReportNode[], visit: (node: ReportNode, depth: number) => void, depth = 0): void {
  for (const node of nodes) {
    visit(node, depth);
    forEachReportNode(node.children ?? [], visit, depth + 1);
  }
}
