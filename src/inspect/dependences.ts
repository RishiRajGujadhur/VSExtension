import ts = require('typescript');
import { Cfg, CfgNode } from './controlFlow';
import { definitions, own, uses } from './defUse';
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
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) bindingNames(n.name).forEach((name) => names.add(name));
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const name = rootName(n.left);
      if (name) names.add(name);
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      const name = rootName(n.operand);
      if (name) names.add(name);
    }
    if (!isFunctionWithBody(n)) ts.forEachChild(n, visit);
  };
  own(node).forEach(visit);
  return names;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

export function dependencesOf(cfg: Cfg): Dependences {
  const ids = cfg.nodes.map((n) => n.id);
  const preds = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of cfg.edges) preds.get(e.to)?.push(e.from);
  const terminal = (n: CfgNode) => n.kind === 'start' || n.kind === 'end';
  // The start of the function sets its parameters.
  const parameters = new Set(cfg.fn.parameters.flatMap((p) => bindingNames(p.name)));
  const defined = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' ? new Set(parameters) : terminal(n) ? new Set<string>() : definitions(n)]));
  const kills = new Map(cfg.nodes.map((n) => [n.id, n.kind === 'start' ? new Set(parameters) : terminal(n) ? new Set<string>() : replaced(n)]));
  const used = new Map(cfg.nodes.map((n) => [n.id, terminal(n) ? new Set<string>() : uses(n)]));

  // Reaching definitions: the settings (box and name) that may hold when each box starts.
  const key = (id: number, name: string) => `${id}\u0000${name}`;
  const nameOf = (d: string) => d.slice(d.indexOf('\u0000') + 1);
  const reachIn = new Map<number, Set<string>>(ids.map((id) => [id, new Set()]));
  const reachOut = new Map<number, Set<string>>(ids.map((id) => [id, new Set([...defined.get(id)!].map((name) => key(id, name)))]));
  for (let changed = true, rounds = 0; changed && rounds < ids.length + 5; rounds++) {
    changed = false;
    for (const id of ids) {
      const incoming = new Set<string>();
      for (const p of preds.get(id)!) for (const d of reachOut.get(p)!) incoming.add(d);
      reachIn.set(id, incoming);
      const killed = kills.get(id)!;
      const out = new Set([...defined.get(id)!].map((name) => key(id, name)));
      for (const d of incoming) if (!killed.has(nameOf(d))) out.add(d);
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
      const name = nameOf(d);
      const from = Number(d.slice(0, d.indexOf('\u0000')));
      if (!reads.has(name) || from === id) continue;
      const k = `${from}>${id}>${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (data.length >= maxDependences) {
        truncated = true;
        continue;
      }
      data.push({ from, to: id, name, ...(from === cfg.start ? { parameter: true } : {}) });
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
