import { Cfg } from './controlFlow';
import { definitions, uses } from './defUse';
import { controlDependents } from './slice';

/**
 * The program dependence graph of a function, on its control flow graph:
 * - data dependences: from a box that assigns a variable to each box that reads that value (the assignment reaches
 *   the read along some path without being overwritten), named by the variable;
 * - control dependences: from a decision to each box that runs only for some of its branches.
 * Together they answer "why can this line run, and where did its values come from?"
 */
export interface Dependences {
  data: { from: number; to: number; name: string }[];
  control: { from: number; to: number }[];
  /** More dependences than are drawn: the rest were left out to keep the chart readable. */
  truncated: boolean;
}

/** At most this many arcs of each kind are drawn. */
export const maxDependences = 400;

export function dependencesOf(cfg: Cfg): Dependences {
  const ids = cfg.nodes.map((n) => n.id);
  const preds = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of cfg.edges) preds.get(e.to)!.push(e.from);
  const defined = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' || n.kind === 'end' ? new Set<string>() : definitions(n)]));
  const used = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' || n.kind === 'end' ? new Set<string>() : uses(n)]));

  // Reaching definitions: the assignments (box and name) that may hold when each box starts.
  const key = (id: number, name: string) => `${id}\u0000${name}`;
  const reachIn = new Map<number, Set<string>>(ids.map((id) => [id, new Set()]));
  const reachOut = new Map<number, Set<string>>(ids.map((id) => [id, new Set([...defined.get(id)!].map((name) => key(id, name)))]));
  for (let changed = true, rounds = 0; changed && rounds < ids.length + 5; rounds++) {
    changed = false;
    for (const id of ids) {
      const incoming = new Set<string>();
      for (const p of preds.get(id)!) for (const d of reachOut.get(p)!) incoming.add(d);
      reachIn.set(id, incoming);
      const kills = defined.get(id)!;
      const out = new Set([...defined.get(id)!].map((name) => key(id, name)));
      for (const d of incoming) if (!kills.has(d.slice(d.indexOf('\u0000') + 1))) out.add(d);
      if (out.size !== reachOut.get(id)!.size) {
        reachOut.set(id, out);
        changed = true;
      }
    }
  }

  const data: Dependences['data'] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const id of ids) {
    const reads = used.get(id)!;
    if (!reads.size) continue;
    for (const d of reachIn.get(id)!) {
      const at = d.indexOf('\u0000');
      const name = d.slice(at + 1);
      const from = Number(d.slice(0, at));
      if (!reads.has(name) || from === id) continue;
      const k = `${from}>${id}>${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (data.length >= maxDependences) {
        truncated = true;
        continue;
      }
      data.push({ from, to: id, name });
    }
  }

  const control: Dependences['control'] = [];
  for (const [from, dependents] of controlDependents(cfg)) {
    for (const to of dependents) {
      const node = cfg.nodes[to];
      if (!node || node.kind === 'end' || node.kind === 'start') continue;
      if (control.length >= maxDependences) {
        truncated = true;
        continue;
      }
      control.push({ from, to });
    }
  }
  return { data, control, truncated };
}
