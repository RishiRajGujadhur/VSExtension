import * as ts from 'typescript';

/** Binding strength of an expression's outermost operator; higher binds tighter. */
export function precedence(node: ts.Expression): number {
  if (ts.isParenthesizedExpression(node)) return 20;
  if (ts.isCommaListExpression(node)) return 0;
  if (ts.isBinaryExpression(node)) return binaryPrecedence(node.operatorToken.kind);
  if (ts.isConditionalExpression(node) || ts.isArrowFunction(node) || ts.isYieldExpression(node)) return 2;
  if (ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node) || ts.isDeleteExpression(node) || ts.isAwaitExpression(node)) return 15;
  if (ts.isPostfixUnaryExpression(node)) return 16;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return 10;
  if (ts.isNonNullExpression(node) || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isNewExpression(node)) return 17;
  return 20;
}

export function binaryPrecedence(kind: ts.SyntaxKind): number {
  switch (kind) {
    case ts.SyntaxKind.CommaToken:
      return 0;
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return 2;
    // `??` cannot mix with `||` or `&&` without parentheses, so it ranks below both.
    case ts.SyntaxKind.QuestionQuestionToken:
      return 3;
    case ts.SyntaxKind.BarBarToken:
      return 4;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return 5;
    case ts.SyntaxKind.BarToken:
      return 6;
    case ts.SyntaxKind.CaretToken:
      return 7;
    case ts.SyntaxKind.AmpersandToken:
      return 8;
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return 9;
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.InstanceOfKeyword:
    case ts.SyntaxKind.InKeyword:
      return 10;
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return 11;
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
      return 12;
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
      return 13;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return 14;
    default:
      return 10;
  }
}

/** Parses expression text so generated code can be checked for precedence. */
export function parseExpression(text: string): ts.Expression {
  const file = ts.createSourceFile('x.tsx', `(${text});`, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  if (statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)) {
    return statement.expression.expression;
  }
  return ts.factory.createIdentifier(text);
}

/** Wraps text in parentheses when its outermost operator binds looser than `minimum`. */
export function wrap(text: string, minimum: number): string {
  return precedence(parseExpression(text)) < minimum ? `(${text})` : text;
}

/** Strips redundant outer parentheses from a node, returning the inner expression. */
export function unparen(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

const negatedOperators = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
  [ts.SyntaxKind.EqualsEqualsToken, '!='],
  [ts.SyntaxKind.ExclamationEqualsToken, '=='],
  [ts.SyntaxKind.LessThanToken, '>='],
  [ts.SyntaxKind.GreaterThanToken, '<='],
  [ts.SyntaxKind.LessThanEqualsToken, '>'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '<'],
]);

/**
 * The logical negation of an expression, simplified: `!x` becomes `x`, comparisons flip,
 * `&&`/`||` follow De Morgan's laws, and literals invert.
 */
export function negate(node: ts.Expression, sourceFile: ts.SourceFile): string {
  const expr = unparen(node);
  const text = (n: ts.Node) => n.getText(sourceFile);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return text(unparen(expr.operand));
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'true';
  if (ts.isBinaryExpression(expr)) {
    const flipped = negatedOperators.get(expr.operatorToken.kind);
    if (flipped) {
      return `${text(expr.left)} ${flipped} ${text(expr.right)}`;
    }
    const kind = expr.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
      const and = kind === ts.SyntaxKind.BarBarToken;
      const minimum = and ? 5 : 4;
      return `${wrap(negate(expr.left, sourceFile), minimum)} ${and ? '&&' : '||'} ${wrap(negate(expr.right, sourceFile), minimum)}`;
    }
  }
  return `!${wrap(text(expr), 15)}`;
}

export function lineIndent(sourceFile: ts.SourceFile, position: number): string {
  const text = sourceFile.text;
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Statements as lines without their common indentation, ready to be re-indented. A block
 * yields its contents; any other statement yields itself, comments included.
 */
export function statementLines(statement: ts.Statement, sourceFile: ts.SourceFile): string[] {
  const text = sourceFile.text;
  let body: string;
  if (ts.isBlock(statement)) {
    if (statement.statements.length === 0) {
      const inner = text.slice(statement.getStart(sourceFile) + 1, statement.end - 1);
      return inner.trim() ? dedent(inner.split('\n').filter((l) => l.trim())) : [];
    }
    const first = statement.statements[0];
    const comments = ts.getLeadingCommentRanges(text, first.getFullStart()) ?? [];
    const start = comments.length > 0 ? Math.min(comments[0].pos, first.getStart(sourceFile)) : first.getStart(sourceFile);
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const leadingIsCode = text.slice(lineStart, start).trim() !== '';
    body = (leadingIsCode ? lineIndent(sourceFile, start) : text.slice(lineStart, start)) + text.slice(start, statement.statements[statement.statements.length - 1].end);
    const trailing = ts.getTrailingCommentRanges(text, statement.statements[statement.statements.length - 1].end) ?? [];
    if (trailing.length > 0) {
      body += text.slice(statement.statements[statement.statements.length - 1].end, trailing[trailing.length - 1].end);
    }
  } else {
    body = lineIndent(sourceFile, statement.getStart(sourceFile)) + statement.getText(sourceFile);
  }
  return dedent(body.split('\n'));
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim() ? l.slice(common) : '')).map((l) => l.replace(/\s+$/, ''));
}

/** Joins lines, indenting each non-empty one. */
export function indentLines(lines: string[], indent: string): string {
  return lines.map((l) => (l ? indent + l : l)).join('\n');
}

/** Whether a statement list's last statement already leaves the enclosing block. */
export function endsWithJump(statements: readonly ts.Statement[]): boolean {
  const last = statements[statements.length - 1];
  return !!last && (ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isBreakStatement(last) || ts.isContinueStatement(last));
}

export function statementsOf(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? statement.statements : [statement];
}

/** Visits a node's descendants without entering nested functions or classes, which have their own `this`, `return` and labels. */
export function forEachInScope(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  const walk = (child: ts.Node): void => {
    if (visit(child) === false) {
      return;
    }
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) {
      return;
    }
    ts.forEachChild(child, walk);
  };
  ts.forEachChild(node, walk);
}

export function containsInScope(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  forEachInScope(node, (child) => {
    if (found || predicate(child)) {
      found = true;
      return false;
    }
  });
  return found;
}
