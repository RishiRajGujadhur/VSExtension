/**
 * Top-to-bottom layout for flowcharts such as a control flow graph: nodes in rows by their distance from the
 * start, ordered within each row to reduce crossings, each under the nodes that lead to it. Edges that go back up
 * (loops) are routed along the right side so they do not cross the chart.
 */

export interface LayoutNode {
  id: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: number;
  to: number;
  /** Goes back to an earlier node, such as the end of a loop body returning to the loop. */
  back?: boolean;
}

export interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
}

export interface Route {
  /** Points the edge passes through; draw as a curve for two points and as a line with rounded corners for more. */
  points: { x: number; y: number }[];
  /** Where its label goes. */
  label: { x: number; y: number };
}

export interface FlowLayout {
  nodes: Map<number, Placed>;
  routes: Route[];
  width: number;
  height: number;
}

const ROW_GAP = 56;
const COLUMN_GAP = 36;
const BACK_GAP = 18;

export function layoutFlow(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], start: number, end?: number): FlowLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const forward = edges.filter((e) => !e.back && e.from !== e.to);
  const out = new Map<number, number[]>();
  const into = new Map<number, number[]>();
  for (const e of forward) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  }

  // Discovery order, and edges that close a cycle the caller did not mark (treated as back edges).
  const order: number[] = [];
  const state = new Map<number, 'open' | 'done'>();
  const cyclic = new Set<string>();
  const visit = (id: number) => {
    state.set(id, 'open');
    order.push(id);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 'open') cyclic.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
  };
  visit(start);
  // Nodes nothing reaches (dead code) are laid out after, from their own first node.
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  const isForward = (from: number, to: number) => !cyclic.has(`${from}>${to}`);

  // Rows: one below the deepest node leading here; the end node goes last.
  const row = new Map<number, number>();
  // Discovery order is already a topological order of the forward edges.
  const topological = order;
  const settle = () => {
    for (let changed = true, guard = 0; changed && guard < nodes.length + 2; guard++) {
      changed = false;
      for (const id of topological) {
        const preds = (into.get(id) ?? []).filter((p) => isForward(p, id) && row.has(p));
        const r = preds.length ? Math.max(...preds.map((p) => row.get(p)! + 1)) : (row.get(id) ?? 0);
        if (row.get(id) !== r) {
          row.set(id, r);
          changed = true;
        }
      }
    }
  };
  for (const id of order) row.set(id, 0);
  settle();
  if (end !== undefined && row.has(end)) {
    row.set(end, Math.max(...[...row.entries()].filter(([id]) => id !== end).map(([, r]) => r)) + 1);
  }

  const rows: number[][] = [];
  for (const id of order) (rows[row.get(id)!] ??= []).push(id);
  for (let r = 0; r < rows.length; r++) rows[r] ??= [];

  // Order within rows: a few sweeps placing each node at the average position of its neighbors.
  const position = new Map<number, number>();
  const index = () => rows.forEach((ids) => ids.forEach((id, i) => position.set(id, i)));
  index();
  const average = (ids: number[], fallback: number) => (ids.length ? ids.reduce((s, id) => s + position.get(id)!, 0) / ids.length : fallback);
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? rows.map((_, r) => r) : rows.map((_, r) => rows.length - 1 - r);
    for (const r of range) {
      const ids = rows[r];
      const key = new Map(ids.map((id) => [id, average(down ? (into.get(id) ?? []).filter((p) => row.get(p)! < r) : (out.get(id) ?? []).filter((s) => row.get(s)! > r), position.get(id)!)]));
      ids.sort((a, b) => key.get(a)! - key.get(b)! || position.get(a)! - position.get(b)!);
      ids.forEach((id, i) => position.set(id, i));
    }
  }

  // Coordinates: rows top to bottom; within a row each node centered under its parents, without overlaps.
  const placed = new Map<number, Placed>();
  let y = 0;
  for (let r = 0; r < rows.length; r++) {
    const ids = rows[r];
    const height = Math.max(0, ...ids.map((id) => byId.get(id)!.height));
    const wanted = ids.map((id) => {
      const parents = (into.get(id) ?? []).filter((p) => placed.has(p) && isForward(p, id));
      return parents.length ? parents.reduce((s, p) => s + placed.get(p)!.x + placed.get(p)!.width / 2, 0) / parents.length : 0;
    });
    const xs: number[] = [];
    ids.forEach((id, i) => {
      const width = byId.get(id)!.width;
      const left = wanted[i] - width / 2;
      xs.push(i === 0 ? left : Math.max(left, xs[i - 1] + byId.get(ids[i - 1])!.width + COLUMN_GAP));
    });
    // Shift the row so that, on average, nodes sit where their parents want them.
    const shift = ids.length ? ids.reduce((s, id, i) => s + (wanted[i] - (xs[i] + byId.get(id)!.width / 2)), 0) / ids.length : 0;
    ids.forEach((id, i) => {
      const node = byId.get(id)!;
      placed.set(id, { x: xs[i] + shift, y: y + (height - node.height) / 2, width: node.width, height: node.height, row: r });
    });
    y += height + ROW_GAP;
  }

  // Normalize so the chart starts at (0, 0).
  const minX = Math.min(...[...placed.values()].map((p) => p.x));
  for (const p of placed.values()) p.x -= minX;
  let right = Math.max(...[...placed.values()].map((p) => p.x + p.width));

  // Routes: forward edges leave the bottom (spread when a node has several), back edges run down the right side.
  const routes: Route[] = [];
  let lane = 0;
  // Each node's downward edges, sorted by where they go, found once rather than for every edge.
  const downward = new Map<number, number[]>();
  for (const e of edges) {
    if (!e.back && placed.get(e.to)!.row > placed.get(e.from)!.row) downward.set(e.from, [...(downward.get(e.from) ?? []), placed.get(e.to)!.x]);
  }
  for (const xs of downward.values()) xs.sort((p, q) => p - q);
  for (const e of edges) {
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    const back = e.back || !isForward(e.from, e.to) || b.row <= a.row;
    if (!back) {
      // Several branches leave from points spread along the bottom, ordered by where they go.
      const sorted = downward.get(e.from) ?? [b.x];
      const siblings = sorted;
      const slot = sorted.length > 1 ? sorted.indexOf(b.x) : 0;
      const sx = sorted.length > 1 ? a.x + (a.width * (slot + 1)) / (sorted.length + 1) : a.x + a.width / 2;
      const from = { x: sx, y: a.y + a.height };
      const to = { x: b.x + b.width / 2, y: b.y };
      // With three or more branches the labels sit halfway, where the edges have spread apart.
      const t = siblings.length > 2 ? 0.55 : 0.3;
      routes.push({ points: [from, to], label: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } });
    } else {
      // Out of the source's right side, right of everything in between, up, and into the target's right side.
      const top = Math.min(a.y, b.y);
      const bottom = Math.max(a.y + a.height, b.y + b.height);
      const between = [...placed.values()].filter((p) => p.y + p.height >= top && p.y <= bottom);
      const x = Math.max(...between.map((p) => p.x + p.width)) + BACK_GAP + lane * 12;
      lane++;
      const from = { x: a.x + a.width, y: a.y + a.height / 2 };
      const to = { x: b.x + b.width, y: b.y + b.height / 2 };
      routes.push({ points: [from, { x, y: from.y }, { x, y: to.y }, to], label: { x: x + 4, y: (from.y + to.y) / 2 } });
      right = Math.max(right, x + 20);
    }
  }
  const height = Math.max(...[...placed.values()].map((p) => p.y + p.height));
  return { nodes: placed, routes, width: right, height };
}
