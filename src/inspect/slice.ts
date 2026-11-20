import ts = require('typescript');
import { Cfg, FlowGraph, buildCfg, cfgNodeAt } from './controlFlow';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { enclosingFunction, identifierAt } from '../structure/util';
import { definitions, uses } from './defUse';

/**
 * Program slices within one function, on its control flow graph:
 * - backward: the boxes whose assignments can reach the variable at the cursor, and the decisions that control
 *   whether they run (what affects this value);
 * - forward: the boxes that read the variable or values computed from it, and what the decisions it affects
 *   control (what this value affects).
 * Variables are matched by name within the function, and box by box.
 */
export interface Slice {
  direction: 'backward' | 'forward';
  name: string;
  cfg: Cfg;
  /** The box the cursor is in. */
  at: number;
  /** Boxes in the slice, including the one at the cursor. */
  nodes: number[];
}

/**
 * For each box, the boxes control-dependent on it: those that run only for some of its branches.
 *
 * From the post-dominator tree (a box post-dominates another when every path from the other to the end passes through
 * it), built with Cooper, Harvey and Kennedy's iterative algorithm, which stays quick on long functions. For each
 * branch A → B, the boxes from B up the tree to A's immediate post-dominator (not included) run only when A takes
 * that branch.
 */
export function controlDependents(cfg: FlowGraph): Map<number, Set<number>> {
  const succ = new Map<number, number[]>();
  const pred = new Map<number, number[]>();
  for (const e of cfg.edges) {
    succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);
    pred.set(e.to, [...(pred.get(e.to) ?? []), e.from]);
  }
  // Reverse postorder of the reversed graph, from the end (iteratively: long functions would overflow the stack).
  const order: number[] = [];
  const visited = new Set<number>([cfg.end]);
  const stack: { id: number; next: number }[] = [{ id: cfg.end, next: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const preds = pred.get(top.id) ?? [];
    if (top.next < preds.length) {
      const p = preds[top.next++];
      if (!visited.has(p)) {
        visited.add(p);
        stack.push({ id: p, next: 0 });
      }
    } else {
      order.push(top.id);
      stack.pop();
    }
  }
  const rpo = order.reverse();
  const rank = new Map(rpo.map((id, i) => [id, i]));
  const ipdom = new Map<number, number>([[cfg.end, cfg.end]]);
  const intersect = (a: number, b: number) => {
    while (a !== b) {
      while (rank.get(a)! > rank.get(b)!) a = ipdom.get(a)!;
      while (rank.get(b)! > rank.get(a)!) b = ipdom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of rpo) {
      if (id === cfg.end) continue;
      const done = (succ.get(id) ?? []).filter((s) => ipdom.has(s));
      if (!done.length) continue;
      const idom = done.slice(1).reduce((acc, s) => intersect(s, acc), done[0]);
      if (ipdom.get(id) !== idom) {
        ipdom.set(id, idom);
        changed = true;
      }
    }
  }
  const dependents = new Map<number, Set<number>>();
  for (const [id, next] of succ) {
    const branches = [...new Set(next)];
    if (branches.length < 2) continue;
    const stop = ipdom.get(id);
    const set = new Set<number>();
    for (const b of branches) {
      // Up the tree from the branch to where every branch of A meets again.
      for (let runner: number | undefined = b; runner !== undefined && runner !== stop; ) {
        set.add(runner);
        const up: number | undefined = ipdom.get(runner);
        runner = up === runner ? undefined : up;
      }
    }
    set.delete(id);
    dependents.set(id, set);
  }
  return dependents;
}

function reach(cfg: Cfg, from: number, forward: boolean): Set<number> {
  const next = new Map<number, number[]>();
  for (const e of cfg.edges) {
    const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set<number>();
  const queue = [from];
  while (queue.length) {
    for (const b of next.get(queue.pop()!) ?? []) {
      if (!seen.has(b)) {
        seen.add(b);
        queue.push(b);
      }
    }
  }
  return seen;
}

export function sliceOf(cfg: Cfg, at: number, name: string, direction: 'backward' | 'forward'): number[] {
  const dependents = controlDependents(cfg);
  const controllers = new Map<number, number[]>();
  for (const [decision, set] of dependents) for (const y of set) controllers.set(y, [...(controllers.get(y) ?? []), decision]);
  const defs = new Map(cfg.nodes.map((n) => [n.id, definitions(n)]));
  const used = new Map(cfg.nodes.map((n) => [n.id, uses(n)]));
  const inSlice = new Set<number>([at]);
  const vars = new Set<string>([name]);
  if (direction === 'backward') {
    const before = reach(cfg, at, false);
    before.add(at);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...before, ...inSlice]) {
        const add = (n: number) => {
          if (inSlice.has(n)) return;
          inSlice.add(n);
          used.get(n)!.forEach((v) => vars.add(v));
          changed = true;
        };
        if (before.has(id) && [...defs.get(id)!].some((v) => vars.has(v)) && id !== cfg.start) add(id);
        // A box in the slice brings in the decisions that decide whether it runs.
        if (inSlice.has(id)) for (const c of controllers.get(id) ?? []) add(c);
      }
    }
  } else {
    const after = reach(cfg, at, true);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of after) {
        if (inSlice.has(id) || id === cfg.end) continue;
        const affected = [...used.get(id)!].some((v) => vars.has(v)) || (controllers.get(id) ?? []).some((c) => inSlice.has(c));
        if (affected) {
          inSlice.add(id);
          defs.get(id)!.forEach((v) => vars.add(v));
          changed = true;
        }
      }
    }
  }
  inSlice.delete(cfg.end);
  return [...inSlice].sort((a, b) => a - b);
}

/** The slice for the variable at the cursor, in the function around it. */
export function sliceAt(project: VirtualProject, fileName: string, offset: number, direction: 'backward' | 'forward'): Slice {
  const sourceFile = project.sourceFile(fileName);
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a variable or parameter.');
  const fn = enclosingFunction(identifier);
  if (!fn) throw new AnalysisError('Place the cursor inside a function: a slice follows the code of one function.');
  const cfg = buildCfg(fn);
  const at = cfgNodeAt(cfg, sourceFile, offset)?.id ?? (ts.isParameter(identifier.parent) ? cfg.start : undefined);
  if (at === undefined) throw new AnalysisError('The cursor is not in a statement of the function.');
  return { direction, name: identifier.text, cfg, at, nodes: sliceOf(cfg, at, identifier.text, direction) };
}
