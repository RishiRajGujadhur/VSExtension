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

function indexOfToIncludes(ctx: IntentionContext): IntentionAction | undefined {
  const binary = ctx.nearest(ts.isBinaryExpression, (b) => {
    const call = unparen(b.left);
    return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'indexOf' && call.arguments.length === 1;
  });
  if (!binary) return undefined;
  const call = unparen(binary.left) as ts.CallExpression;
  const right = ctx.text(binary.right).replace(/\s/g, '');
  const op = ctx.text(binary.operatorToken);
  const present = (['!==', '!=', '>'].includes(op) && right === '-1') || (op === '>=' && right === '0');
  const absent = (['===', '=='].includes(op) && right === '-1') || (op === '<' && right === '0');
  if (!present && !absent) return undefined;
  const includes = `${ctx.text((call.expression as ts.PropertyAccessExpression).expression)}.includes(${ctx.text(call.arguments[0])})`;
  return { id: 'indexOfToIncludes', title: "Replace 'indexOf' check with 'includes'", edits: [ctx.replace(binary, present ? includes : `!${includes}`)] };
}
moreIntentions.push({ id: 'indexOfToIncludes', title: 'Replace \'indexOf\' check with \'includes\'', run: indexOfToIncludes });

function removeElseAfterReturn(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  if (!statement?.elseStatement || !endsWithJump(ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement])) return undefined;
  const parent = statement.parent;
  if (!(ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent))) return undefined;
  const lines = statementLines(statement.elseStatement, ctx.sourceFile);
  return {
    id: 'removeElseAfterReturn',
    title: "Remove redundant 'else'",
    edits: [{ start: statement.thenStatement.end, end: statement.end, text: `\n${indentLines(lines, ctx.indentOf(statement))}` }],
  };
}
moreIntentions.push({ id: 'removeElseAfterReturn', title: 'Remove \'else\' after \'return\'', run: removeElseAfterReturn });

function letToConst(ctx: IntentionContext): IntentionAction | undefined {
  const list = ctx.nearest(ts.isVariableDeclarationList, (l) => (l.flags & ts.NodeFlags.Let) !== 0 && ctx.position <= l.declarations[0].name.end);
  if (!list) return undefined;
  const inForOf = ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent);
  if (!inForOf && !ts.isVariableStatement(list.parent)) return undefined;
  if (!list.declarations.every((d) => ts.isIdentifier(d.name) && (inForOf || d.initializer))) return undefined;
  const scope = inForOf ? list.parent : list.parent.parent;
  if (list.declarations.some((d) => isAssigned(scope, (d.name as ts.Identifier).text))) return undefined;
  const keyword = list.getFirstToken(ctx.sourceFile)!;
  return { id: 'letToConst', title: "Replace 'let' with 'const'", edits: [{ start: keyword.getStart(ctx.sourceFile), end: keyword.end, text: 'const' }] };
}
moreIntentions.push({ id: 'letToConst', title: 'Replace \'let\' with \'const\'', run: letToConst });

function varToLet(ctx: IntentionContext): IntentionAction | undefined {
  const list = ctx.nearest(ts.isVariableDeclarationList, (l) => (l.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 && ctx.position <= l.declarations[0].name.end);
  if (!list || !ts.isVariableStatement(list.parent) || !list.declarations.every((d) => ts.isIdentifier(d.name))) return undefined;
  const block = list.parent.parent;
  // Hoisting must not matter: every use comes after the declaration and stays inside its block, and nothing redeclares it.
  let functionScope: ts.Node = block;
  while (!ts.isSourceFile(functionScope) && !ts.isFunctionLike(functionScope)) functionScope = functionScope.parent;
  const names = list.declarations.map((d) => (d.name as ts.Identifier).text);
  let safe = true;
  everyNode(functionScope, (node) => {
    if (!ts.isIdentifier(node) || !names.includes(node.text)) return;
    const p = node.parent;
    if ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node)) return;
    if (ts.isVariableDeclaration(p) && p.name === node && !list.declarations.includes(p)) safe = false;
    if (node.getStart(ctx.sourceFile) < list.declarations[0].name.getStart(ctx.sourceFile) || node.getStart(ctx.sourceFile) >= block.end) safe = false;
  });
  if (!safe) return undefined;
  const keyword = list.getFirstToken(ctx.sourceFile)!;
  return { id: 'varToLet', title: "Replace 'var' with 'let'", edits: [{ start: keyword.getStart(ctx.sourceFile), end: keyword.end, text: 'let' }] };
}
moreIntentions.push({ id: 'varToLet', title: 'Replace \'var\' with \'let\'', run: varToLet });

function arrowToFunction(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isVariableStatement);
  const list = statement?.declarationList;
  const declaration = list?.declarations.length === 1 ? list.declarations[0] : undefined;
  const arrow = declaration?.initializer && ts.isArrowFunction(declaration.initializer) ? declaration.initializer : undefined;
  if (!statement || !declaration || !arrow || !ts.isIdentifier(declaration.name) || declaration.type || !(list!.flags & ts.NodeFlags.Const) || ctx.position > declaration.name.end) return undefined;
  if (!(ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent))) return undefined;
  // An arrow shares `this` and `arguments` with its surroundings, a function does not.
  let usesThis = false;
  const check = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword || (ts.isIdentifier(node) && node.text === 'arguments') || ts.isMetaProperty(node)) usesThis = true;
    if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isClassLike(node)) ts.forEachChild(node, check);
  };
  check(arrow.body);
  if (usesThis) return undefined;
  const indent = ctx.indentOf(statement);
  const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? 'export ' : '';
  const isAsync = arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const typeParameters = arrow.typeParameters ? `<${arrow.typeParameters.map((t) => ctx.text(t)).join(', ')}>` : '';
  const returnType = arrow.type ? `: ${ctx.text(arrow.type)}` : '';
  const body = ts.isBlock(arrow.body) ? ctx.text(arrow.body) : `{\n${indent}${ctx.indentUnit}return ${ctx.text(unparen(arrow.body))};\n${indent}}`;
  const text = `${exported}${isAsync}function ${declaration.name.text}${typeParameters}(${arrow.parameters.map((p) => ctx.text(p)).join(', ')})${returnType} ${body}`;
  return { id: 'arrowToFunction', title: 'Convert to function declaration', edits: [ctx.replace(statement, text)] };
}
moreIntentions.push({ id: 'arrowToFunction', title: 'Convert arrow function to function declaration', run: arrowToFunction });

function objectShorthand(ctx: IntentionContext): IntentionAction | undefined {
  const property = ctx.nearest(ts.isPropertyAssignment, (p) => ts.isIdentifier(p.name) && ts.isIdentifier(p.initializer) && p.name.text === p.initializer.text);
  return property && { id: 'objectShorthand', title: `Use shorthand '${ctx.text(property.name)}'`, edits: [ctx.replace(property, ctx.text(property.name))] };
}
moreIntentions.push({ id: 'objectShorthand', title: 'Use property shorthand', run: objectShorthand });
