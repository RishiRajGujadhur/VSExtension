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
    // "Where it is written" and "Where it is read" only fold the results view; the chart shows their functions directly.
    const unwrap = (rows: ReportNode[]) => rows.flatMap((r) => (r.label === 'Where it is written' || r.label === 'Where it is read' ? (r.children ?? []) : [r]));
    // Patterns describe the surrounding code, so they start folded.
    const restNode = (r: ReportNode) => toNode(r, r.label === 'Design patterns' ? true : !r.expanded);
    return {
      title: report.title,
      center,
      left: [...unwrap(flowsIn?.children ?? []).map((r) => toNode(r)), ...rest.filter(onlyWrites).map(restNode)],
      right: [...unwrap(flowsOut?.children ?? []).map((r) => toNode(r)), ...rest.filter((r) => !onlyWrites(r)).map(restNode)],
      leftCaption: 'Flows in',
      rightCaption: 'Flows out',
    };
  }
  return { title: report.title, center, left: [], right: roots.map((r) => toNode(r)) };
}

/**
 * The chart as a Mermaid flowchart, for Markdown, GitHub issues and pull requests. Folded boxes keep their
 * place and say how many boxes they hide; arrows run the way the chart draws them.
 */
export function diagramMermaid(diagram: Diagram): string {
  const lines = ['flowchart LR'];
  const tones: Record<string, string[]> = {};
  let next = 0;
  const escape = (text: string) => text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
  const declare = (node: DiagramNode): string => {
    const id = `n${next++}`;
    const hidden = node.collapsed && node.children.length ? `${node.children.length} more folded` : '';
    lines.push(`  ${id}["${[node.label, node.description, hidden].filter(Boolean).map((t) => escape(t!)).join('<br/>')}"]`);
    if (node.tone) {
      (tones[node.tone] ??= []).push(id);
    }
    return id;
  };
  const center = declare(diagram.center);
  const walk = (parent: string, nodes: DiagramNode[], side: number) => {
    for (const node of nodes) {
      const id = declare(node);
      lines.push(side < 0 ? `  ${id} --> ${parent}` : `  ${parent} --> ${id}`);
      if (!node.collapsed) {
        walk(id, node.children, side);
      }
    }
  };
  walk(center, diagram.left, -1);
  walk(center, diagram.right, 1);
  lines.push(`  style ${center} stroke-width:3px`);
  const colors: Record<string, string> = { ok: '#2ea043', warning: '#d29922', error: '#f85149', info: '#3794ff' };
  for (const [tone, ids] of Object.entries(tones)) {
    lines.push(`  classDef ${tone} stroke:${colors[tone]},stroke-width:2px`, `  class ${ids.join(',')} ${tone}`);
  }
  return lines.join('\n');
}
