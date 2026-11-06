import * as ts from 'typescript';
import type { IntentionAction, TextEdit } from './intentions';
import { binaryPrecedence, containsInScope, endsWithJump, indentLines, negate, precedence, statementLines, unparen, wrap } from './syntax';

/** What an intention sees: the cursor and the nodes around it, innermost first. */
export interface IntentionContext {
  readonly sourceFile: ts.SourceFile;
  readonly position: number;
  readonly indentUnit: string;
  readonly ancestors: ts.Node[];
  nearest<T extends ts.Node>(guard: (node: ts.Node) => node is T, filter?: (node: T) => boolean): T | undefined;
  text(node: ts.Node): string;
  indentOf(node: ts.Node): string;
  onHeader(statement: ts.Statement): boolean;
  replace(node: ts.Node, text: string): TextEdit;
}

type Run = (ctx: IntentionContext) => IntentionAction | undefined;

/** Intentions beyond the first set, each registered right after its function. */
export const moreIntentions: { id: string; title: string; run: Run }[] = [];

/** A reference without side effects, safe to repeat: `x`, `this.x`, `a.b.c`. */
function isSimple(e: ts.Expression): boolean {
  const u = unparen(e);
  return ts.isIdentifier(u) || u.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(u) && !u.questionDotToken && isSimple(u.expression));
}

/** The minimum precedence an expression needs to stand where `node` is without changing how it parses. */
function requiredPrecedence(node: ts.Node): number {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return binaryPrecedence(parent.operatorToken.kind) + (parent.right === node ? 1 : 0);
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isAwaitExpression(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent)) return 15;
  if (ts.isPropertyAccessExpression(parent) || (ts.isElementAccessExpression(parent) && parent.expression === node) || (ts.isCallExpression(parent) && parent.expression === node)) return 17;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return 3;
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) return 11;
  return 1;
}

/** Expressions that are already true or false, so `c ? true : false` can become plain `c`. */
function isBooleanish(e: ts.Expression): boolean {
  const u = unparen(e);
  if (u.kind === ts.SyntaxKind.TrueKeyword || u.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(u)) return u.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isBinaryExpression(u)) {
    const k = u.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) return isBooleanish(u.left) && isBooleanish(u.right);
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
    ].includes(k);
  }
  return false;
}

/** Every node below `node`, entering nested functions too. */
function everyNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    everyNode(child, visit);
  });
}

const isAssignmentOperator = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** Whether code below `scope` assigns to a variable named `name` (conservatively, any assignment to that name). */
function isAssigned(scope: ts.Node, name: string): boolean {
  let assigned = false;
  everyNode(scope, (node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = unparen(node.left);
      if ((ts.isIdentifier(left) && left.text === name) || ((ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) && new RegExp(`\\b${name}\\b`).test(left.getText()))) {
        assigned = true;
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(unparen(node.operand)) && (unparen(node.operand) as ts.Identifier).text === name) {
      assigned = true;
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isIdentifier(node.initializer) && node.initializer.text === name) {
      assigned = true;
    }
  });
  return assigned;
}

/** Single-quoted or double-quoted JavaScript string for a value. */
function quote(value: string, q: "'" | '"'): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return q + escaped.split(q).join('\\' + q) + q;
}

function ternaryToNullish(ctx: IntentionContext): IntentionAction | undefined {
  const t = ctx.nearest(ts.isConditionalExpression);
  const c = t && unparen(t.condition);
  if (!t || !c || !ts.isBinaryExpression(c)) return undefined;
  const isNull = (e: ts.Expression) => e.kind === ts.SyntaxKind.NullKeyword;
  const subject = isNull(c.right) ? c.left : isNull(c.left) ? c.right : undefined;
  if (!subject || !isSimple(subject)) return undefined;
  const op = c.operatorToken.kind;
  const [value, fallback] = op === ts.SyntaxKind.ExclamationEqualsToken ? [t.whenTrue, t.whenFalse] : op === ts.SyntaxKind.EqualsEqualsToken ? [t.whenFalse, t.whenTrue] : [];
  if (!value || !fallback || ctx.text(unparen(value)) !== ctx.text(unparen(subject))) return undefined;
  // `??` can't be mixed with `&&` or `||` without parentheses.
  const f = unparen(fallback);
  const mixed = ts.isBinaryExpression(f) && (f.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || f.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  const right = mixed ? `(${ctx.text(f)})` : wrap(ctx.text(fallback), binaryPrecedence(ts.SyntaxKind.QuestionQuestionToken) + 1);
  return { id: 'ternaryToNullish', title: "Replace '?:' with '??'", edits: [ctx.replace(t, `${ctx.text(unparen(subject))} ?? ${right}`)] };
}
moreIntentions.push({ id: 'ternaryToNullish', title: 'Replace \'?:\' with \'??\'', run: ternaryToNullish });

function optionalChain(ctx: IntentionContext): IntentionAction | undefined {
  const binary = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);
  if (!binary || !isSimple(binary.left)) return undefined;
  const right = unparen(binary.right);
  if (!(ts.isPropertyAccessExpression(right) || ts.isElementAccessExpression(right) || ts.isCallExpression(right))) return undefined;
  const left = ctx.text(unparen(binary.left));
  const rest = ctx.text(right);
  const tail = rest.startsWith(`${left}.`) ? rest.slice(left.length + 1) : rest.startsWith(`${left}[`) ? rest.slice(left.length) : undefined;
  if (tail === undefined) return undefined;
  // Only where the result is used as a condition: `a && a.b` is `a` itself when `a` is falsy, `a?.b` is undefined.
  let node: ts.Node = binary;
  while (ts.isParenthesizedExpression(node.parent) || (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) || (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken)) node = node.parent;
  const p = node.parent;
  const condition = ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === node) || (ts.isConditionalExpression(p) && p.condition === node) || (ts.isForStatement(p) && p.condition === node);
  if (!condition) return undefined;
  return { id: 'optionalChain', title: `Replace '${left} && …' with '${left}?.'`, edits: [ctx.replace(binary, `${left}?.${tail}`)] };
}
moreIntentions.push({ id: 'optionalChain', title: 'Replace \'&&\' check with \'?.\'', run: optionalChain });
