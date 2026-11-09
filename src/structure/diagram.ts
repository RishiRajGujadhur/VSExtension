import { Report, ReportLocation, ReportNode, Tone, titleParts } from './report';

/** One box of a diagram: a result row, with the rows below it as its children. */
export interface DiagramNode {
  label: string;
  description?: string;
  tone?: Tone;
  location?: ReportLocation;
  /** What the box stands for: a design pattern describes the surrounding code rather than carrying the value. */
  kind?: 'pattern';
  /** The codicon its row has in the results view, or one for common groups such as Design patterns. */
  icon?: string;
  /** A stack of boxes that read the same: how many, with each one as a child, told apart by its line. */
  duplicates?: number;
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

/** Text that is safe inside a quoted Mermaid label: quotes and angle brackets as Mermaid entities. */
export const mermaidText = (text: string): string => text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');

/** Rows that suggest what to do next rather than describe the code. */
const skipped = new Set(['Next', 'How to fix']);

/** The Design patterns group and pattern rows (those with the pattern info action); everything below them is too. */
function isPattern(row: ReportNode): boolean {
  return row.label === 'Design patterns' || row.action?.kind === 'explainPattern';
}

function toNode(row: ReportNode, collapsed = !row.expanded, inherited?: DiagramNode['kind']): DiagramNode {
  const kind = inherited ?? (isPattern(row) ? 'pattern' : undefined);
  const children = (row.children ?? []).filter((c) => !skipped.has(c.label)).map((c) => toNode(c, !c.expanded, kind));
  const icon = boxIcon(row, kind);
  return { label: row.label, description: row.description, tone: row.tone, location: row.location, ...(kind ? { kind } : {}), ...(icon ? { icon } : {}), collapsed: children.length > 0 && collapsed, children };
}

/** Icons for groups that appear in many analyses, used when their row has none of its own. */
export const groupIcons: Record<string, string> = {
  'Design patterns': 'library',
  'Race conditions': 'debug-disconnect',
  'Incoming values from call sites': 'call-incoming',
  'Flows in': 'arrow-right',
  'Flows out': 'arrow-right',
};

/** The icon of a box: its row's own, a group's, or by what the row does with the value. */
export function boxIcon(row: ReportNode, kind?: DiagramNode['kind']): string | undefined {
  if (row.icon) return row.icon;
  if (groupIcons[row.label]) return groupIcons[row.label];
  if (kind === 'pattern') return 'symbol-class';
  const roles: Record<string, string> = { write: 'edit', definition: 'symbol-variable', read: 'eye', call: 'symbol-method' };
  return row.role ? roles[row.role] : undefined;
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
  return foldToFit(groupDuplicates(buildDiagram(report)));
}

/**
 * Boxes side by side that read exactly the same (label, description, kind and tone), such as one call made on
 * several lines, become one folded stack: its count shows on it, and unfolding it shows each one with its line.
 */
export function groupDuplicates(diagram: Diagram): Diagram {
  const keyOf = (n: DiagramNode) => [n.label, n.description ?? '', n.kind ?? '', n.tone ?? ''].join('\u0000');
  const group = (nodes: DiagramNode[]): DiagramNode[] => {
    const byKey = new Map<string, DiagramNode[]>();
    for (const n of nodes) byKey.set(keyOf(n), [...(byKey.get(keyOf(n)) ?? []), n]);
    const out: DiagramNode[] = [];
    const done = new Set<string>();
    for (const n of nodes) {
      const key = keyOf(n);
      const same = byKey.get(key)!;
      if (same.length < 2) {
        out.push({ ...n, children: group(n.children) });
        continue;
      }
      if (done.has(key)) continue;
      done.add(key);
      const where = (m: DiagramNode, i: number) => (m.location ? `line ${m.location.line + 1}` : `#${i + 1}`);
      out.push({
        ...n,
        duplicates: same.length,
        collapsed: true,
        children: same.map((m, i) => ({ ...m, description: [where(m, i), m.description].filter(Boolean).join(' · '), children: group(m.children) })),
      });
    }
    return out;
  };
  return { ...diagram, left: group(diagram.left), right: group(diagram.right) };
}

/** How many boxes a chart shows when it opens; Unfold All shows the rest. */
export const openingBoxes = 150;

/**
 * Folds a chart that would open with more than `limit` boxes: the deepest levels fold first, keeping as many
 * levels unfolded as fit. Small charts open exactly as the results view shows them.
 */
export function foldToFit(diagram: Diagram, limit = openingBoxes): Diagram {
  const sides = [...diagram.left, ...diagram.right];
  const count = (nodes: DiagramNode[], depth: number, maxDepth: number): number =>
    nodes.reduce((total, n) => total + 1 + (n.collapsed || depth >= maxDepth ? 0 : count(n.children, depth + 1, maxDepth)), 0);
  if (count(sides, 1, Infinity) <= limit) {
    return diagram;
  }
  let depth = 1;
  while (count(sides, 1, depth + 1) <= limit && depth < 50) {
    depth++;
  }
  const fold = (nodes: DiagramNode[], level: number): void =>
    nodes.forEach((n) => {
      if (level >= depth && n.children.length) {
        n.collapsed = true;
      }
      fold(n.children, level + 1);
    });
  fold(sides, 1);
  return diagram;
}

function buildDiagram(report: Report): Diagram {
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
  // Graphs with two sides: what comes in on the left of the subject, what goes out on the right.
  const sides = twoSided[report.kind];
  if (sides) {
    const leftRows = roots.filter((r) => sides.left.includes(r.label));
    const rightRows = roots.filter((r) => !sides.left.includes(r.label));
    const open = (rows: ReportNode[]) => rows.flatMap((r) => (sides.unwrap ? (r.children ?? []) : [r])).map((r) => toNode(r));
    return { title: report.title, center, left: open(leftRows), right: open(rightRows), leftCaption: sides.leftCaption, rightCaption: sides.rightCaption };
  }
  return { title: report.title, center, left: [], right: roots.map((r) => toNode(r)) };
}

/**
 * Reports drawn on both sides of their subject: the rows named in `left` go left. With `unwrap`, the group rows
 * themselves aren't drawn, only what they hold (the captions say what each side is).
 */
const twoSided: Record<string, { left: string[]; leftCaption: string; rightCaption: string; unwrap?: boolean }> = {
  callGraph: { left: ['Called by'], leftCaption: 'Called by', rightCaption: 'Calls', unwrap: true },
  reactState: { left: ['Props', 'Context'], leftCaption: 'Inputs', rightCaption: 'State and effects' },
};

/**
 * The chart as a Mermaid flowchart, for Markdown, GitHub issues and pull requests. Folded boxes keep their
 * place and say how many boxes they hide; arrows run the way the chart draws them.
 */
export function diagramMermaid(diagram: Diagram): string {
  const lines = ['flowchart LR'];
  const tones: Record<string, string[]> = {};
  let next = 0;
  const escape = mermaidText;
  const declare = (node: DiagramNode): string => {
    const id = `n${next++}`;
    const hidden = node.collapsed && node.children.length ? `${node.children.length} more folded` : '';
    const text = `"${[node.label, node.description, hidden].filter(Boolean).map((t) => escape(t!)).join('<br/>')}"`;
    // Patterns are hexagons, like in the chart.
    lines.push(node.kind === 'pattern' ? `  ${id}{{${text}}}` : `  ${id}[${text}]`);
    if (node.kind === 'pattern') {
      (tones.pattern ??= []).push(id);
    }
    if (node.tone) {
      (tones[node.tone] ??= []).push(id);
    }
    return id;
  };
  const center = declare(diagram.center);
  const walk = (parent: string, nodes: DiagramNode[], side: number) => {
    for (const node of nodes) {
      const id = declare(node);
      // A pattern is related to the code, not reached by the value: a dotted line without an arrow.
      lines.push(node.kind === 'pattern' ? `  ${parent} -.- ${id}` : side < 0 ? `  ${id} --> ${parent}` : `  ${parent} --> ${id}`);
      if (!node.collapsed) {
        walk(id, node.children, side);
      }
    }
  };
  walk(center, diagram.left, -1);
  walk(center, diagram.right, 1);
  lines.push(`  style ${center} stroke-width:3px`);
  const colors: Record<string, string> = { ok: '#2ea043', warning: '#d29922', error: '#f85149', info: '#3794ff', pattern: '#b180d7' };
  for (const [tone, ids] of Object.entries(tones)) {
    lines.push(`  classDef ${tone} stroke:${colors[tone]},stroke-width:2px`, `  class ${ids.join(',')} ${tone}`);
  }
  return lines.join('\n');
}
