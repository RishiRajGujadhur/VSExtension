import * as path from 'path';
import type { FlowSnapshot, ReelPlan, ReelScene } from '../reel/plan';
import { secondsFor } from '../reel/plan';
import type { CodeExplanation } from './explainCode';

/**
 * The explanation of a function as a video, for the Git reel's player and voice-over. Essential information only:
 *
 * - an opening card with the function's signature, and what it is (and is for, when known), nothing more;
 * - a scene per step on the function's flowchart: steps on the same box are one scene, and steps that say little
 *   ("It uses the config.") are left out when there are others. The view glides from the step before, the step is
 *   labelled by kind (a decision, a loop, a return, what happens if something fails, in red), its code is typed in
 *   under the chart, and dots show how far the walk has come;
 *
 * Made from the explanation alone, on this computer.
 */
export function explanationReel(e: CodeExplanation, file: string): ReelPlan | undefined {
  if (!e.walk || !e.steps.length) return undefined;
  const { chart, name, nodes, signature } = e.walk;
  // A purpose of one word ("Polls" for poll) only says the name again: left out.
  const purpose = e.purpose && /\s/.test(e.purpose.text.trim()) ? e.purpose.text.charAt(0).toLowerCase() + e.purpose.text.slice(1) : undefined;
  const steps = walkSteps(e.steps, nodes);
  const scenes: ReelScene[] = [];
  const opening = [e.summary, purpose ? `It ${purpose}.` : ''].filter(Boolean).join(' ') || `${name}, step by step.`;
  scenes.push({ kind: 'overview', id: 'overview', caption: opening, captionSource: 'heuristic', seconds: secondsFor(opening) });
  const snapshot = (current: Set<number>, done: Set<number>, extra: Partial<FlowSnapshot>): FlowSnapshot => ({
    width: chart.width,
    height: chart.height,
    walk: true,
    nodes: chart.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      kind: n.kind,
      state: current.has(n.id) ? 'changed' : done.has(n.id) ? 'added' : 'same',
      label: n.kind === 'start' ? chart.name : n.kind === 'end' ? '' : (n.lines[0] ?? '').trim(),
      ...(boxIcon(n.kind, n.text || n.lines.join('\n')) ? { icon: boxIcon(n.kind, n.text || n.lines.join('\n')) } : {}),
    })),
    edges: chart.edges.map((edge) => ({ points: edge.points, back: edge.back, from: edge.from, to: edge.to })),
    newPaths: 0,
    gonePaths: 0,
    paths: chart.paths.length,
    truncated: chart.truncated,
    ...extra,
  });
  const done = new Set<number>();
  let before: number[] = [];
  steps.forEach((step, i) => {
    const current = new Set(step.nodes);
    const kind = stepKind(step.text, step.nodes.map((id) => chart.nodes[id]?.kind));
    const flow = snapshot(current, done, { from: before, tone: kind.tone });
    for (const id of current) done.add(id);
    before = [...current];
    // Where the step's code is, for the scene's Open button (locations count lines from 0, scenes from 1).
    const located = step.nodes.map((id) => chart.nodes[id]?.location).find((l) => l);
    // The step's code the boxes do not show (a box shows its first line): never the same line twice on screen.
    // Whole source lines (a box wraps long ones), so the strip never starts mid-statement.
    const labels = new Set(step.nodes.map((id) => (chart.nodes[id]?.lines[0] ?? '').trim()));
    const code = step.nodes
      .flatMap((id) => (chart.nodes[id]?.text || chart.nodes[id]?.lines.join('\n') || '').split('\n').map((l) => l.trim().replace(/;$/, '')))
      .filter((l) => l && !labels.has(l) && !/^[{}()[\];,]+$/.test(l))
      .slice(0, 3);
    scenes.push({
      kind: 'flow',
      id: `step-${i + 1}`,
      chapter: `Step ${i + 1}`,
      file,
      symbol: name,
      flow,
      badge: kind.label,
      legend: '',
      code,
      progress: { index: i, total: steps.length },
      ...(located ? { line: located.line + 1 } : {}),
      caption: step.text,
      captionSource: 'heuristic',
      seconds: secondsFor(step.text, code.length),
    });
  });
  // No ending card: the video ends on its last step (what the function is for is said at the start).
  return {
    version: 1,
    meta: { title: `What ${name}() does`, base: 'explained', head: name, additions: 0, deletions: 0, files: 1, skipped: 0, chip: path.basename(file), ...(signature ? { signature } : { subtitle: 'Step by step' }) },
    scenes,
  };
}

/** A step that says little: "It uses the config.", "Then it uses the abort." */
const thin = (text: string) => /^(It|Then it) (uses|works out) the [\w' ]+\.$/.test(text);

/**
 * The steps worth a scene: thin ones left out (when others are left), and steps on the same boxes as the step
 * before joined into one ("It creates a new abort controller, and sets the active request to the request.").
 */
export function walkSteps(texts: string[], nodes: number[][]): { text: string; nodes: number[] }[] {
  const all = texts.map((text, i) => ({ text, nodes: nodes[i] ?? [] }));
  const kept = all.filter((s) => !thin(s.text)).length >= 2 ? all.filter((s) => !thin(s.text)) : all;
  const out: { text: string; nodes: number[]; joined: number }[] = [];
  for (const step of kept) {
    const last = out[out.length - 1];
    const same = last && step.nodes.length && step.nodes.every((id) => last.nodes.includes(id));
    // Two steps at most in one scene: a third starts a scene of its own on the same box.
    if (same && last.joined < 2 && /^(It|Then it) /.test(step.text)) {
      last.text = `${last.text.replace(/\.$/, '')}, and ${step.text.replace(/^(It|Then it) /, '')}`;
      last.joined++;
    } else out.push({ text: step.text, nodes: [...step.nodes], joined: 1 });
  }
  return out.map(({ text, nodes }) => ({ text, nodes }));
}

/** What kind of step it is, for its chip and how its boxes glow. */
export function stepKind(text: string, kinds: (string | undefined)[]): { label: string; tone: 'step' | 'decision' | 'exit' | 'error' } {
  if (/^If something goes wrong|^Then it/.test(text) || kinds.includes('catch')) return { label: 'If it fails', tone: 'error' };
  if (kinds.includes('throw') || /\bthrows\b/.test(text)) return { label: 'Throws', tone: 'error' };
  if (kinds.includes('decision') || kinds.includes('switch') || /^If /.test(text)) return { label: 'Decision', tone: 'decision' };
  if (kinds.includes('loop')) return { label: 'Loop', tone: 'step' };
  if (kinds.includes('return') || /\breturns\b/.test(text)) return { label: 'Returns', tone: 'exit' };
  return { label: 'Step', tone: 'step' };
}

/** Icons by what the code in a box does, the first that matches: a codicon name. */
const ICONS: [RegExp, string][] = [
  [/\b(fetch|axios|apiCall|api\.\w+|request\(|http\w*\.|HttpClient\b|\.(get|post|put|patch|delete)\(\s*['"`/]|\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync|GetStringAsync|GetFromJsonAsync|PostAsJsonAsync)\()/i, 'cloud'],
  [/\b(localStorage|sessionStorage|indexedDB|\.save\(|\.persist|db\.|repository\.|SaveChanges|INSERT\b|UPDATE\b|DELETE\s+FROM)/i, 'database'],
  [/\b(readFile|writeFile|appendFile|existsSync|mkdir|unlink|fs\.|createReadStream|createWriteStream)|\b(File|Directory)\.\w+\(/, 'file'],
  [/\bJSON\.(parse|stringify)/, 'json'],
  [/\b(notify|showMessageBox|showInformationMessage|showWarningMessage|showErrorMessage|alert|toast|Notification)\b/, 'bell'],
  [/\b(console\.\w+|logger\.\w+|log\(|Log\(|Console\.Write\w*|Debug\.Write\w*|_?logger\.Log\w*)/, 'output'],
  [/\b(setTimeout|setInterval|clearTimeout|clearInterval|delay\(|sleep\(|wait\(|Date\.now|performance\.now|Task\.Delay|Thread\.Sleep|DateTime\.(Now|UtcNow))/, 'watch'],
  [/\.(abort|cancel)\(/, 'circle-slash'],
  [/\b(navigate|router\.(push|replace)|location\.href|redirect|openExternal)\b/, 'arrow-right'],
  [/\b(emit|dispatch|postMessage|send|publish)\(/, 'broadcast'],
  [/\.(push|unshift|splice|filter|map|reduce|sort|concat)\(|\[\s*\.\.\./, 'list-unordered'],
  [/\bnew\s+[A-Z]\w*/, 'add'],
  [/\b(password|token|auth|login|logout|permission|role)\w*/i, 'lock'],
];

/**
 * The icon for a box of the flowchart: by its kind (a decision, a loop, a return, a throw, a catch), else by what
 * its code does (a request, a save, a file, a notification…), else none.
 */
export function boxIcon(kind: string, code: string): string | undefined {
  if (kind === 'decision') return 'question';
  if (kind === 'switch') return 'list-selection';
  if (kind === 'loop') return 'sync';
  if (kind === 'throw') return 'warning';
  if (kind === 'catch') return 'shield';
  if (kind === 'finally') return 'check-all';
  if (kind === 'start' || kind === 'end') return undefined;
  for (const [pattern, icon] of ICONS) if (pattern.test(code)) return icon;
  if (kind === 'return') return 'sign-out';
  // A value set, or a call: an edit, or a function run.
  if (/^\s*(const|let|var)?\s*[\w$.[\]]+\s*[+\-*/]?=[^=]/.test(code)) return 'edit';
  if (/[\w$]\s*\(/.test(code)) return 'symbol-method';
  return undefined;
}
