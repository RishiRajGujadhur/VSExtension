import ts = require('typescript');
import { Cfg, CfgNode, buildCfg } from './controlFlow';
import { cfgPaths, describeChoice } from './paths';
import { layoutFlow } from '../structure/flowLayout';
import { ReportLocation } from '../structure/report';
import { functionAtOffset } from '../structure/util';
import { normalizePath } from '../analysis/paths';
import { VirtualProject } from '../refactor/virtualProject';

/** Everything the Control Flow view draws: positioned nodes, routed edges and the paths through the function. */
export interface ControlFlowChart {
  name: string;
  file: string;
  /** Offset of the function in its file, to find it again after edits. */
  anchor: number;
  nodes: {
    id: number;
    kind: CfgNode['kind'];
    lines: string[];
    unreachable: boolean;
    location?: ReportLocation;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  edges: { from: number; to: number; kind: string; label?: string; back: boolean; points: { x: number; y: number }[]; labelAt: { x: number; y: number } }[];
  paths: { nodes: number[]; edges: number[]; steps: { text: string; edge: number }[]; ending: string; feasible: boolean; reason?: string }[];
  truncated: boolean;
  width: number;
  height: number;
}

/** Sizes for code in the editor font at 12px. */
const CHAR = 7.2;
const LINE = 18;
const MAX_LINE = 72;
const MAX_LINES = 8;

function shownLines(node: CfgNode): string[] {
  const lines = node.lines.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l));
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `… ${lines.length - MAX_LINES + 1} more`] : lines;
}

function size(kind: CfgNode['kind'], lines: string[]): { width: number; height: number } {
  const text = Math.max(...lines.map((l) => l.length)) * CHAR;
  const height = lines.length * LINE + 16;
  if (kind === 'decision' || kind === 'switch' || kind === 'loop') return { width: Math.max(90, text + 52), height: height + 4 };
  if (kind === 'start' || kind === 'end') return { width: Math.max(70, text + 34), height: 30 };
  return { width: Math.max(80, text + 26), height };
}

export function controlFlowChart(project: VirtualProject, fileName: string, offset: number): ControlFlowChart {
  const sourceFile = project.sourceFile(fileName);
  const fn = functionAtOffset(sourceFile, offset, project.program().getTypeChecker());
  return chartOf(buildCfg(fn), fn.getSourceFile());
}

export function chartOf(cfg: Cfg, sourceFile: ts.SourceFile): ControlFlowChart {
  const lines = cfg.nodes.map(shownLines);
  const layout = layoutFlow(
    cfg.nodes.map((n, i) => ({ id: n.id, ...size(n.kind, lines[i]) })),
    cfg.edges.map((e) => ({ from: e.from, to: e.to, back: e.kind === 'back' || e.kind === 'continue' })),
    cfg.start,
    cfg.end,
  );
  const locate = (node: CfgNode): ReportLocation | undefined => {
    if (!node.nodes.length || node.kind === 'start' || node.kind === 'end') {
      return node.kind === 'start' ? place(sourceFile, cfg.fn.getStart(sourceFile), cfg.fn.getStart(sourceFile)) : undefined;
    }
    return place(sourceFile, node.nodes[0].getStart(sourceFile), node.nodes[node.nodes.length - 1].end);
  };
  const { paths, truncated } = cfgPaths(cfg);
  const describeEnding = (p: (typeof paths)[number]) => (p.ending.kind === 'return' ? (p.ending.text ? `returns ${p.ending.text}` : 'returns') : p.ending.kind === 'throw' ? `throws ${p.ending.text}` : 'reaches the end');
  return {
    name: cfg.name,
    file: normalizePath(sourceFile.fileName),
    anchor: cfg.fn.getStart(sourceFile),
    nodes: cfg.nodes.map((n, i) => {
      const p = layout.nodes.get(n.id)!;
      return { id: n.id, kind: n.kind, lines: lines[i], unreachable: !!n.unreachable, location: locate(n), x: p.x, y: p.y, width: p.width, height: p.height };
    }),
    edges: cfg.edges.map((e, i) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
      back: e.kind === 'back' || e.kind === 'continue',
      points: layout.routes[i].points,
      labelAt: layout.routes[i].label,
    })),
    paths: paths.map((p) => ({
      nodes: p.nodes,
      edges: p.edges,
      steps: p.edges.filter((e) => cfg.edges[e].choice).map((e) => ({ text: describeChoice(cfg.edges[e].choice!), edge: e })),
      ending: describeEnding(p),
      feasible: p.feasible,
      reason: p.reason,
    })),
    truncated,
    width: layout.width,
    height: layout.height,
  };
}

function place(sourceFile: ts.SourceFile, start: number, end: number): ReportLocation {
  const from = sourceFile.getLineAndCharacterOfPosition(start);
  const to = sourceFile.getLineAndCharacterOfPosition(end);
  return { file: normalizePath(sourceFile.fileName), line: from.line, character: from.character, endLine: to.line, endCharacter: to.character };
}

/** The node whose code holds the offset, innermost first, for following the editor's cursor. */
export function nodeAtOffset(chart: ControlFlowChart, sourceFile: ts.SourceFile, offset: number): number | undefined {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  const inside = chart.nodes.filter((n) => n.location && n.kind !== 'start' && (line > n.location.line || (line === n.location.line && character >= n.location.character)) && (line < n.location.endLine || (line === n.location.endLine && character <= n.location.endCharacter)));
  const sizeOf = (n: (typeof inside)[number]) => (n.location!.endLine - n.location!.line) * 1000 + (n.location!.endCharacter - n.location!.character);
  return inside.sort((a, b) => sizeOf(a) - sizeOf(b))[0]?.id;
}
