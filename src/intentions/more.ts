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

function expandShorthand(ctx: IntentionContext): IntentionAction | undefined {
  const property = ctx.nearest(ts.isShorthandPropertyAssignment, (p) => !p.objectAssignmentInitializer && ts.isObjectLiteralExpression(p.parent));
  return property && { id: 'expandShorthand', title: `Expand to '${property.name.text}: ${property.name.text}'`, edits: [ctx.replace(property, `${property.name.text}: ${property.name.text}`)] };
}
moreIntentions.push({ id: 'expandShorthand', title: 'Expand property shorthand', run: expandShorthand });

function templateToConcat(ctx: IntentionContext): IntentionAction | undefined {
  const template = ctx.nearest(ts.isTemplateExpression);
  if (!template || ts.isTaggedTemplateExpression(template.parent)) return undefined;
  const parts: { text: string; literal: boolean }[] = [];
  const plus = binaryPrecedence(ts.SyntaxKind.PlusToken);
  if (template.head.text) parts.push({ text: quote(template.head.text, "'"), literal: true });
  for (const span of template.templateSpans) {
    parts.push({ text: wrap(ctx.text(span.expression), plus + 1), literal: false });
    if (span.literal.text) parts.push({ text: quote(span.literal.text, "'"), literal: true });
  }
  // Two values in a row would be added, not joined: start with a string.
  if (!parts[0].literal && (parts.length === 1 || !parts[1].literal)) parts.unshift({ text: "''", literal: true });
  const joined = parts.map((p) => p.text).join(' + ');
  return { id: 'templateToConcat', title: "Replace template literal with '+'", edits: [ctx.replace(template, wrap(joined, requiredPrecedence(template)))] };
}
moreIntentions.push({ id: 'templateToConcat', title: 'Replace template literal with \'+\'', run: templateToConcat });

function hasOwn(ctx: IntentionContext): IntentionAction | undefined {
  const call = ctx.nearest(ts.isCallExpression, (c) => ts.isPropertyAccessExpression(c.expression) && (c.expression.name.text === 'hasOwnProperty' || (c.expression.name.text === 'call' && ctx.text(c.expression.expression).replace(/\s/g, '') === 'Object.prototype.hasOwnProperty')));
  if (!call) return undefined;
  const access = call.expression as ts.PropertyAccessExpression;
  const [object, key] = access.name.text === 'call' ? call.arguments : [access.expression, call.arguments[0]];
  if (!object || !key || (access.name.text === 'hasOwnProperty' && call.arguments.length !== 1)) return undefined;
  return { id: 'hasOwn', title: "Replace with 'Object.hasOwn'", edits: [ctx.replace(call, `Object.hasOwn(${ctx.text(object)}, ${ctx.text(key)})`)] };
}
moreIntentions.push({ id: 'hasOwn', title: 'Replace \'hasOwnProperty\' with \'Object.hasOwn\'', run: hasOwn });

function switchToIfChain(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isSwitchStatement, (s) => ctx.position >= s.getStart(ctx.sourceFile) && ctx.position <= s.caseBlock.getStart(ctx.sourceFile));
  if (!statement || !isSimple(statement.expression)) return undefined;
  const subject = ctx.text(unparen(statement.expression));
  const groups: { tests: ts.Expression[] | 'default'; statements: ts.Statement[] }[] = [];
  let pending: ts.Expression[] = [];
  const clauses = statement.caseBlock.clauses;
  for (const [i, clause] of clauses.entries()) {
    if (clause.statements.length === 0 && i < clauses.length - 1) {
      if (ts.isDefaultClause(clause)) return undefined;
      pending.push(clause.expression);
      continue;
    }
    if (ts.isDefaultClause(clause) && i !== clauses.length - 1) return undefined;
    let statements = [...clause.statements];
    const last = statements[statements.length - 1];
    if (last && ts.isBreakStatement(last) && !last.label) statements = statements.slice(0, -1);
    else if (i < clauses.length - 1 && !endsWithJump(statements)) return undefined;
    // Another break would now leave a different statement.
    if (statements.some((s) => ts.isBreakStatement(s) || containsInScope(s, (n) => ts.isBreakStatement(n) && !n.label && !insideLoopOrSwitch(n, s)))) return undefined;
    groups.push({ tests: ts.isDefaultClause(clause) ? 'default' : [...pending, clause.expression], statements });
    pending = [];
  }
  if (groups.length === 0) return undefined;
  const indent = ctx.indentOf(statement);
  const body = (statements: ts.Statement[]) => (statements.length === 0 ? '{}' : `{\n${indentLines(statements.flatMap((s) => statementLines(s, ctx.sourceFile)), indent + ctx.indentUnit)}\n${indent}}`);
  const eq = binaryPrecedence(ts.SyntaxKind.EqualsEqualsEqualsToken);
  const text = groups
    .map((g, i) => (g.tests === 'default' ? (i === 0 ? body(g.statements) : `else ${body(g.statements)}`) : `${i === 0 ? '' : 'else '}if (${g.tests.map((t) => `${subject} === ${wrap(ctx.text(t), eq + 1)}`).join(' || ')}) ${body(g.statements)}`))
    .join(' ');
  return { id: 'switchToIfChain', title: "Replace 'switch' with 'if' chain", edits: [ctx.replace(statement, text)] };
}

function insideLoopOrSwitch(node: ts.Node, root: ts.Node): boolean {
  for (let current = node.parent; current && current !== root; current = current.parent) {
    if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) return true;
  }
  return false;
}
moreIntentions.push({ id: 'switchToIfChain', title: 'Replace \'switch\' with \'if\' chain', run: switchToIfChain });

const compoundOperators = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.PlusToken, '+='], [ts.SyntaxKind.MinusToken, '-='], [ts.SyntaxKind.AsteriskToken, '*='], [ts.SyntaxKind.SlashToken, '/='],
  [ts.SyntaxKind.PercentToken, '%='], [ts.SyntaxKind.AsteriskAsteriskToken, '**='], [ts.SyntaxKind.AmpersandToken, '&='], [ts.SyntaxKind.BarToken, '|='],
  [ts.SyntaxKind.CaretToken, '^='], [ts.SyntaxKind.LessThanLessThanToken, '<<='], [ts.SyntaxKind.GreaterThanGreaterThanToken, '>>='],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, '>>>='], [ts.SyntaxKind.AmpersandAmpersandToken, '&&='], [ts.SyntaxKind.BarBarToken, '||='], [ts.SyntaxKind.QuestionQuestionToken, '??='],
]);

function compoundAssignment(ctx: IntentionContext): IntentionAction | undefined {
  const assignment = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  const right = assignment && unparen(assignment.right);
  if (!assignment || !right || !ts.isBinaryExpression(right) || !compoundOperators.has(right.operatorToken.kind) || !isSimple(assignment.left)) return undefined;
  if (ctx.text(unparen(right.left)) !== ctx.text(unparen(assignment.left))) return undefined;
  const op = compoundOperators.get(right.operatorToken.kind)!;
  return { id: 'compoundAssignment', title: `Replace with '${op}'`, edits: [ctx.replace(assignment, `${ctx.text(assignment.left)} ${op} ${ctx.text(right.right)}`)] };
}
moreIntentions.push({ id: 'compoundAssignment', title: 'Replace \'x = x + y\' with \'x += y\'', run: compoundAssignment });

function expandCompoundAssignment(ctx: IntentionContext): IntentionAction | undefined {
  const assignment = ctx.nearest(ts.isBinaryExpression, (b) => [...compoundOperators.values()].includes(ctx.text(b.operatorToken)));
  if (!assignment || !isSimple(assignment.left)) return undefined;
  const op = ctx.text(assignment.operatorToken);
  const kind = [...compoundOperators].find(([, o]) => o === op)![0];
  const binary = op.slice(0, -1);
  const right = wrap(ctx.text(assignment.right), binaryPrecedence(kind) + 1);
  return { id: 'expandCompoundAssignment', title: `Replace '${op}' with '= … ${binary}'`, edits: [ctx.replace(assignment, `${ctx.text(assignment.left)} = ${ctx.text(assignment.left)} ${binary} ${right}`)] };
}
moreIntentions.push({ id: 'expandCompoundAssignment', title: 'Replace \'x += y\' with \'x = x + y\'', run: expandCompoundAssignment });

function removeParentheses(ctx: IntentionContext): IntentionAction | undefined {
  const paren = ctx.nearest(ts.isParenthesizedExpression);
  if (!paren) return undefined;
  const inner = paren.expression;
  const parent = paren.parent;
  // Places where the parentheses mean something even though precedence allows dropping them.
  if (ts.isObjectLiteralExpression(inner) || ts.isFunctionExpression(inner) || ts.isClassExpression(inner) || ts.isArrowFunction(inner)) return undefined;
  if (ts.isOptionalChain(inner) && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent))) return undefined;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const logic = (k: ts.SyntaxKind) => k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken;
    if (ts.isBinaryExpression(inner) && ((op === ts.SyntaxKind.QuestionQuestionToken && logic(inner.operatorToken.kind)) || (logic(op) && inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))) return undefined;
    if (op === ts.SyntaxKind.AsteriskAsteriskToken && parent.left === paren && (ts.isPrefixUnaryExpression(inner) || ts.isAwaitExpression(inner) || ts.isTypeOfExpression(inner) || ts.isVoidExpression(inner))) return undefined;
  }
  if (ts.isCallExpression(parent) && parent.expression === paren && !ts.isIdentifier(inner) && !ts.isPropertyAccessExpression(inner) && !ts.isCallExpression(inner)) return undefined;
  if (precedence(inner) < requiredPrecedence(paren)) return undefined;
  return { id: 'removeParentheses', title: 'Remove unnecessary parentheses', edits: [ctx.replace(paren, ctx.text(inner))] };
}
moreIntentions.push({ id: 'removeParentheses', title: 'Remove unnecessary parentheses', run: removeParentheses });

function addParentheses(ctx: IntentionContext): IntentionAction | undefined {
  const or = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.BarBarToken && [b.left, b.right].some((o) => ts.isBinaryExpression(o) && o.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));
  if (!or) return undefined;
  const edits = [or.left, or.right].filter((o) => ts.isBinaryExpression(o) && o.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken).map((o) => ctx.replace(o, `(${ctx.text(o)})`));
  return { id: 'addParentheses', title: "Add parentheses to clarify '&&' inside '||'", edits };
}
moreIntentions.push({ id: 'addParentheses', title: 'Add parentheses to mixed \'&&\' and \'||\'', run: addParentheses });

function booleanReturn(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  if (!statement) return undefined;
  const literal = (s: ts.Statement | undefined): boolean | undefined => {
    const only = s && (ts.isBlock(s) ? (s.statements.length === 1 ? s.statements[0] : undefined) : s);
    const e = only && ts.isReturnStatement(only) && only.expression;
    return e ? (e.kind === ts.SyntaxKind.TrueKeyword ? true : e.kind === ts.SyntaxKind.FalseKeyword ? false : undefined) : undefined;
  };
  const whenTrue = literal(statement.thenStatement);
  let end = statement.end;
  let whenFalse: boolean | undefined;
  if (statement.elseStatement) {
    whenFalse = literal(statement.elseStatement);
  } else {
    const siblings = (statement.parent as ts.Block).statements;
    const next = siblings?.[siblings.indexOf(statement) + 1];
    whenFalse = literal(next);
    end = next?.end ?? end;
  }
  if (whenTrue === undefined || whenFalse === undefined || whenTrue === whenFalse) return undefined;
  const condition = statement.expression;
  const value = whenTrue ? (isBooleanish(condition) ? ctx.text(unparen(condition)) : `!!${wrap(ctx.text(condition), 15)}`) : negate(condition, ctx.sourceFile);
  return { id: 'booleanReturn', title: `Replace with 'return ${whenTrue ? '' : '!'}…'`, edits: [{ start: statement.getStart(ctx.sourceFile), end, text: `return ${value};` }] };
}
moreIntentions.push({ id: 'booleanReturn', title: 'Replace \'if\' returning true/false with \'return\'', run: booleanReturn });

function ternaryBoolean(ctx: IntentionContext): IntentionAction | undefined {
  const t = ctx.nearest(ts.isConditionalExpression);
  if (!t) return undefined;
  const value = (e: ts.Expression) => (unparen(e).kind === ts.SyntaxKind.TrueKeyword ? true : unparen(e).kind === ts.SyntaxKind.FalseKeyword ? false : undefined);
  const [a, b] = [value(t.whenTrue), value(t.whenFalse)];
  if (a === undefined || b === undefined || a === b) return undefined;
  const result = a ? (isBooleanish(t.condition) ? ctx.text(unparen(t.condition)) : `!!${wrap(ctx.text(t.condition), 15)}`) : negate(t.condition, ctx.sourceFile);
  return { id: 'ternaryBoolean', title: 'Simplify boolean ?:', edits: [ctx.replace(t, wrap(result, requiredPrecedence(t)))] };
}
moreIntentions.push({ id: 'ternaryBoolean', title: 'Replace \'c ? true : false\' with \'c\'', run: ternaryBoolean });

function joinDeclaration(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isVariableStatement, (s) => s.declarationList.declarations.length === 1 && !s.declarationList.declarations[0].initializer && ts.isIdentifier(s.declarationList.declarations[0].name));
  if (!statement) return undefined;
  const parent = statement.parent as ts.Block;
  const next = parent.statements?.[parent.statements.indexOf(statement) + 1];
  const declaration = statement.declarationList.declarations[0];
  const name = (declaration.name as ts.Identifier).text;
  const assignment = next && ts.isExpressionStatement(next) && ts.isBinaryExpression(next.expression) && next.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(next.expression.left) && next.expression.left.text === name ? next.expression : undefined;
  if (!assignment) return undefined;
  const keyword = ctx.text(statement.declarationList.getFirstToken(ctx.sourceFile)!);
  const type = declaration.type ? `: ${ctx.text(declaration.type)}` : '';
  const exported = statement.modifiers?.length ? `${statement.modifiers.map((m) => ctx.text(m)).join(' ')} ` : '';
  return { id: 'joinDeclaration', title: 'Join declaration and assignment', edits: [{ start: statement.getStart(ctx.sourceFile), end: next!.end, text: `${exported}${keyword} ${name}${type} = ${ctx.text(assignment.right)};` }] };
}
moreIntentions.push({ id: 'joinDeclaration', title: 'Join declaration and assignment', run: joinDeclaration });

function equalityChainToIncludes(ctx: IntentionContext): IntentionAction | undefined {
  let top = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  while (top && ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) top = top.parent;
  if (!top) return undefined;
  const operands: ts.Expression[] = [];
  const flatten = (e: ts.Expression): void => {
    const u = unparen(e);
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      flatten(u.left);
      flatten(u.right);
    } else operands.push(u);
  };
  flatten(top);
  const isLiteral = (e: ts.Expression) => ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
  let subject: string | undefined;
  const values: string[] = [];
  for (const o of operands) {
    if (!ts.isBinaryExpression(o) || o.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined;
    const [s, v] = isLiteral(o.right) && isSimple(o.left) ? [o.left, o.right] : isLiteral(o.left) && isSimple(o.right) ? [o.right, o.left] : [];
    if (!s || !v || (subject !== undefined && ctx.text(unparen(s)) !== subject)) return undefined;
    subject = ctx.text(unparen(s));
    values.push(ctx.text(v));
  }
  if (operands.length < 2) return undefined;
  return { id: 'equalityChainToIncludes', title: "Replace '===' chain with 'includes'", edits: [ctx.replace(top, `[${values.join(', ')}].includes(${subject})`)] };
}
moreIntentions.push({ id: 'equalityChainToIncludes', title: 'Replace \'===\' chain with \'includes\'', run: equalityChainToIncludes });

function objectAssignToSpread(ctx: IntentionContext): IntentionAction | undefined {
  const call = ctx.nearest(ts.isCallExpression, (c) => ctx.text(c.expression).replace(/\s/g, '') === 'Object.assign' && c.arguments.length >= 2 && ts.isObjectLiteralExpression(c.arguments[0]));
  if (!call || ts.isExpressionStatement(call.parent) || call.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  const parts = call.arguments.flatMap((a) => (ts.isObjectLiteralExpression(a) ? a.properties.map((p) => ctx.text(p)) : [`...${ctx.text(a)}`]));
  const literal = parts.length ? `{ ${parts.join(', ')} }` : '{}';
  const arrowBody = ts.isArrowFunction(call.parent) && call.parent.body === call;
  return { id: 'objectAssignToSpread', title: 'Replace with object spread', edits: [ctx.replace(call, arrowBody ? `(${literal})` : literal)] };
}
moreIntentions.push({ id: 'objectAssignToSpread', title: 'Replace \'Object.assign\' with spread', run: objectAssignToSpread });

function destructureProperty(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isVariableStatement, (s) => s.declarationList.declarations.length === 1);
  const declaration = statement?.declarationList.declarations[0];
  const init = declaration?.initializer && unparen(declaration.initializer);
  if (!statement || !declaration || !init || !ts.isIdentifier(declaration.name) || declaration.type || !ts.isPropertyAccessExpression(init) || init.questionDotToken || !ts.isIdentifier(init.name)) return undefined;
  const name = declaration.name.text;
  const property = init.name.text === name ? name : `${init.name.text}: ${name}`;
  return { id: 'destructureProperty', title: `Destructure '${init.name.text}'`, edits: [ctx.replace(declaration, `{ ${property} } = ${ctx.text(init.expression)}`)] };
}
moreIntentions.push({ id: 'destructureProperty', title: 'Use destructuring', run: destructureProperty });

function mathPowToExponent(ctx: IntentionContext): IntentionAction | undefined {
  const call = ctx.nearest(ts.isCallExpression, (c) => ctx.text(c.expression).replace(/\s/g, '') === 'Math.pow' && c.arguments.length === 2);
  if (!call) return undefined;
  const p = binaryPrecedence(ts.SyntaxKind.AsteriskAsteriskToken);
  const [a, b] = call.arguments;
  const unary = ts.isPrefixUnaryExpression(a) || ts.isAwaitExpression(a) || ts.isTypeOfExpression(a) || ts.isVoidExpression(a) || ts.isDeleteExpression(a);
  const left = unary ? `(${ctx.text(a)})` : wrap(ctx.text(a), p + 1);
  const result = `${left} ** ${wrap(ctx.text(b), p)}`;
  return { id: 'mathPowToExponent', title: "Replace with '**'", edits: [ctx.replace(call, wrap(result, requiredPrecedence(call)))] };
}
moreIntentions.push({ id: 'mathPowToExponent', title: 'Replace \'Math.pow\' with \'**\'', run: mathPowToExponent });

function addNumericSeparators(ctx: IntentionContext): IntentionAction | undefined {
  const literal = ctx.nearest(ts.isNumericLiteral);
  const raw = literal && ctx.text(literal);
  if (!literal || !raw || !/^\d{5,}$/.test(raw)) return undefined;
  return { id: 'addNumericSeparators', title: 'Add numeric separators (1_000_000)', edits: [ctx.replace(literal, raw.replace(/\B(?=(\d{3})+$)/g, '_'))] };
}
moreIntentions.push({ id: 'addNumericSeparators', title: 'Add numeric separators', run: addNumericSeparators });

function removeNumericSeparators(ctx: IntentionContext): IntentionAction | undefined {
  const literal = ctx.nearest(ts.isNumericLiteral);
  const raw = literal && ctx.text(literal);
  return literal && raw?.includes('_') ? { id: 'removeNumericSeparators', title: 'Remove numeric separators', edits: [ctx.replace(literal, raw.replace(/_/g, ''))] } : undefined;
}
moreIntentions.push({ id: 'removeNumericSeparators', title: 'Remove numeric separators', run: removeNumericSeparators });

function toggleQuotes(ctx: IntentionContext): IntentionAction | undefined {
  const literal = ctx.nearest(ts.isStringLiteral, (l) => !ts.isJsxAttribute(l.parent) && !ts.isImportDeclaration(l.parent) && !ts.isExportDeclaration(l.parent));
  if (!literal) return undefined;
  const single = ctx.text(literal).startsWith("'");
  return { id: 'toggleQuotes', title: single ? 'Use double quotes' : 'Use single quotes', edits: [ctx.replace(literal, quote(literal.text, single ? '"' : "'"))] };
}
moreIntentions.push({ id: 'toggleQuotes', title: 'Switch between single and double quotes', run: toggleQuotes });

function simplifyNegation(ctx: IntentionContext): IntentionAction | undefined {
  const comparisonKinds = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
  const not = ctx.nearest(ts.isPrefixUnaryExpression, (p) => p.operator === ts.SyntaxKind.ExclamationToken && ts.isParenthesizedExpression(p.operand) && ts.isBinaryExpression(unparen(p.operand)) && comparisonKinds.includes((unparen(p.operand) as ts.BinaryExpression).operatorToken.kind));
  return not && { id: 'simplifyNegation', title: 'Simplify negated comparison', edits: [ctx.replace(not, wrap(negate(unparen(not.operand), ctx.sourceFile), requiredPrecedence(not)))] };
}
moreIntentions.push({ id: 'simplifyNegation', title: 'Simplify negated comparison', run: simplifyNegation });


/** Whether the node's value is only used as true or false: a condition, or inside one through !, && and ||. */
function inBooleanContext(node: ts.Node): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || (ts.isBinaryExpression(current.parent) && (current.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) || (ts.isPrefixUnaryExpression(current.parent) && current.parent.operator === ts.SyntaxKind.ExclamationToken)) current = current.parent;
  const p = current.parent;
  return ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === current) || (ts.isConditionalExpression(p) && p.condition === current) || (ts.isForStatement(p) && p.condition === current);
}

function removeDoubleNegation(ctx: IntentionContext): IntentionAction | undefined {
  const outer = ctx.nearest(ts.isPrefixUnaryExpression, (p) => p.operator === ts.SyntaxKind.ExclamationToken && ts.isPrefixUnaryExpression(p.operand) && p.operand.operator === ts.SyntaxKind.ExclamationToken);
  if (!outer || !inBooleanContext(outer)) return undefined;
  const inner = (outer.operand as ts.PrefixUnaryExpression).operand;
  return { id: 'removeDoubleNegation', title: "Remove '!!'", edits: [ctx.replace(outer, wrap(ctx.text(inner), requiredPrecedence(outer)))] };
}
moreIntentions.push({ id: 'removeDoubleNegation', title: 'Remove \'!!\' in a condition', run: removeDoubleNegation });

function ternaryToOr(ctx: IntentionContext): IntentionAction | undefined {
  const t = ctx.nearest(ts.isConditionalExpression, (c) => isSimple(c.condition) && ctx.text(unparen(c.condition)) === ctx.text(unparen(c.whenTrue)));
  if (!t) return undefined;
  const f = unparen(t.whenFalse);
  const right = ts.isBinaryExpression(f) && f.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? `(${ctx.text(f)})` : wrap(ctx.text(t.whenFalse), binaryPrecedence(ts.SyntaxKind.BarBarToken) + 1);
  return { id: 'ternaryToOr', title: "Replace with '||'", edits: [ctx.replace(t, wrap(`${ctx.text(unparen(t.condition))} || ${right}`, requiredPrecedence(t)))] };
}
moreIntentions.push({ id: 'ternaryToOr', title: 'Replace \'x ? x : y\' with \'x || y\'', run: ternaryToOr });

function applyToSpread(ctx: IntentionContext): IntentionAction | undefined {
  const call = ctx.nearest(ts.isCallExpression, (c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'apply' && c.arguments.length === 2);
  if (!call) return undefined;
  const fn = (call.expression as ts.PropertyAccessExpression).expression;
  const thisArg = unparen(call.arguments[0]);
  const plain = !ts.isPropertyAccessExpression(fn) && !ts.isElementAccessExpression(fn) && (thisArg.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(thisArg) && thisArg.text === 'undefined'));
  const method = ts.isPropertyAccessExpression(fn) && ctx.text(fn.expression) === ctx.text(thisArg);
  if (!plain && !method) return undefined;
  return { id: 'applyToSpread', title: 'Replace with spread arguments', edits: [ctx.replace(call, `${ctx.text(fn)}(...${ctx.text(call.arguments[1])})`)] };
}
moreIntentions.push({ id: 'applyToSpread', title: 'Replace \'.apply()\' with spread', run: applyToSpread });

function sliceCallToArrayFrom(ctx: IntentionContext): IntentionAction | undefined {
  const call = ctx.nearest(ts.isCallExpression, (c) => ['Array.prototype.slice.call', '[].slice.call'].includes(ctx.text(c.expression).replace(/\s/g, '')) && c.arguments.length === 1);
  return call && { id: 'sliceCallToArrayFrom', title: "Replace with 'Array.from'", edits: [ctx.replace(call, `Array.from(${ctx.text(call.arguments[0])})`)] };
}
moreIntentions.push({ id: 'sliceCallToArrayFrom', title: 'Replace \'slice.call\' with \'Array.from\'', run: sliceCallToArrayFrom });

function jsxTernaryToAnd(ctx: IntentionContext): IntentionAction | undefined {
  const t = ctx.nearest(ts.isConditionalExpression, (c) => ts.isJsxExpression(c.parent) && unparen(c.whenFalse).kind === ts.SyntaxKind.NullKeyword);
  // Only for true/false conditions: `{count && <X />}` renders 0 when count is 0.
  if (!t || !isBooleanish(t.condition)) return undefined;
  return { id: 'jsxTernaryToAnd', title: "Replace with '&&'", edits: [ctx.replace(t, `${wrap(ctx.text(t.condition), binaryPrecedence(ts.SyntaxKind.AmpersandAmpersandToken))} && ${ctx.text(t.whenTrue)}`)] };
}
moreIntentions.push({ id: 'jsxTernaryToAnd', title: 'Replace JSX \'?: null\' with \'&&\'', run: jsxTernaryToAnd });

function jsxAndToTernary(ctx: IntentionContext): IntentionAction | undefined {
  const and = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isJsxExpression(b.parent) && (ts.isJsxElement(unparen(b.right)) || ts.isJsxSelfClosingElement(unparen(b.right)) || ts.isJsxFragment(unparen(b.right))));
  return and && { id: 'jsxAndToTernary', title: "Replace with '? … : null'", edits: [ctx.replace(and, `${ctx.text(and.left)} ? ${ctx.text(and.right)} : null`)] };
}
moreIntentions.push({ id: 'jsxAndToTernary', title: 'Replace JSX \'&&\' with \'?: null\'', run: jsxAndToTernary });

function jsxSelfClose(ctx: IntentionContext): IntentionAction | undefined {
  const element = ctx.nearest(ts.isJsxElement, (e) => e.children.every((c) => ts.isJsxText(c) && !c.text.trim()));
  if (!element) return undefined;
  const opening = ctx.text(element.openingElement);
  return { id: 'jsxSelfClose', title: 'Self-close element', edits: [ctx.replace(element, `${opening.slice(0, -1).trimEnd()} />`)] };
}
moreIntentions.push({ id: 'jsxSelfClose', title: 'Self-close empty JSX element', run: jsxSelfClose });

function jsxExpand(ctx: IntentionContext): IntentionAction | undefined {
  const element = ctx.nearest(ts.isJsxSelfClosingElement);
  if (!element) return undefined;
  const text = ctx.text(element);
  return { id: 'jsxExpand', title: 'Add closing tag', edits: [ctx.replace(element, `${text.slice(0, -2).trimEnd()}></${ctx.text(element.tagName)}>`)] };
}
moreIntentions.push({ id: 'jsxExpand', title: 'Expand self-closing JSX element', run: jsxExpand });

function jsxAttributeUnbrace(ctx: IntentionContext): IntentionAction | undefined {
  const attribute = ctx.nearest(ts.isJsxAttribute, (a) => !!a.initializer && ts.isJsxExpression(a.initializer) && !!a.initializer.expression && ts.isStringLiteral(a.initializer.expression));
  const literal = attribute && ((attribute.initializer as ts.JsxExpression).expression as ts.StringLiteral);
  // JSX strings have no escapes, so the value must be written as is.
  if (!attribute || !literal || ctx.text(literal).includes('\\') || /\n/.test(literal.text)) return undefined;
  const q = !literal.text.includes('"') ? '"' : !literal.text.includes("'") ? "'" : undefined;
  return q && { id: 'jsxAttributeUnbrace', title: 'Remove braces', edits: [ctx.replace(attribute.initializer!, `${q}${literal.text}${q}`)] };
}
moreIntentions.push({ id: 'jsxAttributeUnbrace', title: 'Remove braces around a JSX string', run: jsxAttributeUnbrace });

function jsxAttributeBrace(ctx: IntentionContext): IntentionAction | undefined {
  const attribute = ctx.nearest(ts.isJsxAttribute, (a) => !!a.initializer && ts.isStringLiteral(a.initializer));
  return attribute && { id: 'jsxAttributeBrace', title: 'Put in braces', edits: [ctx.replace(attribute.initializer!, `{${quote((attribute.initializer as ts.StringLiteral).text, '"')}}`)] };
}
moreIntentions.push({ id: 'jsxAttributeBrace', title: 'Put a JSX string in braces', run: jsxAttributeBrace });

function wrapInTryCatch(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest((n): n is ts.Statement => ts.isExpressionStatement(n) || ts.isReturnStatement(n) || ts.isIfStatement(n) || ts.isForOfStatement(n) || ts.isForStatement(n) || ts.isWhileStatement(n), (s) => (ts.isBlock(s.parent) || ts.isSourceFile(s.parent)) && !ctx.sourceFile.text.slice(s.getStart(ctx.sourceFile), ctx.position).includes('\n'));
  if (!statement) return undefined;
  const indent = ctx.indentOf(statement);
  const unit = ctx.indentUnit;
  const body = indentLines(statementLines(statement, ctx.sourceFile), indent + unit);
  // Rethrowing keeps the behavior the same until the catch block is filled in.
  return { id: 'wrapInTryCatch', title: 'Surround with try/catch', edits: [ctx.replace(statement, `try {\n${body}\n${indent}} catch (error) {\n${indent}${unit}throw error;\n${indent}}`)] };
}
moreIntentions.push({ id: 'wrapInTryCatch', title: 'Surround with try/catch', run: wrapInTryCatch });

function thenToAwait(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isReturnStatement, (r) => !!r.expression && ts.isCallExpression(unparen(r.expression)));
  const call = statement && (unparen(statement.expression!) as ts.CallExpression);
  if (!statement || !call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'then' || call.arguments.length !== 1) return undefined;
  const callback = call.arguments[0];
  if (!ts.isArrowFunction(callback) || ts.isBlock(callback.body) || callback.parameters.length > 1 || (callback.parameters[0] && !ts.isIdentifier(callback.parameters[0].name))) return undefined;
  let fn: ts.Node = statement.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn || !(ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async)) return undefined;
  const name = callback.parameters[0] ? (callback.parameters[0].name as ts.Identifier).text : undefined;
  // The new variable must not clash with a name already used in the function.
  if (name && (ctx.text(fn).match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0) !== (ctx.text(callback).match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0)) return undefined;
  const indent = ctx.indentOf(statement);
  const awaited = `await ${ctx.text(call.expression.expression)}`;
  const text = `${name ? `const ${name} = ` : ''}${awaited};\n${indent}return ${ctx.text(callback.body)};`;
  return { id: 'thenToAwait', title: "Replace '.then()' with 'await'", edits: [ctx.replace(statement, text)] };
}
moreIntentions.push({ id: 'thenToAwait', title: 'Replace \'.then()\' with \'await\'', run: thenToAwait });

function functionPropertyToMethod(ctx: IntentionContext): IntentionAction | undefined {
  const property = ctx.nearest(ts.isPropertyAssignment, (p) => ts.isFunctionExpression(p.initializer) && !p.initializer.name && ts.isObjectLiteralExpression(p.parent));
  if (!property) return undefined;
  const fn = property.initializer as ts.FunctionExpression;
  const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const star = fn.asteriskToken ? '*' : '';
  const typeParameters = fn.typeParameters ? `<${fn.typeParameters.map((t) => ctx.text(t)).join(', ')}>` : '';
  const returnType = fn.type ? `: ${ctx.text(fn.type)}` : '';
  return { id: 'functionPropertyToMethod', title: 'Use method shorthand', edits: [ctx.replace(property, `${isAsync}${star}${ctx.text(property.name)}${typeParameters}(${fn.parameters.map((p) => ctx.text(p)).join(', ')})${returnType} ${ctx.text(fn.body)}`)] };
}
moreIntentions.push({ id: 'functionPropertyToMethod', title: 'Use method shorthand', run: functionPropertyToMethod });

function unaryPlusToNumber(ctx: IntentionContext): IntentionAction | undefined {
  const plus = ctx.nearest(ts.isPrefixUnaryExpression, (p) => p.operator === ts.SyntaxKind.PlusToken && !ts.isNumericLiteral(p.operand));
  return plus && { id: 'unaryPlusToNumber', title: "Replace with 'Number()'", edits: [ctx.replace(plus, `Number(${ctx.text(unparen(plus.operand))})`)] };
}
moreIntentions.push({ id: 'unaryPlusToNumber', title: 'Replace unary \'+\' with \'Number()\'', run: unaryPlusToNumber });

function splitString(ctx: IntentionContext): IntentionAction | undefined {
  const literal = ctx.nearest(ts.isStringLiteral, (l) => !ts.isJsxAttribute(l.parent) && !ts.isImportDeclaration(l.parent) && ctx.position > l.getStart(ctx.sourceFile) + 1 && ctx.position < l.end - 1);
  if (!literal || ctx.text(literal).includes('\\')) return undefined;
  const q = ctx.text(literal)[0];
  const offset = ctx.position - literal.getStart(ctx.sourceFile);
  const raw = ctx.text(literal);
  return { id: 'splitString', title: 'Split string here', edits: [ctx.replace(literal, wrap(`${raw.slice(0, offset)}${q} + ${q}${raw.slice(offset)}`, requiredPrecedence(literal)))] };
}
moreIntentions.push({ id: 'splitString', title: 'Split string at the cursor', run: splitString });

function joinStrings(ctx: IntentionContext): IntentionAction | undefined {
  const plus = ctx.nearest(ts.isBinaryExpression, (b) => b.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(unparen(b.left)) && ts.isStringLiteral(unparen(b.right)));
  if (!plus) return undefined;
  const left = unparen(plus.left) as ts.StringLiteral;
  const q = ctx.text(left)[0] === '"' ? '"' : "'";
  return { id: 'joinStrings', title: 'Join string literals', edits: [ctx.replace(plus, quote(left.text + (unparen(plus.right) as ts.StringLiteral).text, q))] };
}
moreIntentions.push({ id: 'joinStrings', title: 'Join string literals', run: joinStrings });

function guardClause(ctx: IntentionContext): IntentionAction | undefined {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s) && !s.elseStatement && ts.isBlock(s.thenStatement));
  const body = statement?.parent;
  if (!statement || !body || !ts.isBlock(body) || !ts.isFunctionLike(body.parent) || body.statements[body.statements.length - 1] !== statement) return undefined;
  // A returned value would now be lost, so only functions that return nothing.
  if (containsInScope(statement.thenStatement, (n) => ts.isReturnStatement(n) && !!n.expression)) return undefined;
  const indent = ctx.indentOf(statement);
  const lines = statementLines(statement.thenStatement, ctx.sourceFile);
  return { id: 'guardClause', title: 'Invert into early return', edits: [ctx.replace(statement, `if (${negate(statement.expression, ctx.sourceFile)}) {\n${indent}${ctx.indentUnit}return;\n${indent}}\n${indentLines(lines, indent)}`)] };
}
moreIntentions.push({ id: 'guardClause', title: 'Invert if into an early return', run: guardClause });

function awaitToPromiseAll(ctx: IntentionContext): IntentionAction | undefined {
  const first = ctx.nearest(ts.isVariableStatement);
  const block = first?.parent;
  if (!first || !block || !(ts.isBlock(block) || ts.isSourceFile(block))) return undefined;
  const second = block.statements[block.statements.indexOf(first) + 1];
  const awaited = (s: ts.Statement | undefined) => {
    const d = s && ts.isVariableStatement(s) && s.declarationList.declarations.length === 1 ? s.declarationList.declarations[0] : undefined;
    return d && ts.isIdentifier(d.name) && d.initializer && ts.isAwaitExpression(d.initializer) && !d.type ? { name: d.name.text, expression: d.initializer.expression, list: s as ts.VariableStatement } : undefined;
  };
  const [a, b] = [awaited(first), awaited(second)];
  // The second call must not use the first result, or they can't run together.
  if (!a || !b || new RegExp(`\\b${a.name}\\b`).test(ctx.text(b.expression))) return undefined;
  const keyword = (first.declarationList.flags & ts.NodeFlags.Const) && (b.list.declarationList.flags & ts.NodeFlags.Const) ? 'const' : 'let';
  return { id: 'awaitToPromiseAll', title: 'Await together with Promise.all', edits: [{ start: first.getStart(ctx.sourceFile), end: second!.end, text: `${keyword} [${a.name}, ${b.name}] = await Promise.all([${ctx.text(a.expression)}, ${ctx.text(b.expression)}]);` }] };
}
moreIntentions.push({ id: 'awaitToPromiseAll', title: 'Await independent calls together', run: awaitToPromiseAll });

function sortImportSpecifiers(ctx: IntentionContext): IntentionAction | undefined {
  const named = ctx.nearest(ts.isNamedImports, (n) => n.elements.length > 1);
  if (!named) return undefined;
  const texts = named.elements.map((e) => ctx.text(e));
  const key = (t: string) => t.replace(/^type\s+/, '').toLowerCase();
  const sorted = [...texts].sort((x, y) => key(x).localeCompare(key(y)));
  if (sorted.every((t, i) => t === texts[i])) return undefined;
  return { id: 'sortImportSpecifiers', title: 'Sort imported names', edits: [ctx.replace(named, `{ ${sorted.join(', ')} }`)] };
}
moreIntentions.push({ id: 'sortImportSpecifiers', title: 'Sort imported names', run: sortImportSpecifiers });

function propertyToElementAccess(ctx: IntentionContext): IntentionAction | undefined {
  const access = ctx.nearest(ts.isPropertyAccessExpression, (p) => ts.isIdentifier(p.name) && ctx.position >= p.name.getStart(ctx.sourceFile));
  if (!access) return undefined;
  return { id: 'propertyToElementAccess', title: `Use ['${access.name.text}']`, edits: [ctx.replace(access, `${ctx.text(access.expression)}${access.questionDotToken ? '?.' : ''}['${access.name.text}']`)] };
}
moreIntentions.push({ id: 'propertyToElementAccess', title: 'Convert \'a.b\' to \'a["b"]\'', run: propertyToElementAccess });
