import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ts = require('typescript');
import { ControlFlowChart, standaloneCharts } from '../inspect/controlFlowChart';
import { compareCharts, findSameFunction, FlowComparison, shortName } from '../inspect/flowCompare';
import { isFunctionWithBody } from '../structure/util';
import { csharpFlowChart } from '../csharp/flow';
import { tsqlFlowChart } from '../tsql/flow';
import { AnalysisError } from '../analysis/types';
import { describeFileChange, describeFunctionChange, differingSpan } from './describe';

/**
 * A Git reel: a short video of a change, as a plan the player draws. The video is a pure function of this plan, so it
 * can be edited (captions), kept and tested. Everything in it comes from Git and Code X-Ray's own analysis: no
 * model, nothing leaves the machine, and the same change always gives the same plan.
 */
export interface ReelPlan {
  version: 1;
  meta: {
    title: string;
    /** What it is compared with, as people say it: "main", "the last commit". */
    base: string;
    /** The branch, or "working tree". */
    head: string;
    additions: number;
    deletions: number;
    files: number;
    /** Files left out: lock files, build output, binaries, secrets. */
    skipped: number;
  };
  scenes: ReelScene[];
}

export type CaptionSource = 'heuristic' | 'user';

interface SceneBase {
  /** Stable across rebuilds of the same change, so captions edited by hand stay on their scene. */
  id: string;
  caption: string;
  captionSource: CaptionSource;
  seconds: number;
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap';
  text: string;
  /** Line number in the new file (old file for removed lines). */
  line?: number;
  /** In a line changed in place, where the words that changed are: [start, end) in `text`. */
  span?: [number, number];
}

/** A function's flowchart now, with what changed since the base marked, laid out as the Flowchart view lays it out. */
export interface FlowSnapshot {
  width: number;
  height: number;
  nodes: { x: number; y: number; width: number; height: number; kind: string; state: 'added' | 'changed' | 'same'; label: string }[];
  edges: { points: { x: number; y: number }[]; back: boolean }[];
  newPaths: number;
  gonePaths: number;
  paths: number;
  /** More paths than were listed. */
  truncated?: boolean;
}

export type ReelScene =
  | (SceneBase & { kind: 'overview' })
  | (SceneBase & { kind: 'diff'; file: string; symbol?: string; added: number; removed: number; lines: DiffLine[]; isNew?: boolean; line?: number })
  /** A function's flowchart on its own, after its code: zoomed to the boxes that changed. */
  | (SceneBase & { kind: 'flow'; file: string; symbol: string; flow: FlowSnapshot; line?: number })
  | (SceneBase & { kind: 'files'; files: { file: string; added: number; removed: number; status: string }[] })
  | (SceneBase & { kind: 'summary'; points: string[] });

/** What the reel compares: the working tree (with untracked files) against a revision. */
export interface ReelRequest {
  repo: string;
  /** A revision: HEAD, a merge base, HEAD~1. */
  ref: string;
  /** As people say it: "the last commit", "main". */
  baseLabel: string;
  /** At most this many function or file scenes; the rest are listed on one card. */
  maxScenes?: number;
}

const MAX_SCENES = 8;
/** Lines of diff a scene shows at most; the rest are summed up. */
const MAX_LINES = 40;
/** A reel lasts about a minute at most. */
const MAX_SECONDS = 90;

// ---------------------------------------------------------------------------------------------------------------
// Git

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new AnalysisError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`, 'git');
  }
}

interface ChangedFile {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  binary: boolean;
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'untracked';
}

/** `git diff --numstat -z -M` against the revision, then the untracked files (as added). */
export function changedFiles(repo: string, ref: string): ChangedFile[] {
  const raw = git(repo, ['diff', '--numstat', '-z', '-M', ref, '--']);
  const parts = raw.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const [a, d, name] = record.split('\t');
    const binary = a === '-' && d === '-';
    if (name === '' || name === undefined) {
      // A rename: the old and new paths follow.
      const oldPath = parts[++i];
      const newPath = parts[++i];
      files.push({ path: newPath, oldPath, added: Number(a) || 0, removed: Number(d) || 0, binary, status: 'renamed' });
    } else files.push({ path: name, added: Number(a) || 0, removed: Number(d) || 0, binary, status: 'modified' });
  }
  // Added and deleted, from the name-status list.
  const status = git(repo, ['diff', '--name-status', '-z', '--no-renames', ref, '--']).split('\0');
  for (let i = 0; i + 1 < status.length; i += 2) {
    const file = files.find((f) => f.path === status[i + 1]);
    if (file && status[i] === 'A') file.status = 'added';
    if (file && status[i] === 'D') file.status = 'deleted';
  }
  for (const name of git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    const full = path.join(repo, name);
    let text: Buffer;
    try {
      text = fs.readFileSync(full);
    } catch {
      continue;
    }
    const binary = text.subarray(0, 8000).includes(0);
    files.push({ path: name, added: binary ? 0 : text.toString('utf8').split('\n').length, removed: 0, binary, status: 'untracked' });
  }
  return files;
}

/** Files a reel leaves out: lock files, build output, minified and generated code, maps, secrets and binaries. */
export function skipReason(file: ChangedFile): string | undefined {
  const name = file.path.replace(/\\/g, '/');
  const base = name.split('/').pop() ?? name;
  if (file.binary) return 'binary';
  if (/^\.env(\..*)?$/.test(base) || /\.(pem|key|p12|pfx)$/i.test(base)) return 'secret';
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|packages\.lock\.json)$/.test(base) || base.endsWith('.lock')) return 'lock file';
  if (/(^|\/)(node_modules|dist|out|build|coverage|bin|obj|\.next|\.codexray)\//.test(name)) return 'build output';
  if (/\.min\.(js|css)$|\.map$|\.(g|designer|generated)\.cs$|\.d\.ts$/.test(base)) return 'generated';
  return undefined;
}

/** Values that look like secrets in code shown on screen, masked: `apiKey = "••••"`, long tokens, private keys. */
export function redact(line: string): string {
  return line
    .replace(/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth|credential|private[_-]?key|connection[_-]?string)\w*["']?\s*[:=]\s*)(["'`])([^"'`]{3,})\2/gi, (_, key, quote) => `${key}${quote}••••${quote}`)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA••••')
    .replace(/\b(?:ghp|gho|github_pat|sk|xox[abp])_[A-Za-z0-9_]{16,}\b/g, '••••')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g, '-----BEGIN PRIVATE KEY----- ••••')
    .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '••••' : m));
}

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/**
 * Marks the words that changed in lines changed in place: in each run of removed lines followed by added lines, the
 * first removed line pairs with the first added one, and so on; a pair alike enough gets the differing span marked.
 */
export function markChangedWords(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].kind === 'add') a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const [from, to] = differingSpan(dels[k].text, adds[k].text);
      // Not a line changed in place when most of it differs.
      if (from.length > dels[k].text.trim().length * 0.7 || to.length > adds[k].text.trim().length * 0.7) continue;
      dels[k].span = spanOf(dels[k].text, from);
      adds[k].span = spanOf(adds[k].text, to);
    }
    i = a;
  }
}

/** Where a changed part sits in its line: the last place it occurs that leaves the common start alone. */
function spanOf(line: string, part: string): [number, number] | undefined {
  if (!part) return undefined;
  const at = line.indexOf(part);
  return at < 0 ? undefined : [at, at + part.length];
}

/** The hunks of one file's diff, with line numbers. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith('\\')) continue;
    const text = redact(raw.slice(1).replace(/\r$/, ''));
    if (raw.startsWith('+')) hunk.lines.push({ kind: 'add', text, line: newLine++ });
    else if (raw.startsWith('-')) hunk.lines.push({ kind: 'del', text, line: oldLine++ });
    else if (raw.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', text, line: newLine++ });
      oldLine++;
    }
  }
  for (const h of hunks) markChangedWords(h.lines);
  return hunks;
}

// ---------------------------------------------------------------------------------------------------------------
// Functions and their flowcharts

type Language = 'ts' | 'csharp' | 'tsql';

function languageOf(file: string): Language | undefined {
  const ext = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) return 'ts';
  if (ext === '.cs') return 'csharp';
  if (ext === '.sql') return 'tsql';
  return undefined;
}

/** Draws the chart of the function at an offset of a text, in the file's language; each text parsed once. */
function chartMaker(language: Language, file: string): (text: string, offset: number) => Promise<ControlFlowChart> {
  if (language === 'csharp') return (text, offset) => csharpFlowChart(text, file, offset);
  if (language === 'tsql') return async (text, offset) => tsqlFlowChart(text, file, offset);
  const parsed = new Map<string, ReturnType<typeof standaloneCharts>>();
  return async (text, offset) => {
    let charts = parsed.get(text);
    if (!charts) parsed.set(text, (charts = standaloneCharts(file, text)));
    return charts(offset);
  };
}

const lineOffsets = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
};

/**
 * Where to ask for the function a line is in. TypeScript: the start of the innermost named function around the line
 * (an unnamed callback belongs to the function it is in), so a call on the line is not taken for the called function.
 * C# and T-SQL: the first character of the line.
 */
function functionOffsetsFor(language: Language, file: string, text: string): (line: number) => number | undefined {
  const starts = lineOffsets(text);
  const lineStart = (line: number) => starts[Math.max(0, Math.min(starts.length - 1, line - 1))];
  if (language !== 'ts') {
    return (line) => {
      const at = lineStart(line);
      const rest = text.slice(at, starts[line] ?? text.length);
      return at + (rest.length - rest.trimStart().length);
    };
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions: { start: number; end: number; anchor: number; named: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionWithBody(node)) {
      const parent = node.parent;
      const named = !!(node as ts.FunctionLikeDeclaration).name || (!!parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)));
      const anchor = (node as ts.FunctionLikeDeclaration).name?.getStart(source) ?? (parent && ts.isVariableDeclaration(parent) ? parent.name.getStart(source) : node.getStart(source));
      functions.push({ start: node.getStart(source), end: node.end, anchor, named });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (line) => {
    const at = lineStart(line);
    const end = starts[line] ?? text.length;
    const around = functions.filter((f) => f.start <= at + (text.slice(at, end).length - text.slice(at, end).trimStart().length) && f.end >= end - 1);
    // Innermost named, else innermost.
    const named = around.filter((f) => f.named);
    const pick = (list: typeof around) => list.sort((a, b) => b.start - a.start)[0];
    return (pick(named) ?? pick(around))?.anchor;
  };
}

function snapshot(chart: ControlFlowChart, comparison: FlowComparison): FlowSnapshot | undefined {
  if (chart.nodes.length > 160) return undefined;
  const added = new Set(comparison.added);
  const changed = new Set(comparison.changed.map((c) => c.id));
  return {
    width: chart.width,
    height: chart.height,
    nodes: chart.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      kind: n.kind,
      state: added.has(n.id) ? 'added' : changed.has(n.id) ? 'changed' : 'same',
      label: n.kind === 'start' ? chart.name : n.kind === 'end' ? '' : (n.lines[0] ?? '').trim(),
    })),
    edges: chart.edges.map((e) => ({ points: e.points, back: e.back })),
    newPaths: comparison.newPaths.length,
    gonePaths: comparison.gonePaths.length,
    paths: chart.paths.length,
    truncated: chart.truncated,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Captions and timing

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "checkout(): 2 new boxes, 1 changed · 1 new path, 2 gone", from the flow comparison. */
export function flowCaption(symbol: string, comparison: FlowComparison, added: number, removed: number): string {
  if (comparison.isNew) return `New: ${symbol}() with ${plural(comparison.newPaths.length, 'path')}`;
  const boxes = [comparison.added.length ? plural(comparison.added.length, 'new box', 'new boxes') : '', comparison.changed.length ? `${plural(comparison.changed.length, 'box', 'boxes')} changed` : '', comparison.removed.length ? `${plural(comparison.removed.length, 'box', 'boxes')} removed` : ''].filter(Boolean).join(', ');
  const paths = [comparison.newPaths.length ? plural(comparison.newPaths.length, 'new path') : '', comparison.gonePaths.length ? `${plural(comparison.gonePaths.length, 'path')} gone` : ''].filter(Boolean).join(', ');
  const parts = [boxes, paths].filter(Boolean);
  return parts.length ? `${symbol}(): ${parts.join(' · ')}` : `${symbol}(): same flow, +${added} −${removed} lines`;
}

/** Seconds a scene stays: long enough to read its caption, plus time for its code. */
function secondsFor(caption: string, lines = 0): number {
  return Math.round(Math.min(9, Math.max(3, 1.6 + caption.length / 22 + lines * 0.12)) * 10) / 10;
}

/** "feat/retry-checkout" → "Retry checkout". */
export function titleFromBranch(branch: string): string {
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/^(feat|fix|chore|refactor)[-_]/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

/** Builds the reel of the working tree's changes since `ref`. */
export async function buildReelPlan(request: ReelRequest): Promise<ReelPlan> {
  const { repo, ref } = request;
  const maxScenes = request.maxScenes ?? MAX_SCENES;
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const all = changedFiles(repo, ref);
  const kept = all.filter((f) => !skipReason(f));
  const skipped = all.length - kept.length;

  type Candidate = Extract<ReelScene, { kind: 'diff' }> & { weight: number; follow?: Extract<ReelScene, { kind: 'flow' }> };
  const candidates: Candidate[] = [];
  const fileRows: Extract<ReelScene, { kind: 'files' }>['files'] = [];
  for (const file of kept) {
    fileRows.push({ file: file.path, added: file.added, removed: file.removed, status: file.status });
    if (file.status === 'deleted') continue;
    const full = path.join(repo, file.path);
    let now: string;
    try {
      now = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const diffText = file.status === 'untracked' ? '' : git(repo, ['diff', '-M', '-U3', ref, '--', ...(file.oldPath ? [file.oldPath] : []), file.path]);
    const hunks = file.status === 'untracked' ? [{ oldStart: 0, newStart: 1, lines: now.split('\n').map((text, i) => ({ kind: 'add' as const, text: redact(text.replace(/\r$/, '')), line: i + 1 })) }] : parseHunks(diffText);
    if (!hunks.length) continue;
    const language = languageOf(file.path);
    // Changed lines grouped by the function they are in; lines outside any function stay with the file.
    const groups = new Map<number | 'file', Hunk[]>();
    const offsetOf = language ? functionOffsetsFor(language, full, now) : () => undefined;
    for (const hunk of hunks) {
      const changed = hunk.lines.find((l) => l.kind === 'add') ?? hunk.lines.find((l) => l.kind === 'ctx' && l.line && l.line >= hunk.newStart) ?? hunk.lines[0];
      const line = changed.kind === 'del' ? hunk.newStart : changed.line ?? hunk.newStart;
      const key = offsetOf(line) ?? 'file';
      groups.set(key, [...(groups.get(key) ?? []), hunk]);
    }
    let before: string | undefined;
    const beforeText = () => {
      if (before === undefined) {
        try {
          before = file.status === 'added' || file.status === 'untracked' ? '' : git(repo, ['show', `${ref}:${(file.oldPath ?? file.path).replace(/\\/g, '/')}`]);
        } catch {
          before = '';
        }
      }
      return before;
    };
    const chartAt = language ? chartMaker(language, full) : undefined;
    for (const [key, list] of groups) {
      const lines = joinHunks(list);
      const added = lines.filter((l) => l.kind === 'add').length;
      const removed = lines.filter((l) => l.kind === 'del').length;
      const base = path.basename(file.path);
      if (key !== 'file' && chartAt) {
        try {
          const chart = await chartAt(now, key);
          // A function without a name (a wrapper, a callback) is shown as the file's code.
          if (!shortName(chart.name)) throw new Error('unnamed');
          const old = beforeText() ? await findSameFunction({ text: now, chart }, beforeText(), chartAt) : { chart: undefined };
          const compared = compareCharts(old.chart, chart);
          // Past the limit of paths listed, comparing them says nothing: only the boxes count then.
          const comparison = chart.truncated || old.chart?.truncated ? { ...compared, newPaths: [], gonePaths: [] } : compared;
          const symbol = chart.name.replace(/\(\)$/, '');
          // What the code change does, in sentences; the flowchart scene after it gives the counts.
          const sentences = describeFunctionChange(symbol, chart, comparison, 4, lines);
          const caption = sentences.length ? `${symbol}(): ${sentences.join(' ')}` : flowCaption(symbol, comparison, added, removed);
          const flow = snapshot(chart, comparison);
          const changedBoxes = comparison.added.length + comparison.changed.length;
          const line = firstChangedLine(lines);
          const flowScene: Extract<ReelScene, { kind: 'flow' }> | undefined =
            flow && changedBoxes ? { kind: 'flow', id: `${file.path}#${symbol}#flow`, file: file.path, symbol, flow, line, caption: flowCaption(symbol, comparison, added, removed), captionSource: 'heuristic', seconds: 5 } : undefined;
          candidates.push({
            kind: 'diff', id: `${file.path}#${symbol}`, file: file.path, symbol, added, removed, isNew: comparison.isNew, line,
            lines: trimLines(lines), caption, captionSource: 'heuristic', seconds: secondsFor(caption, Math.min(lines.length, MAX_LINES)),
            weight: 40 + Math.min(added + removed, 80) + comparison.added.length * 3 + comparison.changed.length * 2, follow: flowScene,
          });
          continue;
        } catch {
          // Not a function the flowchart can draw: shown as code.
        }
      }
      const isNew = file.status === 'added' || file.status === 'untracked';
      const sentences = describeFileChange(file.path, lines.filter((l) => l.kind === 'add').map((l) => l.text), lines.filter((l) => l.kind === 'del').map((l) => l.text), isNew);
      const caption = `${base}: ${sentences.join(' ')}`;
      candidates.push({ kind: 'diff', id: `${file.path}#${key === 'file' ? 'file' : key}`, file: file.path, added, removed, line: firstChangedLine(lines), lines: trimLines(lines), caption, captionSource: 'heuristic', seconds: secondsFor(caption, Math.min(lines.length, MAX_LINES)), weight: Math.min(added + removed, 60) });
    }
  }

  // The biggest changes get scenes (a function with its flowchart before a file's lines), in the order of the files;
  // the rest are listed on one card.
  const chosen = new Set([...candidates].sort((a, b) => b.weight - a.weight).slice(0, maxScenes));
  const chosenList = candidates.filter((c) => chosen.has(c));
  const diffScenes = chosenList.map(({ weight: _weight, follow: _follow, ...scene }) => scene);
  const flowScenes = chosenList.map((c) => c.follow).filter((f): f is Extract<ReelScene, { kind: 'flow' }> => !!f);
  const others = candidates.filter((c) => !chosen.has(c));
  const additions = kept.reduce((n, f) => n + f.added, 0);
  const deletions = kept.reduce((n, f) => n + f.removed, 0);
  const head = branch === 'HEAD' ? 'detached HEAD' : branch;
  // On a working branch its name says what it is about; on main, the latest commit does.
  const subject = () => git(repo, ['log', '-1', '--format=%s']).trim();
  const title = ref === 'HEAD' ? 'Uncommitted changes' : /^(main|master|develop|trunk|detached HEAD)$/.test(head) ? subject() || head : titleFromBranch(head);
  const scenes: ReelScene[] = [];
  const overview = `${head} → ${request.baseLabel}: ${plural(kept.length, 'file')} changed (+${additions} / −${deletions})${skipped ? `, ${skipped} left out` : ''}.`;
  scenes.push({ kind: 'overview', id: 'overview', caption: overview, captionSource: 'heuristic', seconds: secondsFor(overview) + 1 });
  // Each function's code, then its flowchart.
  for (const scene of diffScenes) {
    scenes.push(scene);
    const flowScene = flowScenes.find((f) => f.id === `${scene.id}#flow`);
    if (flowScene) scenes.push(flowScene);
  }
  if (others.length || fileRows.length > new Set(diffScenes.map((s) => s.file)).size) {
    const caption = others.length ? `${plural(others.length, 'other change')} in ${plural(new Set(others.map((o) => o.file)).size, 'file')}` : 'Every file changed';
    scenes.push({ kind: 'files', id: 'files', files: fileRows.slice(0, 14), caption, captionSource: 'heuristic', seconds: secondsFor(caption, Math.min(fileRows.length, 14)) });
  }
  const flows = flowScenes;
  const points = [
    `${plural(kept.length, 'file')}, +${additions} / −${deletions} lines`,
    flows.length ? `${plural(flows.length, 'function')} with a new flow: ${flows.reduce((n, s) => n + (s.flow?.newPaths ?? 0), 0)} new paths, ${flows.reduce((n, s) => n + (s.flow?.gonePaths ?? 0), 0)} gone` : '',
    diffScenes.filter((s) => s.isNew).length ? `New: ${diffScenes.filter((s) => s.isNew).map((s) => `${s.symbol}()`).slice(0, 3).join(', ')}` : '',
    skipped ? `${plural(skipped, 'file')} left out (lock files, build output, secrets, binaries)` : '',
  ].filter(Boolean);
  const summary = `In short: ${points[0]}.`;
  scenes.push({ kind: 'summary', id: 'summary', points, caption: summary, captionSource: 'heuristic', seconds: secondsFor(summary, points.length * 2) });
  fitDuration(scenes, MAX_SECONDS);
  return { version: 1, meta: { title, base: request.baseLabel, head, additions, deletions, files: kept.length, skipped }, scenes };
}

/** Shortens the change scenes (not below three seconds) so the whole reel lasts at most `max` seconds. */
export function fitDuration(scenes: ReelScene[], max: number): void {
  const total = scenes.reduce((n, s) => n + s.seconds, 0);
  if (total <= max) return;
  const flexible = scenes.filter((s) => s.kind === 'diff' || s.kind === 'flow');
  const fixed = total - flexible.reduce((n, s) => n + s.seconds, 0);
  const room = Math.max(flexible.length * 3, max - fixed);
  const factor = room / Math.max(1, total - fixed);
  for (const s of flexible) s.seconds = Math.round(Math.max(3, s.seconds * factor) * 10) / 10;
}

/** The first added or removed line, for opening the code at the change. */
function firstChangedLine(lines: DiffLine[]): number | undefined {
  return lines.find((l) => l.kind === 'add')?.line ?? lines.find((l) => l.kind === 'del')?.line;
}

/** One list of a group's hunks, with a gap marker between them. */
function joinHunks(hunks: Hunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  hunks.forEach((h, i) => {
    if (i) out.push({ kind: 'gap', text: '⋯' });
    out.push(...h.lines);
  });
  return out;
}

/** At most MAX_LINES lines, keeping the changed ones and a line of context around them. */
function trimLines(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_LINES) return lines;
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del') for (const j of [i - 1, i, i + 1]) keep.add(j);
  });
  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((l, i) => {
    if (keep.has(i) && out.length < MAX_LINES) {
      out.push(l);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: 'gap', text: '⋯' });
      skipping = true;
    }
  });
  const left = lines.filter((l, i) => (l.kind === 'add' || l.kind === 'del') && !out.includes(l)).length || 0;
  if (left) out.push({ kind: 'gap', text: `⋯ ${plural(left, 'more changed line')}` });
  return out.slice(0, MAX_LINES + 1);
}

/**
 * Keeps the captions written by hand in a rebuilt plan: a scene with the same id takes the earlier caption back.
 */
export function keepUserCaptions(fresh: ReelPlan, earlier: ReelPlan | undefined): ReelPlan {
  if (!earlier) return fresh;
  const written = new Map(earlier.scenes.filter((s) => s.captionSource === 'user').map((s) => [s.id, s.caption]));
  return { ...fresh, scenes: fresh.scenes.map((s) => (written.has(s.id) ? { ...s, caption: written.get(s.id)!, captionSource: 'user' } : s)) };
}
