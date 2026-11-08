import ts = require('typescript');
import { CfgNode } from './controlFlow';
import { isFunctionWithBody } from '../structure/util';

/**
 * What a control flow box assigns and reads, by name: the basis of slices (src/inspect/slice.ts) and of the
 * impossible-path check (src/inspect/paths.ts). Computed once per box and remembered.
 */

/** The syntax of a box that runs when it runs: a loop's header, not its body. */
export function own(node: CfgNode): ts.Node[] {
  if (node.kind !== 'loop') return node.nodes;
  return node.nodes.flatMap((n) => {
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) return [n.initializer, n.expression];
    if (ts.isForStatement(n)) return [n.condition, n.incrementor].filter((x): x is ts.Expression => !!x);
    if (ts.isWhileStatement(n)) return [n.expression];
    return [n];
  });
}

const defsCache = new WeakMap<CfgNode, Set<string>>();
const usesCache = new WeakMap<CfgNode, Set<string>>();

const rootName = (e: ts.Node): string | undefined => {
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
};

/** Names a box assigns: declarations, assignments (also to a property of it), ++ and --, and calls on it. */
export function definitions(node: CfgNode): Set<string> {
  const cached = defsCache.get(node);
  if (cached) return cached;
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
  defsCache.set(node, names);
  return names;
}

/** Names a box reads: identifiers outside declarations' names, property names, types and plain `x =` targets. */
export function uses(node: CfgNode): Set<string> {
  const cached = usesCache.get(node);
  if (cached) return cached;
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
  usesCache.set(node, names);
  return names;
}

