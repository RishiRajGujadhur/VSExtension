import ts = require('typescript');
import { findNode } from '../analysis/impact';
import {
  binaryPrecedence,
  containsInScope,
  endsWithJump,
  forEachInScope,
  indentLines,
  lineIndent,
  negate,
  precedence,
  statementLines,
  statementsOf,
  unparen,
  wrap,
} from './syntax';
import { moreIntentions } from './more';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface IntentionAction {
  id: string;
  title: string;
  edits: TextEdit[];
}

/** The cursor position and the nodes around it, innermost first. */
class Context {
  readonly ancestors: ts.Node[] = [];

  constructor(
    readonly sourceFile: ts.SourceFile,
    readonly position: number,
    readonly indentUnit: string,
  ) {
    for (let node: ts.Node | undefined = findNode(sourceFile, position); node; node = node.parent) {
      this.ancestors.push(node);
    }
  }

  nearest<T extends ts.Node>(guard: (node: ts.Node) => node is T, filter: (node: T) => boolean = () => true): T | undefined {
    for (const node of this.ancestors) {
      if (guard(node) && filter(node)) {
        return node;
      }
    }
    return undefined;
  }

  text(node: ts.Node): string {
    return node.getText(this.sourceFile);
  }

  indentOf(node: ts.Node): string {
    return lineIndent(this.sourceFile, node.getStart(this.sourceFile));
  }

  /** Between the statement's keyword and the end of its parenthesized header, or on its `else`. */
  onHeader(statement: ts.Statement): boolean {
    const start = statement.getStart(this.sourceFile);
    const end = headerEnd(statement, this.sourceFile);
    if (this.position >= start && this.position <= end) {
      return true;
    }
    if (ts.isIfStatement(statement) && statement.elseStatement) {
      return this.position >= statement.thenStatement.end && this.position <= statement.elseStatement.getStart(this.sourceFile);
    }
    return false;
  }

  replace(node: ts.Node, text: string): TextEdit {
    return { start: node.getStart(this.sourceFile), end: node.end, text };
  }
}

type Intention = (ctx: Context) => IntentionAction | undefined;

/** Where a statement's header ends: after the `)` of `if (...)`/loops, or after `do`. */
function headerEnd(statement: ts.Statement, sourceFile: ts.SourceFile): number {
  const text = sourceFile.text;
  if (ts.isIfStatement(statement) || ts.isWhileStatement(statement)) {
    return text.indexOf(')', statement.expression.end) + 1;
  }
  if (ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
    return text.lastIndexOf(')', statement.statement.getStart(sourceFile)) + 1;
  }
  if (ts.isDoStatement(statement)) {
    return statement.getStart(sourceFile) + 2;
  }
  return statement.getStart(sourceFile);
}

/** True when a block holds exactly its statements and no comments, so rewriting it loses nothing. */
function hasNoComments(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = node.getText(sourceFile);
  return !/\/\/|\/\*/.test(text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ''));
}

function single(statement: ts.Statement): ts.Statement | undefined {
  const statements = statementsOf(statement);
  return statements.length === 1 ? statements[0] : undefined;
}

function block(lines: string[], indent: string, unit: string): string {
  return lines.length === 0 ? '{}' : `{\n${indentLines(lines, indent + unit)}\n${indent}}`;
}

const invertIf: Intention = (ctx) => {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  if (!statement?.elseStatement || ts.isIfStatement(statement.elseStatement)) {
    return undefined;
  }
  const sf = ctx.sourceFile;
  return {
    id: 'invertIf',
    title: "Invert 'if' condition",
    edits: [
      ctx.replace(statement.expression, negate(statement.expression, sf)),
      ctx.replace(statement.thenStatement, ctx.text(statement.elseStatement)),
      ctx.replace(statement.elseStatement, ctx.text(statement.thenStatement)),
    ],
  };
};

const flipTernary: Intention = (ctx) => {
  const conditional = ctx.nearest(ts.isConditionalExpression);
  if (!conditional) {
    return undefined;
  }
  const condition = wrap(negate(conditional.condition, ctx.sourceFile), 3);
  return {
    id: 'flipTernary',
    title: "Flip '?:'",
    edits: [ctx.replace(conditional, `${condition} ? ${ctx.text(conditional.whenFalse)} : ${ctx.text(conditional.whenTrue)}`)],
  };
};

const ternaryToIf: Intention = (ctx) => {
  const conditional = ctx.nearest(ts.isConditionalExpression);
  if (!conditional) {
    return undefined;
  }
  let holder: ts.Node = conditional;
  while (ts.isParenthesizedExpression(holder.parent)) {
    holder = holder.parent;
  }
  const parent = holder.parent;
  let statement: ts.Statement;
  let prefix = '';
  let make: (value: string) => string;
  if (ts.isReturnStatement(parent)) {
    statement = parent;
    make = (v) => `return ${v};`;
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === holder &&
    ts.isExpressionStatement(parent.parent)
  ) {
    statement = parent.parent;
    make = (v) => `${ctx.text(parent.left)} = ${v};`;
  } else if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === holder &&
    ts.isIdentifier(parent.name) &&
    ts.isVariableDeclarationList(parent.parent) &&
    parent.parent.declarations.length === 1 &&
    ts.isVariableStatement(parent.parent.parent) &&
    !parent.parent.parent.modifiers
  ) {
    statement = parent.parent.parent;
    const keyword = parent.parent.flags & ts.NodeFlags.Const || parent.parent.flags & ts.NodeFlags.Let ? 'let' : 'var';
    const name = parent.name.text;
    prefix = `${keyword} ${name}${parent.type ? `: ${ctx.text(parent.type)}` : ''};\n${ctx.indentOf(statement)}`;
    make = (v) => `${name} = ${v};`;
  } else {
    return undefined;
  }
  const indent = ctx.indentOf(statement);
  const unit = ctx.indentUnit;
  const value = (node: ts.Expression) => ctx.text(unparen(node));
  return {
    id: 'ternaryToIf',
    title: "Replace '?:' with 'if else'",
    edits: [
      ctx.replace(
        statement,
        `${prefix}if (${ctx.text(conditional.condition)}) {\n${indent}${unit}${make(value(conditional.whenTrue))}\n${indent}} else {\n${indent}${unit}${make(value(conditional.whenFalse))}\n${indent}}`,
      ),
    ],
  };
};

const ifToTernary: Intention = (ctx) => {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  if (!statement || !hasNoComments(statement, ctx.sourceFile)) {
    return undefined;
  }
  const condition = wrap(ctx.text(statement.expression), 3);
  const value = (e: ts.Expression) => wrap(ctx.text(e), 2);
  const whenTrue = single(statement.thenStatement);
  let whenFalse: ts.Statement | undefined;
  let end = statement.end;
  if (statement.elseStatement) {
    if (ts.isIfStatement(statement.elseStatement)) {
      return undefined;
    }
    whenFalse = single(statement.elseStatement);
  } else {
    // `if (c) return a; return b;`
    const siblings = ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent) ? statement.parent.statements : undefined;
    const next = siblings?.[siblings.indexOf(statement) + 1];
    if (next && ts.isReturnStatement(next) && whenTrue && ts.isReturnStatement(whenTrue)) {
      whenFalse = next;
      end = next.end;
    }
  }
  if (!whenTrue || !whenFalse) {
    return undefined;
  }
  let text: string | undefined;
  if (ts.isReturnStatement(whenTrue) && ts.isReturnStatement(whenFalse) && whenTrue.expression && whenFalse.expression) {
    text = `return ${condition} ? ${value(whenTrue.expression)} : ${value(whenFalse.expression)};`;
  } else if (ts.isExpressionStatement(whenTrue) && ts.isExpressionStatement(whenFalse)) {
    const a = whenTrue.expression;
    const b = whenFalse.expression;
    if (
      ts.isBinaryExpression(a) &&
      ts.isBinaryExpression(b) &&
      a.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ctx.text(a.left) === ctx.text(b.left)
    ) {
      text = `${ctx.text(a.left)} = ${condition} ? ${value(a.right)} : ${value(b.right)};`;
    }
  }
  if (!text) {
    return undefined;
  }
  return { id: 'ifToTernary', title: "Replace 'if else' with '?:'", edits: [{ start: statement.getStart(ctx.sourceFile), end, text }] };
};

const mergeNestedIfs: Intention = (ctx) => {
  const outer = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  if (!outer || outer.elseStatement || !hasNoComments(outer.thenStatement, ctx.sourceFile) || ts.isIfStatement(outer.parent)) {
    return undefined;
  }
  const inner = single(outer.thenStatement);
  if (!inner || !ts.isIfStatement(inner) || inner.elseStatement) {
    return undefined;
  }
  const indent = ctx.indentOf(outer);
  const then = ts.isBlock(inner.thenStatement)
    ? block(statementLines(inner.thenStatement, ctx.sourceFile), indent, ctx.indentUnit)
    : ctx.text(inner.thenStatement);
  return {
    id: 'mergeNestedIfs',
    title: "Merge nested 'if's",
    edits: [ctx.replace(outer, `if (${wrap(ctx.text(outer.expression), 5)} && ${wrap(ctx.text(inner.expression), 5)}) ${then}`)],
  };
};

const splitAndCondition: Intention = (ctx) => {
  const statement = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s));
  const condition = statement && unparen(statement.expression);
  if (!statement || statement.elseStatement || !condition || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
    return undefined;
  }
  const indent = ctx.indentOf(statement);
  const unit = ctx.indentUnit;
  const then = ts.isBlock(statement.thenStatement)
    ? block(statementLines(statement.thenStatement, ctx.sourceFile), indent + unit, unit)
    : ctx.text(statement.thenStatement);
  return {
    id: 'splitAndCondition',
    title: "Split '&&' into nested 'if's",
    edits: [ctx.replace(statement, `if (${ctx.text(condition.left)}) {\n${indent}${unit}if (${ctx.text(condition.right)}) ${then}\n${indent}}`)],
  };
};

type BodyOwner = ts.IfStatement | ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement;

function isBodyOwner(node: ts.Node): node is BodyOwner {
  return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

/** Each body of a statement, with the position right after the token that introduces it. */
function bodies(owner: BodyOwner, sourceFile: ts.SourceFile): { body: ts.Statement; after: number }[] {
  if (ts.isIfStatement(owner)) {
    const result = [{ body: owner.thenStatement, after: headerEnd(owner, sourceFile) }];
    if (owner.elseStatement && !ts.isIfStatement(owner.elseStatement)) {
      result.push({ body: owner.elseStatement, after: sourceFile.text.indexOf('else', owner.thenStatement.end) + 4 });
    }
    return result;
  }
  return [{ body: owner.statement, after: headerEnd(owner, sourceFile) }];
}

function keywordOf(owner: BodyOwner): string {
  return ts.isIfStatement(owner) ? 'if' : ts.isDoStatement(owner) ? 'do' : ts.isWhileStatement(owner) ? 'while' : 'for';
}

const addBraces: Intention = (ctx) => {
  const owner = ctx.nearest(isBodyOwner, (s) => ctx.onHeader(s));
  if (!owner) {
    return undefined;
  }
  const indent = ctx.indentOf(owner);
  const sf = ctx.sourceFile;
  const edits = bodies(owner, sf)
    .filter(({ body }) => !ts.isBlock(body))
    .map(({ body, after }) => {
      const edit = { start: after, end: body.end, text: ` ${block(statementLines(body, sf), indent, ctx.indentUnit)}` };
      if (ts.isIfStatement(owner) && body === owner.thenStatement && owner.elseStatement) {
        // Join the else onto the closing brace: `} else`.
        edit.end = sf.text.indexOf('else', body.end);
        edit.text += ' ';
      }
      return edit;
    });
  if (edits.length === 0) {
    return undefined;
  }
  if (ts.isDoStatement(owner)) {
    // `do x(); while (c)` needs a space before `while` after the new block.
    edits[0].text += ' ';
    edits[0].end = owner.statement.end + (ctx.sourceFile.text.slice(owner.statement.end).match(/^\s*/)?.[0].length ?? 0);
  }
  return { id: 'addBraces', title: `Add braces to '${keywordOf(owner)}' statement`, edits };
};

const removeBraces: Intention = (ctx) => {
  const owner = ctx.nearest(isBodyOwner, (s) => ctx.onHeader(s));
  if (!owner) {
    return undefined;
  }
  const indent = ctx.indentOf(owner);
  const edits: TextEdit[] = [];
  for (const { body, after } of bodies(owner, ctx.sourceFile)) {
    const only = ts.isBlock(body) ? single(body) : undefined;
    if (!only || !hasNoComments(body, ctx.sourceFile)) {
      continue;
    }
    const declares =
      (ts.isVariableStatement(only) && only.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) ||
      ts.isClassDeclaration(only) ||
      ts.isFunctionDeclaration(only);
    // `if (a) { if (b) x(); } else y();` would attach the else to the inner if.
    const danglingElse = ts.isIfStatement(owner) && body === owner.thenStatement && owner.elseStatement && ts.isIfStatement(only);
    if (declares || danglingElse) {
      continue;
    }
    const lines = statementLines(only, ctx.sourceFile);
    const text = lines.length === 1 ? ` ${lines[0]}` : `\n${indentLines(lines, indent + ctx.indentUnit)}`;
    const followedByElse = ts.isIfStatement(owner) && body === owner.thenStatement && owner.elseStatement;
    edits.push({ start: after, end: body.end, text: followedByElse ? `${text}\n${indent}` : text });
    if (followedByElse) {
      // Drop the space between `}` and `else`; the new line above replaces it.
      const gap = ctx.sourceFile.text.slice(body.end).match(/^\s*/)![0].length;
      edits[edits.length - 1].end = body.end + gap;
    }
  }
  if (edits.length === 0) {
    return undefined;
  }
  if (ts.isDoStatement(owner)) {
    edits[0].text += ' ';
    edits[0].end = owner.statement.end + (ctx.sourceFile.text.slice(owner.statement.end).match(/^\s*/)?.[0].length ?? 0);
  }
  return { id: 'removeBraces', title: `Remove braces from '${keywordOf(owner)}' statement`, edits };
};

const arrowExpressionToBlock: Intention = (ctx) => {
  const arrow = ctx.nearest(ts.isArrowFunction);
  if (!arrow || ts.isBlock(arrow.body)) {
    return undefined;
  }
  const inner = unparen(arrow.body);
  const value = ts.isObjectLiteralExpression(inner) ? ctx.text(inner) : ctx.text(arrow.body);
  const indent = ctx.indentOf(arrow);
  return {
    id: 'arrowToBlockBody',
    title: 'Convert arrow function to block body',
    edits: [ctx.replace(arrow.body, `{\n${indent}${ctx.indentUnit}return ${value};\n${indent}}`)],
  };
};

const arrowBlockToExpression: Intention = (ctx) => {
  const arrow = ctx.nearest(ts.isArrowFunction);
  if (!arrow || !ts.isBlock(arrow.body) || !hasNoComments(arrow.body, ctx.sourceFile)) {
    return undefined;
  }
  const only = single(arrow.body);
  if (!only || !ts.isReturnStatement(only) || !only.expression) {
    return undefined;
  }
  const expr = unparen(only.expression);
  const text = ts.isObjectLiteralExpression(expr) || precedence(expr) < 2 ? `(${ctx.text(expr)})` : ctx.text(only.expression);
  return { id: 'arrowToExpressionBody', title: 'Convert arrow function to expression body', edits: [ctx.replace(arrow.body, text)] };
};

/** Whether `this`, `super`, `arguments` or `new.target` in a function would change meaning in an arrow. */
function usesFunctionBindings(fn: ts.FunctionExpression): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      (ts.isIdentifier(node) && node.text === 'arguments') ||
      ts.isMetaProperty(node)
    ) {
      found = true;
      return;
    }
    // Arrows share the function's bindings; other functions and classes have their own.
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) {
      return;
    }
    ts.forEachChild(node, walk);
  };
  fn.parameters.forEach(walk);
  walk(fn.body);
  return found;
}

const functionToArrow: Intention = (ctx) => {
  const fn = ctx.nearest(ts.isFunctionExpression);
  if (!fn || fn.asteriskToken || usesFunctionBindings(fn)) {
    return undefined;
  }
  if (fn.name) {
    const name = fn.name.text;
    let referenced = false;
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name && node !== fn.name) referenced = true;
      ts.forEachChild(node, walk);
    };
    walk(fn.body);
    if (referenced) {
      return undefined;
    }
  }
  const sf = ctx.sourceFile;
  const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const typeParameters = fn.typeParameters
    ? `<${fn.typeParameters.map((t) => ctx.text(t)).join(', ')}${sf.languageVariant === ts.LanguageVariant.JSX && fn.typeParameters.length === 1 ? ',' : ''}>`
    : '';
  const parameters = sf.text.slice(fn.parameters.pos, fn.parameters.end);
  const returnType = fn.type ? `: ${ctx.text(fn.type)}` : '';
  const text = `${isAsync}${typeParameters}(${parameters})${returnType} => ${ctx.text(fn.body)}`;
  // An arrow binds looser than a function expression, e.g. as a call target or operand.
  return { id: 'functionToArrow', title: 'Convert to arrow function', edits: [ctx.replace(fn, requiredPrecedence(fn) > 2 ? `(${text})` : text)] };
};

function isPlus(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function isStringish(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

/** A cooked string value escaped for use inside a template literal. */
function escapeForTemplate(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const concatToTemplate: Intention = (ctx) => {
  let node: ts.Node | undefined = ctx.nearest(isPlus);
  if (!node) {
    return undefined;
  }
  while (isPlus(node.parent) && node.parent.left === node) {
    node = node.parent;
  }
  const operands: ts.Expression[] = [];
  const flatten = (n: ts.Expression): void => {
    if (isPlus(n)) {
      flatten(n.left);
      operands.push(n.right);
    } else {
      operands.push(n);
    }
  };
  flatten(node as ts.Expression);
  const firstString = operands.findIndex(isStringish);
  if (firstString < 0) {
    return undefined;
  }
  const parts: string[] = [];
  let rest = operands;
  if (firstString >= 2) {
    // `1 + 2 + 'a'` adds the numbers first.
    parts.push('${' + operands.slice(0, firstString).map((o) => ctx.text(o)).join(' + ') + '}');
    rest = operands.slice(firstString);
  }
  for (const operand of rest) {
    if (ts.isStringLiteral(operand)) {
      parts.push(escapeForTemplate(operand.text));
    } else if (ts.isNoSubstitutionTemplateLiteral(operand) || ts.isTemplateExpression(operand)) {
      parts.push(ctx.text(operand).slice(1, -1));
    } else {
      parts.push('${' + ctx.text(unparen(operand)) + '}');
    }
  }
  return { id: 'concatToTemplate', title: "Replace '+' with template literal", edits: [ctx.replace(node, '`' + parts.join('') + '`')] };
};

const flippedComparison = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '==='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.EqualsEqualsToken, '=='],
  [ts.SyntaxKind.ExclamationEqualsToken, '!='],
  [ts.SyntaxKind.LessThanToken, '>'],
  [ts.SyntaxKind.GreaterThanToken, '<'],
  [ts.SyntaxKind.LessThanEqualsToken, '>='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '<='],
]);

const flipComparison: Intention = (ctx) => {
  const binary = ctx.nearest(ts.isBinaryExpression, (b) => flippedComparison.has(b.operatorToken.kind));
  if (!binary) {
    return undefined;
  }
  const operator = ctx.text(binary.operatorToken);
  const flipped = flippedComparison.get(binary.operatorToken.kind)!;
  return {
    id: 'flipComparison',
    title: operator === flipped ? `Swap operands of '${operator}'` : `Flip '${operator}' to '${flipped}'`,
    edits: [ctx.replace(binary, `${ctx.text(binary.right)} ${flipped} ${ctx.text(binary.left)}`)],
  };
};

/** The minimum precedence an expression needs to replace `node` without changing how it parses. */
function requiredPrecedence(node: ts.Node): number {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return binaryPrecedence(parent.operatorToken.kind) + (parent.right === node ? 1 : 0);
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isAwaitExpression(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent)) return 15;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) && parent.expression === node || ts.isCallExpression(parent) && parent.expression === node) return 17;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return 3;
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) return 11;
  return 1;
}

const deMorgan: Intention = (ctx) => {
  const binary = ctx.nearest(
    ts.isBinaryExpression,
    (b) => b.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || b.operatorToken.kind === ts.SyntaxKind.BarBarToken,
  );
  if (!binary) {
    return undefined;
  }
  const sf = ctx.sourceFile;
  const isAnd = binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
  const operator = isAnd ? '||' : '&&';
  const minimum = isAnd ? 4 : 5;
  const swapped = `${wrap(negate(binary.left, sf), minimum)} ${operator} ${wrap(negate(binary.right, sf), minimum)}`;
  let holder: ts.Node = binary;
  while (ts.isParenthesizedExpression(holder.parent)) {
    holder = holder.parent;
  }
  const title = `Replace '${isAnd ? '&&' : '||'}' with '${operator}'`;
  if (ts.isPrefixUnaryExpression(holder.parent) && holder.parent.operator === ts.SyntaxKind.ExclamationToken) {
    // `!(a && b)` becomes `!a || !b`.
    const negated = holder.parent;
    return { id: 'deMorgan', title, edits: [ctx.replace(negated, wrap(swapped, requiredPrecedence(negated)))] };
  }
  return { id: 'deMorgan', title, edits: [ctx.replace(binary, `!(${swapped})`)] };
};

function declarationKeyword(list: ts.VariableDeclarationList): string {
  return list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : 'var';
}

const splitDeclarations: Intention = (ctx) => {
  const statement = ctx.nearest(ts.isVariableStatement, (s) => s.declarationList.declarations.length > 1);
  if (!statement || !hasNoComments(statement, ctx.sourceFile)) {
    return undefined;
  }
  const modifiers = statement.modifiers ? statement.modifiers.map((m) => ctx.text(m)).join(' ') + ' ' : '';
  const keyword = declarationKeyword(statement.declarationList);
  const indent = ctx.indentOf(statement);
  const text = statement.declarationList.declarations.map((d) => `${modifiers}${keyword} ${ctx.text(d)};`).join(`\n${indent}`);
  return { id: 'splitDeclarations', title: 'Split into separate declarations', edits: [ctx.replace(statement, text)] };
};

const splitInitializer: Intention = (ctx) => {
  const statement = ctx.nearest(ts.isVariableStatement, (s) => s.declarationList.declarations.length === 1);
  const declaration = statement?.declarationList.declarations[0];
  if (!statement || !declaration?.initializer || !ts.isIdentifier(declaration.name) || statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return undefined;
  }
  if (ctx.position > declaration.initializer.getStart(ctx.sourceFile)) {
    return undefined; // Only offered on the declaration part, not inside the initializer.
  }
  const modifiers = statement.modifiers ? statement.modifiers.map((m) => ctx.text(m)).join(' ') + ' ' : '';
  const keyword = declarationKeyword(statement.declarationList) === 'var' ? 'var' : 'let';
  const name = declaration.name.text;
  const type = declaration.type ? `: ${ctx.text(declaration.type)}` : '';
  const indent = ctx.indentOf(statement);
  return {
    id: 'splitInitializer',
    title: 'Split into declaration and assignment',
    edits: [ctx.replace(statement, `${modifiers}${keyword} ${name}${type};\n${indent}${name} = ${ctx.text(declaration.initializer)};`)],
  };
};

/** A loop variable name for elements of `collection` that the body does not already use. */
function elementName(collection: ts.Expression, used: Set<string>): string {
  const base = ts.isIdentifier(collection) ? collection.text : ts.isPropertyAccessExpression(collection) ? collection.name.text : 'item';
  let name = /ies$/.test(base) ? base.replace(/ies$/, 'y') : /(ches|shes|sses|xes)$/.test(base) ? base.slice(0, -2) : /s$/.test(base) && base.length > 1 ? base.slice(0, -1) : `${base}Item`;
  if (name === base) name = `${base}Item`;
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name}${i}`;
  return candidate;
}

function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

function isWriteTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))
  );
}

const forIndexToForOf: Intention = (ctx) => {
  const loop = ctx.nearest(ts.isForStatement, (s) => ctx.onHeader(s));
  const init = loop?.initializer;
  if (!loop || !init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {
    return undefined;
  }
  const index = init.declarations[0];
  if (!ts.isIdentifier(index.name) || !index.initializer || ctx.text(index.initializer) !== '0') {
    return undefined;
  }
  const i = index.name.text;
  const condition = loop.condition && unparen(loop.condition);
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    ctx.text(condition.left) !== i ||
    !ts.isPropertyAccessExpression(condition.right) ||
    condition.right.name.text !== 'length'
  ) {
    return undefined;
  }
  const collection = condition.right.expression;
  const isPlainReference = (e: ts.Expression): boolean => ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && isPlainReference(e.expression)) || e.kind === ts.SyntaxKind.ThisKeyword;
  const increment = loop.incrementor && ctx.text(loop.incrementor).replace(/\s/g, '');
  if (!isPlainReference(collection) || ![`${i}++`, `++${i}`, `${i}+=1`].includes(increment ?? '')) {
    return undefined;
  }
  const collectionText = ctx.text(collection);
  const accesses: ts.ElementAccessExpression[] = [];
  let unsupported = false;
  const walk = (node: ts.Node): void => {
    if (unsupported) return;
    if (ts.isIdentifier(node) && node.text === i) {
      const parent = node.parent;
      if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node && ctx.text(parent.expression) === collectionText && !isWriteTarget(parent)) {
        accesses.push(parent);
      } else {
        unsupported = true; // The index is used for something other than reading the element.
      }
      return;
    }
    if (ts.isIdentifier(node) && node.text === collectionText && isWriteTarget(node)) {
      unsupported = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(loop.statement);
  if (unsupported) {
    return undefined;
  }
  const name = elementName(collection, identifiersIn(loop.statement));
  return {
    id: 'forIndexToForOf',
    title: "Replace indexed 'for' with 'for...of'",
    edits: [
      { start: loop.getStart(ctx.sourceFile), end: headerEnd(loop, ctx.sourceFile), text: `for (const ${name} of ${collectionText})` },
      ...accesses.map((a) => ctx.replace(a, name)),
    ],
  };
};

const forEachToForOf: Intention = (ctx) => {
  const call = ctx.nearest(
    ts.isCallExpression,
    (c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'forEach' && ts.isExpressionStatement(c.parent) && c.arguments.length === 1,
  );
  if (!call) {
    return undefined;
  }
  const callback = call.arguments[0];
  if (!(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length === 0 || callback.parameters.length > 2) {
    return undefined;
  }
  if (callback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || (ts.isFunctionExpression(callback) && usesFunctionBindings(callback))) {
    return undefined;
  }
  const sf = ctx.sourceFile;
  const statement = call.parent as ts.ExpressionStatement;
  const collection = wrap(ctx.text((call.expression as ts.PropertyAccessExpression).expression), 17);
  const [item, position] = callback.parameters.map((p) => ctx.text(p.name));
  const head = position ? `for (const [${position}, ${item}] of ${collection}.entries())` : `for (const ${item} of ${collection})`;
  const indent = ctx.indentOf(statement);

  if (!ts.isBlock(callback.body)) {
    return { id: 'forEachToForOf', title: "Replace 'forEach' with 'for...of'", edits: [ctx.replace(statement, `${head} {\n${indent}${ctx.indentUnit}${ctx.text(callback.body)};\n${indent}}`)] };
  }
  // `return;` in the callback skips to the next element; `return value;` has no loop equivalent.
  const returns: ts.ReturnStatement[] = [];
  let returnsValue = false;
  forEachInScope(callback.body, (node) => {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      returnsValue ||= !!node.expression;
    }
  });
  const breaksOut = containsInScope(callback.body, (n) => (ts.isBreakStatement(n) || ts.isContinueStatement(n)) && !!n.label);
  if (returnsValue || breaksOut) {
    return undefined;
  }
  const bodyStart = callback.body.getStart(sf);
  let bodyText = sf.text.slice(bodyStart, callback.body.end);
  for (const ret of [...returns].sort((a, b) => b.getStart(sf) - a.getStart(sf))) {
    const s = ret.getStart(sf) - bodyStart;
    bodyText = bodyText.slice(0, s) + 'continue;' + bodyText.slice(ret.end - bodyStart);
  }
  return { id: 'forEachToForOf', title: "Replace 'forEach' with 'for...of'", edits: [ctx.replace(statement, `${head} ${bodyText}`)] };
};

/** `subject === literal` or `literal === subject`, or several of them joined by `||`. */
function caseValues(condition: ts.Expression, ctx: Context, subject: string | undefined): { subject: string; values: string[] } | undefined {
  const expr = unparen(condition);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const left = caseValues(expr.left, ctx, subject);
    const right = left && caseValues(expr.right, ctx, left.subject);
    return left && right ? { subject: left.subject, values: [...left.values, ...right.values] } : undefined;
  }
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return undefined;
  }
  const isCaseValue = (e: ts.Expression) => ts.isLiteralExpression(e) || ts.isPropertyAccessExpression(e) && /^[A-Z]/.test(ctx.text(e)) || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand);
  const isSubject = (e: ts.Expression) => (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && (subject === undefined || ctx.text(e) === subject);
  if (isSubject(expr.left) && isCaseValue(expr.right)) return { subject: ctx.text(expr.left), values: [ctx.text(expr.right)] };
  if (isSubject(expr.right) && isCaseValue(expr.left)) return { subject: ctx.text(expr.right), values: [ctx.text(expr.left)] };
  return undefined;
}

const ifChainToSwitch: Intention = (ctx) => {
  const first = ctx.nearest(ts.isIfStatement, (s) => ctx.onHeader(s) && !(ts.isIfStatement(s.parent) && s.parent.elseStatement === s));
  if (!first) {
    return undefined;
  }
  const branches: { values: string[]; body: ts.Statement }[] = [];
  let subject: string | undefined;
  let fallback: ts.Statement | undefined;
  for (let current: ts.Statement | undefined = first; current; ) {
    if (!ts.isIfStatement(current)) {
      fallback = current;
      break;
    }
    const match = caseValues(current.expression, ctx, subject);
    if (!match) {
      return undefined;
    }
    subject = match.subject;
    branches.push({ values: match.values, body: current.thenStatement });
    current = current.elseStatement;
  }
  if (branches.length < 2 && !fallback) {
    return undefined;
  }
  // An unlabeled break inside a branch would leave the switch instead of the enclosing loop.
  const all = [...branches.map((b) => b.body), ...(fallback ? [fallback] : [])];
  if (all.some((body) => containsInScope(body, (n) => ts.isBreakStatement(n) && !n.label && !isInsideLoopOrSwitch(n, body)) || (ts.isBreakStatement(body) && !body.label))) {
    return undefined;
  }
  const indent = ctx.indentOf(first);
  const unit = ctx.indentUnit;
  const caseBody = (body: ts.Statement): string => {
    const statements = statementsOf(body);
    const lines = statementLines(body, ctx.sourceFile);
    if (!endsWithJump(statements)) lines.push('break;');
    const scoped = statements.some((s) => (ts.isVariableStatement(s) && s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) || ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s));
    return scoped ? ` {\n${indentLines(lines, indent + unit + unit)}\n${indent}${unit}}` : `\n${indentLines(lines, indent + unit + unit)}`;
  };
  const cases = branches.map((b) => b.values.map((v, i) => `${indent}${unit}case ${v}:${i === b.values.length - 1 ? caseBody(b.body) : ''}`).join('\n'));
  if (fallback) {
    cases.push(`${indent}${unit}default:${caseBody(fallback)}`);
  }
  return { id: 'ifChainToSwitch', title: "Replace 'if' chain with 'switch'", edits: [ctx.replace(first, `switch (${subject}) {\n${cases.join('\n')}\n${indent}}`)] };
};

function isInsideLoopOrSwitch(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) {
      return true;
    }
  }
  return false;
}

export const intentionList: { id: string; title: string; run: Intention }[] = [
  { id: 'invertIf', title: "Invert 'if' condition", run: invertIf },
  { id: 'ifToTernary', title: "Replace 'if else' with '?:'", run: ifToTernary },
  { id: 'ternaryToIf', title: "Replace '?:' with 'if else'", run: ternaryToIf },
  { id: 'flipTernary', title: "Flip '?:'", run: flipTernary },
  { id: 'mergeNestedIfs', title: "Merge nested 'if's", run: mergeNestedIfs },
  { id: 'splitAndCondition', title: "Split '&&' into nested 'if's", run: splitAndCondition },
  { id: 'ifChainToSwitch', title: "Replace 'if' chain with 'switch'", run: ifChainToSwitch },
  { id: 'deMorgan', title: "Replace '&&' with '||' (De Morgan)", run: deMorgan },
  { id: 'flipComparison', title: 'Flip comparison', run: flipComparison },
  { id: 'concatToTemplate', title: "Replace '+' with template literal", run: concatToTemplate },
  { id: 'forIndexToForOf', title: "Replace indexed 'for' with 'for...of'", run: forIndexToForOf },
  { id: 'forEachToForOf', title: "Replace 'forEach' with 'for...of'", run: forEachToForOf },
  { id: 'arrowToBlockBody', title: 'Convert arrow function to block body', run: arrowExpressionToBlock },
  { id: 'arrowToExpressionBody', title: 'Convert arrow function to expression body', run: arrowBlockToExpression },
  { id: 'functionToArrow', title: 'Convert to arrow function', run: functionToArrow },
  { id: 'addBraces', title: 'Add braces', run: addBraces },
  { id: 'removeBraces', title: 'Remove braces', run: removeBraces },
  { id: 'splitDeclarations', title: 'Split into separate declarations', run: splitDeclarations },
  { id: 'splitInitializer', title: 'Split into declaration and assignment', run: splitInitializer },
  ...moreIntentions,
];

/** Every intention available at the position. Each result's edits are non-overlapping. */
export function intentionsAt(sourceFile: ts.SourceFile, position: number, indentUnit = '  ', disabled: ReadonlySet<string> = new Set()): IntentionAction[] {
  const ctx = new Context(sourceFile, position, indentUnit);
  const actions: IntentionAction[] = [];
  for (const intention of intentionList) {
    if (disabled.has(intention.id)) {
      continue;
    }
    try {
      const action = intention.run(ctx);
      if (action) {
        actions.push(action);
      }
    } catch {
      // A transformation that cannot handle unusual syntax is simply not offered.
    }
  }
  return actions;
}

/** Applies an intention's edits to text, for tests and previews. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
}
