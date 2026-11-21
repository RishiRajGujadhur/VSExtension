import * as path from 'path';
import type { FlowSnapshot, ReelPlan, ReelScene } from '../reel/plan';
import { secondsFor } from '../reel/plan';
import type { CodeExplanation } from './explainCode';

/**
 * The explanation of a function as a video, for the Git reel's player and voice-over: the title, then one scene per
 * step on the function's flowchart (this step's boxes in amber, the steps before it in green, the view on this
 * step), then what it is for. Made from the explanation alone, on this computer.
 */
export function explanationReel(e: CodeExplanation, file: string): ReelPlan | undefined {
  if (!e.walk || !e.steps.length) return undefined;
  const { chart, name, nodes } = e.walk;
  // A purpose of one word ("Polls" for poll) only says the name again: left out.
  const purpose = e.purpose && /\s/.test(e.purpose.text.trim()) ? e.purpose.text.charAt(0).toLowerCase() + e.purpose.text.slice(1) : undefined;
  const scenes: ReelScene[] = [];
  const opening = [e.summary, purpose ? `In short, it ${purpose}.` : '', "Let's walk through it, step by step."].filter(Boolean).join(' ');
  scenes.push({ kind: 'overview', id: 'overview', caption: opening, captionSource: 'heuristic', seconds: secondsFor(opening) + 1 });
  const done = new Set<number>();
  e.steps.forEach((step, i) => {
    const current = new Set(nodes[i] ?? []);
    const flow: FlowSnapshot = {
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
      })),
      edges: chart.edges.map((edge) => ({ points: edge.points, back: edge.back })),
      newPaths: 0,
      gonePaths: 0,
      paths: chart.paths.length,
      truncated: chart.truncated,
    };
    for (const id of current) done.add(id);
    scenes.push({
      kind: 'flow',
      id: `step-${i + 1}`,
      chapter: `Step ${i + 1}`,
      file,
      symbol: name,
      flow,
      legend: `Step ${i + 1}: the box in amber, with the steps so far in green`,
      caption: step,
      captionSource: 'heuristic',
      seconds: secondsFor(step) + 1,
    });
  });
  const closing = purpose ? `That is ${name}: it ${purpose}.` : `That is what ${name} does.`;
  scenes.push({ kind: 'summary', id: 'summary', points: e.steps.slice(0, 5), caption: closing, captionSource: 'heuristic', seconds: secondsFor(closing, 6) });
  return {
    version: 1,
    meta: { title: `What ${name}() does`, base: 'explained', head: name, additions: 0, deletions: 0, files: 1, skipped: 0, chip: path.basename(file), subtitle: 'Explained step by step, on your computer' },
    scenes,
  };
}
