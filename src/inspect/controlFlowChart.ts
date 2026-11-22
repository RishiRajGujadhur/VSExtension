import ts = require('typescript');
import { Cfg, CfgNode, FlowGraph, buildCfg, callTargets, expandCalls } from './controlFlow';
import { cfgPaths, describeChoice } from './paths';
import { Dependences, dependencesOf } from './dependences';
import { layoutFlow } from '../structure/flowLayout';
import { mermaidText } from '../structure/diagram';
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
    /** Lines of code folded away under the box's "N more lines" chip; 0 when all of it is shown. */
    hiddenLines: number;
    /** The box has more code than a folded box shows and is unfolded: its chip folds it back. */
    unfolded: boolean;
    /** What the page sends to unfold or fold this box: where its code starts. */
    foldKey: string;
    /** All of the box's code, for the info bar and tooltips, up to a limit. */
    text: string;
    unreachable: boolean;
    /** The function a spliced-in node belongs to. */
    owner?: string;
    /** Calls in this box that can be expanded in place, and whether they are. */
    calls: { key: string; name: string; expanded: boolean }[];
    location?: ReportLocation;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  edges: { from: number; to: number; kind: string; label?: string; back: boolean; points: { x: number; y: number }[]; labelAt: { x: number; y: number } }[];
  paths: { nodes: number[]; edges: number[]; steps: { text: string; edge: number }[]; ending: string; feasible: boolean; reason?: string }[];
  truncated: boolean;
  /** The program dependence graph: data and control dependences between boxes. */
  dependences: Dependences;
  width: number;
  height: number;
}

/** Sizes for code in the editor font at 12px. */
const CHAR = 7.2;
const LINE = 18;
/** Long lines wrap at this many characters; continued lines are indented. */
const WRAP = 64;
/** A folded box shows this many lines; the rest are behind its chip. */
const FOLDED_LINES = 4;
/** An unfolded box shows at most this many; the hover card has all of it. */
const MAX_LINES = 40;

/** How the boxes show their code: folded boxes, except those unfolded by their chip, or all code. */
export interface CodeOptions {
  unfolded?: ReadonlySet<string>;
  showAll?: boolean;
}

/** A line split where it is best broken (after a space, comma or bracket) so no part is longer than `width`. */
export function wrapLine(line: string, width = WRAP): string[] {
  if (line.length <= width) return [line];
  const indent = /^\s*/.exec(line)![0];
  const out: string[] = [];
  let rest = line;
  let lead = '';
  while ((lead + rest).length > width) {
    const room = width - lead.length;
    let cut = -1;
    for (let i = room; i > room / 2; i--) {
      if (' ,([{'.includes(rest[i - 1]) || ' .'.includes(rest[i])) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = room;
    out.push(lead + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    lead = `${indent}  `;
  }
  if (rest) out.push(lead + rest);
  return out;
}

/** The lines a box shows, wrapped, folded unless it is unfolded, and how many are folded away. */
export function shownLines(node: CfgNode, open: boolean): { lines: string[]; hidden: number; foldable: boolean } {
  const wrapped = node.lines.flatMap((l) => wrapLine(l));
  const foldable = wrapped.length > FOLDED_LINES;
  const limit = open ? MAX_LINES : FOLDED_LINES - 1;
  if (!foldable || wrapped.length <= limit) return { lines: wrapped, hidden: 0, foldable };
  return { lines: wrapped.slice(0, limit), hidden: wrapped.length - limit, foldable };
}

/** Start and end are circles of this size; the function's name is written beside the start circle. */
export const TERMINAL = 34;
const MAX_TEXT = 60;

/** The code of a box of plain statements as written (not shortened to one line each), without its indentation. */
function sourceLines(node: CfgNode): string[] | undefined {
  if (!['statement', 'return', 'throw'].includes(node.kind) || !node.nodes.length) return undefined;
  return node.nodes.flatMap((n) => {
    const file = n.getSourceFile();
    const start = n.getStart(file);
    const column = start - file.getLineStarts()[file.getLineAndCharacterOfPosition(start).line];
    return file.text.slice(start, n.end).split(/\r?\n/).map((l, i) => (i && /^\s*$/.test(l.slice(0, column)) ? l.slice(column) : l).trimEnd());
  });
}

/** A box's code in full (within limits), for the info bar. */
function fullText(node: CfgNode, source: string[] | undefined): string {
  if (source) return (source.length > MAX_TEXT ? [...source.slice(0, MAX_TEXT), `… ${source.length - MAX_TEXT} more lines`] : source).join('\n');
  const lines = node.lines.length > MAX_TEXT ? [...node.lines.slice(0, MAX_TEXT), `… ${node.lines.length - MAX_TEXT} more lines`] : node.lines;
  return lines.join('\n');
}

function size(kind: CfgNode['kind'], lines: string[], chip: boolean): { width: number; height: number } {
  if (kind === 'start' || kind === 'end') return { width: TERMINAL, height: TERMINAL };
  // The chip ("12 more lines" or "Fold") takes a line of its own under the code.
  const text = Math.max(...lines.map((l) => l.length), chip ? 16 : 0) * CHAR;
  const height = (lines.length + (chip ? 1 : 0)) * LINE + 16;
  if (kind === 'decision' || kind === 'switch' || kind === 'loop') return { width: Math.max(90, text + 52), height: height + 4 };
  return { width: Math.max(80, text + 26), height };
}

export function controlFlowChart(project: VirtualProject, fileName: string, offset: number, expanded: ReadonlySet<string> = new Set(), code: CodeOptions = {}): ControlFlowChart {
  const sourceFile = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const fn = functionAtOffset(sourceFile, offset, checker);
  const cfg = expandCalls(buildCfg(fn), checker, expanded);
  return chartOf(cfg, fn.getSourceFile(), (node) => callTargets(node, checker).map((c) => ({ key: c.key, name: c.name, expanded: expanded.has(c.key) })), code);
}

/**
 * Charts of the functions in one TypeScript or JavaScript text on its own, without the project: for an older version
 * of a file (the last commit). The file is parsed once; calls are not followed into other files.
 */
export function standaloneCharts(fileName: string, text: string, parsed?: StandaloneProgram): (offset: number, code?: CodeOptions) => ControlFlowChart {
  const { sourceFile, checker } = parsed ?? standaloneProgram(fileName, text);
  return (offset, code = {}) => {
    const fn = functionAtOffset(sourceFile, offset, checker);
    return chartOf(buildCfg(fn), sourceFile, () => [], code);
  };
}

export interface StandaloneProgram {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}

/** One file parsed and checked on its own, without the project or the standard library. */
export function standaloneProgram(fileName: string, text: string): StandaloneProgram {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [], jsx: ts.JsxEmit.Preserve };
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram({
    rootNames: [fileName],
    options,
    host: { ...host, getSourceFile: (name) => (normalizePath(name) === normalizePath(fileName) ? sourceFile : undefined), fileExists: (name) => normalizePath(name) === normalizePath(fileName), readFile: () => undefined },
  });
  return { sourceFile, checker: program.getTypeChecker() };
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Where a chart's boxes are in the code, and their code as written: TypeScript nodes, or a parser's facts (C#). */
export interface ChartSource {
  file: string;
  /** Offset of the function in its file, to find it again after edits. */
  anchor: number;
  /** Where the box's code is, for opening it and following the cursor. */
  locate(node: CfgNode): ReportLocation | undefined;
  /** What the page sends to unfold or fold the box. */
  foldKey(node: CfgNode): string;
  /** The code of a box of plain statements as written, without its indentation. */
  sourceLines(node: CfgNode): string[] | undefined;
}

/** The chart source for a TypeScript function. */
function typeScriptSource(cfg: Cfg, sourceFile: ts.SourceFile): ChartSource {
  return {
    file: normalizePath(sourceFile.fileName),
    anchor: cfg.fn.getStart(sourceFile),
    locate(node) {
      if (!node.nodes.length || node.kind === 'start' || node.kind === 'end') {
        return node.kind === 'start' ? place(sourceFile, cfg.fn.getStart(sourceFile), cfg.fn.getStart(sourceFile)) : undefined;
      }
      // A spliced-in node points into the file of its own function.
      const file = node.nodes[0].getSourceFile();
      return place(file, node.nodes[0].getStart(file), node.nodes[node.nodes.length - 1].end);
    },
    foldKey(node) {
      if (!node.nodes.length) return `#${node.id}`;
      const file = node.nodes[0].getSourceFile();
      return `${normalizePath(file.fileName)}:${node.nodes[0].getStart(file)}`;
    },
    sourceLines,
  };
}

/** The chart source for boxes that carry their own facts (C#). */
export function factSource(file: string, anchor: number, start: ReportLocation): ChartSource {
  return {
    file,
    anchor,
    locate: (node) => (node.kind === 'start' ? start : node.facts?.location),
    foldKey: (node) => (node.facts ? `${file}:${node.facts.location.line}:${node.facts.location.character}` : `#${node.id}`),
    sourceLines: (node) => (node.facts && ['statement', 'return', 'throw'].includes(node.kind) ? node.facts.source : undefined),
  };
}

export function chartOf(cfg: Cfg, sourceFile: ts.SourceFile, callsOf: (node: CfgNode) => ControlFlowChart['nodes'][number]['calls'] = () => [], code: CodeOptions = {}): ControlFlowChart {
  return chartFrom(cfg, typeScriptSource(cfg, sourceFile), callsOf, code);
}

/** A flowchart of any function's control flow: boxes sized and laid out, every path, and the dependences. */
export function chartFrom(cfg: FlowGraph, source: ChartSource, callsOf: (node: CfgNode) => ControlFlowChart['nodes'][number]['calls'] = () => [], code: CodeOptions = {}): ControlFlowChart {
  const foldKey = (node: CfgNode) => source.foldKey(node);
  const shown = cfg.nodes.map((n) => shownLines(n, !!code.showAll || !!code.unfolded?.has(foldKey(n))));
  const lines = shown.map((s) => s.lines);
  // A chip under the code: "N more lines" on a folded box, "Fold" on an unfolded one (not when all code is shown).
  const chip = (i: number) => shown[i].hidden > 0 || (shown[i].foldable && !code.showAll);
  const layout = layoutFlow(
    cfg.nodes.map((n, i) => ({ id: n.id, ...size(n.kind, lines[i], chip(i)) })),
    cfg.edges.map((e) => ({ from: e.from, to: e.to, back: e.kind === 'back' || e.kind === 'continue' })),
    cfg.start,
    cfg.end,
  );
  const { paths, truncated } = cfgPaths(cfg);
  const describeEnding = (p: (typeof paths)[number]) => (p.ending.kind === 'return' ? (p.ending.text ? `returns ${p.ending.text}` : 'returns') : p.ending.kind === 'throw' ? `throws ${p.ending.text}` : 'reaches the end');
  return {
    name: cfg.name,
    file: source.file,
    anchor: source.anchor,
    nodes: cfg.nodes.map((n, i) => {
      const p = layout.nodes.get(n.id)!;
      return { id: n.id, kind: n.kind, lines: lines[i], hiddenLines: shown[i].hidden, unfolded: shown[i].foldable && shown[i].hidden === 0 && !code.showAll, foldKey: foldKey(n), text: fullText(n, source.sourceLines(n)), unreachable: !!n.unreachable, owner: n.owner, calls: callsOf(n), location: source.locate(n), x: p.x, y: p.y, width: p.width, height: p.height };
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
    dependences: dependencesOf(cfg),
    // Room for the function's name, written to the right of the start circle.
    width: Math.max(layout.width, ...cfg.nodes.filter((n) => n.kind === 'start').map((n) => layout.nodes.get(n.id)!.x + TERMINAL + 16 + cfg.name.length * CHAR)),
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
  return nodeAtPosition(chart, normalizePath(sourceFile.fileName), line, character);
}

/** The node whose code holds the line and character, innermost first. */
export function nodeAtPosition(chart: ControlFlowChart, file: string, line: number, character: number): number | undefined {
  const inside = chart.nodes.filter((n) => n.location && n.location.file === file && n.kind !== 'start' && (line > n.location.line || (line === n.location.line && character >= n.location.character)) && (line < n.location.endLine || (line === n.location.endLine && character <= n.location.endCharacter)));
  const sizeOf = (n: (typeof inside)[number]) => (n.location!.endLine - n.location!.line) * 1000 + (n.location!.endCharacter - n.location!.character);
  return inside.sort((a, b) => sizeOf(a) - sizeOf(b))[0]?.id;
}

/**
 * The control flow as a Mermaid flowchart (top to bottom): decisions as hexagons, start and end as circles,
 * loop edges dotted, unreachable code dashed, a highlighted path drawn thick.
 */
export function chartMermaid(chart: ControlFlowChart, highlight?: { nodes: number[]; edges: number[] }, withDependences = false): string {
  const escape = mermaidText;
  const lines = ['flowchart TD'];
  for (const n of chart.nodes) {
    const text = `"${n.lines.map(escape).join('<br/>')}"`;
    const shape = n.kind === 'decision' || n.kind === 'switch' || n.kind === 'loop' ? `{{${text}}}` : n.kind === 'start' || n.kind === 'end' ? `((${text}))` : `[${text}]`;
    lines.push(`  n${n.id}${shape}`);
  }
  chart.edges.forEach((e) => {
    const arrow = e.back ? '-.->' : '-->';
    lines.push(e.label ? `  n${e.from} ${arrow === '-->' ? '--' : '-.'} ${escape(e.label)} ${arrow} n${e.to}` : `  n${e.from} ${arrow} n${e.to}`);
  });
  const unreachable = chart.nodes.filter((n) => n.unreachable).map((n) => `n${n.id}`);
  if (unreachable.length) lines.push('  classDef unreachable stroke-dasharray: 4 4,opacity:0.6', `  class ${unreachable.join(',')} unreachable`);
  if (withDependences) {
    // After the flow edges: data arcs labeled by variable, then control arcs, each kind in its own color.
    let index = chart.edges.length;
    const data: number[] = [];
    const control: number[] = [];
    for (const d of chart.dependences.data) {
      lines.push(`  n${d.from} -. ${escape(d.name)} .-> n${d.to}`);
      data.push(index++);
    }
    for (const c of chart.dependences.control) {
      lines.push(`  n${c.from} -.-> n${c.to}`);
      control.push(index++);
    }
    if (data.length) lines.push(`  linkStyle ${data.join(',')} stroke:#b180d7`);
    if (control.length) lines.push(`  linkStyle ${control.join(',')} stroke:#d18616`);
  }
  if (highlight?.nodes.length) {
    lines.push('  classDef onPath stroke-width:3px', `  class ${highlight.nodes.map((n) => `n${n}`).join(',')} onPath`);
    for (const e of highlight.edges) lines.push(`  linkStyle ${e} stroke-width:3px`);
  }
  return lines.join('\n');
}
