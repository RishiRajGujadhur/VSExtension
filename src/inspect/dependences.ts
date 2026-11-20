import ts = require('typescript');
import { Cfg, CfgNode, FlowGraph } from './controlFlow';
import { definitions, own, uses, writtenExpression } from './defUse';
import { controlDependents } from './slice';
import { isFunctionWithBody } from '../structure/util';

/**
 * The program dependence graph of a function, on its control flow graph:
 * - data dependences: from a box that sets a variable to each box that reads that value (the value reaches the read
 *   along some path without being replaced), named by the variable; parameters come from the start of the function;
 * - control dependences: from a decision to each box that runs only for some of its branches.
 * Together they answer "why can this line run, and where did its values come from?"
 */
export interface Dependences {
  data: { from: number; to: number; name: string; parameter?: boolean }[];
  control: { from: number; to: number }[];
  /** More dependences than are drawn: the rest were left out to keep the chart readable. */
  truncated: boolean;
}

/** At most this many arcs of each kind are drawn. */
export const maxDependences = 400;

const rootName = (e: ts.Node): string | undefined => {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
};

/**
 * Names a box gives a new value: declarations, `x = …`, `x += …`, `x++`. Changing a property (`x.a = 1`) or calling a
 * method such as `push` changes the value but doesn't replace it, so assignments before it still reach later reads.
 */
function replaced(node: CfgNode): Set<string> {
  if (node.facts) return node.facts.replaces;
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) bindingNames(n.name).forEach((name) => names.add(name));
    const written = writtenExpression(n);
    const writtenName = written && rootName(written);
    if (writtenName) names.add(writtenName);
    if (!isFunctionWithBody(n)) ts.forEachChild(n, visit);
  };
  own(node).forEach(visit);
  return names;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

export function dependencesOf(cfg: FlowGraph): Dependences {
  const ids = cfg.nodes.map((n) => n.id);
  const preds = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of cfg.edges) preds.get(e.to)?.push(e.from);
  const terminal = (n: CfgNode) => n.kind === 'start' || n.kind === 'end';
  // The start of the function sets its parameters.
  const parameters = new Set('fn' in cfg ? (cfg as Cfg).fn.parameters.flatMap((p) => bindingNames(p.name)) : (cfg.parameters ?? []));
  const defined = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' ? new Set(parameters) : terminal(n) ? new Set<string>() : definitions(n)]));
  const kills = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' ? new Set(parameters) : terminal(n) ? new Set<string>() : replaced(n)]));
  const used = new Map(cfg.nodes.map((n) => [n.id, terminal(n) ? new Set<string>() : uses(n)]));

  // Reaching definitions, one name at a time: only the boxes that set that name travel along the flow, so the sets
  // stay small and a long function stays quick (doing all names at once grew with the cube of the function's size).
  const data: Dependences['data'] = [];
  const seen = new Set<string>();
  let truncated = false;
  const names = new Set<string>();
  for (const reads of used.values()) for (const name of reads) names.add(name);
  const found = new Map<number, { from: number; name: string }[]>();
  for (const name of names) {
    const reachIn = new Map<number, Set<number>>();
    const reachOut = new Map<number, Set<number>>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of ids) {
        const incoming = new Set<number>();
        for (const p of preds.get(id)!) for (const d of reachOut.get(p) ?? []) incoming.add(d);
        reachIn.set(id, incoming);
        // A box that replaces the name starts afresh; one that only changes it adds itself to what reaches it.
        const sets = defined.get(id)!.has(name);
        const out = kills.get(id)!.has(name) ? new Set<number>(sets ? [id] : []) : sets ? new Set([...incoming, id]) : incoming;
        const before = reachOut.get(id);
        if (!before || before.size !== out.size) {
          reachOut.set(id, out);
          changed = true;
        }
      }
    }
    for (const id of ids) {
      if (!used.get(id)!.has(name)) continue;
      for (const from of reachIn.get(id) ?? []) if (from !== id) found.set(id, [...(found.get(id) ?? []), { from, name }]);
    }
  }
  // In box order, as the arcs are drawn.
  for (const id of ids) {
    for (const { from, name } of found.get(id) ?? []) {
      const k = `${from}>${id}>${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (data.length >= maxDependences) truncated = true;
      else data.push({ from, to: id, name, ...(from === cfg.start ? { parameter: true } : {}) });
    }
  }

  const control: Dependences['control'] = [];
  for (const [from, dependents] of controlDependents(cfg)) {
    for (const to of dependents) {
      const node = cfg.nodes[to];
      if (!node || terminal(node)) continue;
      if (control.length >= maxDependences) {
        truncated = true;
        continue;
      }
      control.push({ from, to });
    }
  }
  return { data, control, truncated };
}
