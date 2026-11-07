import { Report, ReportLocation, ReportNode, Tone, titleParts } from './report';

/** One box of a diagram: a result row, with the rows below it as its children. */
export interface DiagramNode {
  label: string;
  description?: string;
  tone?: Tone;
  location?: ReportLocation;
  /** Folded: the children are hidden until the node's button is clicked. */
  collapsed: boolean;
  children: DiagramNode[];
}

/** An analysis as a flow chart: the subject in the middle, with rows on either side of it. */
export interface Diagram {
  title: string;
  center: DiagramNode;
  /** Drawn left of the subject, with arrows pointing into it: where the value comes from. */
  left: DiagramNode[];
  /** Drawn right of the subject, with arrows pointing away from it. */
  right: DiagramNode[];
  leftCaption?: string;
  rightCaption?: string;
}

/** Rows that suggest what to do next rather than describe the code. */
const skipped = new Set(['Next', 'How to fix']);

function toNode(row: ReportNode, collapsed = !row.expanded): DiagramNode {
  const children = (row.children ?? []).filter((c) => !skipped.has(c.label)).map((c) => toNode(c));
  return { label: row.label, description: row.description, tone: row.tone, location: row.location, collapsed: children.length > 0 && collapsed, children };
}

/** A function row whose steps only give the value something: it belongs on the incoming side. */
function onlyWrites(row: ReportNode): boolean {
  return (row.icon === 'symbol-function' || row.icon === 'file-code') && !!row.children?.length && row.children.every((c) => c.role === 'write' || c.role === 'definition');
}

/**
 * The diagram of a report. Data Flow puts Flows in on the left and Flows out on the right, so values
 * travel left to right through the variable; every other analysis hangs its rows to the right of its subject.
 */
export function reportDiagram(report: Report): Diagram {
  const { heading, subject } = titleParts(report);
  const roots = report.roots.filter((r) => !skipped.has(r.label));
  const center: DiagramNode = { label: subject ?? heading, description: report.description, collapsed: false, children: [] };
  if (report.kind === 'dataFlow') {
    const flowsIn = roots.find((r) => r.label === 'Flows in');
    const flowsOut = roots.find((r) => r.label === 'Flows out');
    const rest = roots.filter((r) => r !== flowsIn && r !== flowsOut);
    // Patterns describe the surrounding code, so they start folded.
    const restNode = (r: ReportNode) => toNode(r, r.label === 'Design patterns' ? true : !r.expanded);
    return {
      title: report.title,
      center,
      left: [...(flowsIn?.children ?? []).map((r) => toNode(r)), ...rest.filter(onlyWrites).map(restNode)],
      right: [...(flowsOut?.children ?? []).map((r) => toNode(r)), ...rest.filter((r) => !onlyWrites(r)).map(restNode)],
      leftCaption: 'Flows in',
      rightCaption: 'Flows out',
    };
  }
  return { title: report.title, center, left: [], right: roots.map((r) => toNode(r)) };
}
