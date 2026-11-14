import { Report, ReportLocation, ReportNode, Tone, titleParts } from './report';
import { reportIcons } from './icons';
import { ValuePathCard, valuePathCard } from './valuePathCard';

/**
 * Any result as a card for the sidebar panel: the analysis and its subject, the summary, how long it took, and the
 * result's groups as steps on a timeline, each with its rows (the first few shown, the rest one click away, rows
 * inside rows folded). A Value path keeps its own card, with each value and the conditions that lead to it.
 */
export interface CardRow {
  label: string;
  description?: string;
  tone?: Tone;
  icon?: string;
  location?: ReportLocation;
  /** Rows inside it, already trimmed. */
  children: CardRow[];
  /** Rows left out of `children` to keep the page light. */
  more: number;
}

export interface ResultCard {
  kind: string;
  heading: string;
  subject?: string;
  icon: string;
  summary: string;
  timing?: string;
  /** When it ran, as "14:03". */
  ranAt?: string;
  warnings: string[];
  /** A Value path: the timeline of values. */
  value?: ValuePathCard;
  /** Any other result: its groups. */
  rows?: CardRow[];
  /** Rows marked as a warning or a problem, anywhere in the result. */
  issues: number;
  /** Where the subject is written, for the analyses offered under Next steps. */
  subjectAt?: ReportLocation;
  /** Other analyses of the same subject, filled in by the panel. */
  nextSteps?: { command: string; label: string; icon: string }[];
}

/** Rows with a warning or a problem, counted through every level. */
function countIssues(nodes: readonly ReportNode[]): number {
  let n = 0;
  for (const node of nodes) n += (node.tone === 'warning' || node.tone === 'error' ? 1 : 0) + countIssues(node.children ?? []);
  return n;
}

const MAX_CHILDREN = 150;
const MAX_DEPTH = 5;

function toRow(node: ReportNode, depth: number): CardRow {
  const children = depth < MAX_DEPTH ? (node.children ?? []).slice(0, MAX_CHILDREN).map((c) => toRow(c, depth + 1)) : [];
  const total = node.children?.length ?? 0;
  return { label: node.label, description: node.description, tone: node.tone, icon: node.icon, location: node.location, children, more: Math.max(0, total - children.length) };
}

export function resultCard(report: Report): ResultCard {
  const { heading, subject } = titleParts(report);
  const timing = report.durationMs === undefined ? undefined : report.durationMs < 1000 ? `${report.durationMs} ms` : `${(report.durationMs / 1000).toFixed(1)} s`;
  const ranAt = report.ranAt ? new Date(report.ranAt).toTimeString().slice(0, 5) : undefined;
  // Where the subject is: the report's own, or else the first row that has a location.
  let subjectAt = report.subject;
  const firstLocated = (nodes: readonly ReportNode[]): void => { for (const n of nodes) { if (subjectAt) return; if (n.location) subjectAt = n.location; else firstLocated(n.children ?? []); } };
  firstLocated(report.roots);
  const base = { kind: report.kind, heading, subject, icon: reportIcons[report.kind] ?? 'symbol-misc', summary: report.description ?? '', timing, ranAt, warnings: report.warnings, issues: countIssues(report.roots), subjectAt };
  const value = valuePathCard(report);
  if (value) return { ...base, heading: 'Value path', value };
  return { ...base, rows: report.roots.map((r) => toRow(r, 0)) };
}
