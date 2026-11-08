import ts = require('typescript');
import { Cfg, CfgNode, buildCfg } from './controlFlow';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { enclosingFunction, identifierAt, isFunctionWithBody } from '../structure/util';

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

/** The syntax of a box that runs when it runs: a loop's header, not its body. */
function own(node: CfgNode): ts.Node[] {
  if (node.kind !== 'loop') return node.nodes;
  return node.nodes.flatMap((n) => {
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) return [n.initializer, n.expression];
    if (ts.isForStatement(n)) return [n.condition, n.incrementor].filter((x): x is ts.Expression => !!x);
    if (ts.isWhileStatement(n)) return [n.expression];
    return [n];
  });
}

const rootName = (e: ts.Node): string | undefined => {
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
};

/** Names a box assigns: declarations, assignments (also to a property of it), ++ and --, and calls on it. */
export function definitions(node: CfgNode): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
    else if (ts.isVariableDeclarationList(n)) n.declarations.forEach((d) => ts.isIdentifier(d.name) && names.add(d.name.text));
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const name = rootName(n.left);
      if (name) names.add(name);
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      const name = rootName(n.operand);
      if (name) names.add(name);
    }
    // items.push(x) changes items.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = rootName(n.expression.expression);
      if (name && /^(push|pop|shift|unshift|splice|sort|reverse|fill|set|add|delete|clear)$/.test(n.expression.name.text)) names.add(name);
    }
    if (!isFunctionWithBody(n)) ts.forEachChild(n, visit);
  };
  own(node).forEach(visit);
  return names;
}

/** Names a box reads: identifiers outside declarations' names, property names, types and plain `x =` targets. */
export function uses(node: CfgNode): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isName = (parent as ts.NamedDeclaration).name === n && !ts.isPropertyAccessExpression(parent);
      const isProperty = (ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n);
      const isPlainTarget = ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!isName && !isProperty && !isPlainTarget) names.add(n.text);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) names.add(n.name.text);
    if (!isFunctionWithBody(n) || n !== own(node)[0]) ts.forEachChild(n, visit);
  };
  own(node).forEach(visit);
  return names;
}

/** For each box, the boxes control-dependent on it: those that run only for some of its branches. */
export function controlDependents(cfg: Cfg): Map<number, Set<number>> {
  const succ = new Map<number, number[]>();
  for (const e of cfg.edges) succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);
  const all = cfg.nodes.map((n) => n.id);
  // Post-dominators: a box post-dominates another when every path from the other to the end passes through it.
  const postdom = new Map<number, Set<number>>(all.map((id) => [id, new Set(id === cfg.end ? [id] : all)]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of all) {
      if (id === cfg.end) continue;
      const next = succ.get(id) ?? [];
      const meet = next.length ? [...postdom.get(next[0])!].filter((d) => next.every((s) => postdom.get(s)!.has(d))) : [];
      const updated = new Set([id, ...meet]);
      if (updated.size !== postdom.get(id)!.size) {
        postdom.set(id, updated);
        changed = true;
      }
    }
  }
  const dependents = new Map<number, Set<number>>();
  for (const id of all) {
    const next = [...new Set(succ.get(id) ?? [])];
    if (next.length < 2) continue;
    const set = new Set<number>();
    for (const s of next) {
      for (const y of postdom.get(s)!) {
        if (y === id || !postdom.get(id)!.has(y)) set.add(y);
      }
    }
    set.delete(id);
    dependents.set(id, set);
  }
  return dependents;
}

function reach(cfg: Cfg, from: number, forward: boolean): Set<number> {
  const seen = new Set<number>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of cfg.edges) {
      const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
      if (a === id && !seen.has(b)) {
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
  const contains = (n: ts.Node) => n.getStart(sourceFile) <= offset && offset <= n.end;
  const candidates = cfg.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end' && own(n).some(contains));
  const fallback = cfg.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end' && n.nodes.some(contains));
  const size = (n: CfgNode) => n.nodes.reduce((t, x) => t + x.end - x.pos, 0);
  const at = (candidates.length ? candidates : fallback).sort((a, b) => size(a) - size(b))[0]?.id ?? (ts.isParameter(identifier.parent) ? cfg.start : undefined);
  if (at === undefined) throw new AnalysisError('The cursor is not in a statement of the function.');
  return { direction, name: identifier.text, cfg, at, nodes: sliceOf(cfg, at, identifier.text, direction) };
}
