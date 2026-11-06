import * as ts from 'typescript';
import { Finding, Fix, Inspection, Severity } from './inspection';

/** Inspections for common slips: what is wrong in a few words and, where it is clear, the fix. */
export const qualityInspections: Inspection[] = [];

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Like walk, without entering nested functions or classes. */
function walkInScope(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) walkInScope(child, visit);
  });
}

function at(sf: ts.SourceFile, inspection: string, node: ts.Node, message: string, severity: Severity, fixes?: Fix[]): Finding {
  return { inspection, message, start: node.getStart(sf), end: node.end, severity, fixes };
}

const replace = (sf: ts.SourceFile, node: ts.Node, text: string) => ({ start: node.getStart(sf), end: node.end, text });

/** An edit that removes a statement with its line, when nothing else is on it. */
function removeStatement(sf: ts.SourceFile, statement: ts.Node): { start: number; end: number; text: string } {
  const text = sf.text;
  let start = statement.getStart(sf);
  let end = statement.end;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  if (!text.slice(lineStart, start).trim() && !text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim()) {
    start = lineStart;
    end = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return { start, end, text: '' };
}

const unparen = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);

/** A reference without side effects: `x`, `this.x`, `a.b.c`. */
function isSimple(e: ts.Expression): boolean {
  const u = unparen(e);
  return ts.isIdentifier(u) || u.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(u) && isSimple(u.expression));
}

const comparisons = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const isNegative = (kind: ts.SyntaxKind) => kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;

qualityInspections.push({
  id: 'selfAssignment',
  title: 'Self-assignment',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isSimple(node.left) && unparen(node.left).getText() === unparen(node.right).getText()) {
        out.push(at(ctx.sourceFile, 'selfAssignment', node, `${node.left.getText()} is assigned to itself, which does nothing.`, 'warning', ts.isExpressionStatement(node.parent) ? [{ title: 'Remove the assignment', edits: [removeStatement(ctx.sourceFile, node.parent)], preferred: true }] : undefined));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'nanComparison',
  title: 'Comparison with NaN',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !comparisons.has(node.operatorToken.kind)) return;
      const isNaN = (e: ts.Expression) => /^(Number\.)?NaN$/.test(unparen(e).getText());
      const other = isNaN(node.right) ? node.left : isNaN(node.left) ? node.right : undefined;
      if (!other) return;
      const negative = isNegative(node.operatorToken.kind);
      out.push(at(ctx.sourceFile, 'nanComparison', node, `Comparing with NaN is always ${negative ? 'true' : 'false'}; use Number.isNaN().`, 'warning', [{ title: 'Use Number.isNaN()', edits: [replace(ctx.sourceFile, node, `${negative ? '!' : ''}Number.isNaN(${other.getText()})`)], preferred: true }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'asyncPromiseExecutor',
  title: 'Async Promise executor',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const executor = ts.isNewExpression(node) && node.expression.getText() === 'Promise' ? node.arguments?.[0] : undefined;
      if (executor && (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) && executor.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        out.push(at(ctx.sourceFile, 'asyncPromiseExecutor', executor, 'An async executor swallows errors it throws, and the promise never settles. Make the outer function async instead.', 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'emptyCatch',
  title: 'Empty catch block',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0 && !/\/\/|\/\*/.test(node.block.getText())) {
        const sf = ctx.sourceFile;
        const indent = /^[ \t]*/.exec(sf.text.slice(sf.text.lastIndexOf('\n', node.getStart(sf) - 1) + 1))![0];
        out.push(at(sf, 'emptyCatch', node, 'The error is silently ignored. Handle it, or say why it is safe to ignore.', 'info', [{ title: 'Add a comment saying why it is ignored', edits: [replace(sf, node.block, `{\n${indent}  // Ignored on purpose: \n${indent}}`)] }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'assignmentInCondition',
  title: 'Assignment in a condition',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const condition = ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition : undefined;
      // A parenthesized assignment, `while ((m = re.exec(s)))`, is the usual way to say it is on purpose.
      if (condition && ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        out.push(at(ctx.sourceFile, 'assignmentInCondition', condition, `This assigns ${condition.left.getText()} instead of comparing it.`, 'warning', [{ title: "Compare with '==='", edits: [replace(ctx.sourceFile, condition.operatorToken, '===')], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'duplicateCondition',
  title: 'Repeated condition in an if chain',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isIfStatement(node) || (ts.isIfStatement(node.parent) && node.parent.elseStatement === node)) return;
      const seen = new Map<string, number>();
      for (let current: ts.Statement | undefined = node; current && ts.isIfStatement(current); current = current.elseStatement) {
        const key = current.expression.getText().replace(/\s+/g, '');
        if (seen.has(key)) {
          out.push(at(ctx.sourceFile, 'duplicateCondition', current.expression, `Same condition as line ${seen.get(key)}: this branch never runs.`, 'warning'));
        } else {
          seen.set(key, ctx.sourceFile.getLineAndCharacterOfPosition(current.expression.getStart()).line + 1);
        }
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'identicalBranches',
  title: 'Identical branches',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    const same = (a: ts.Node, b: ts.Node) => a.getText().replace(/\s+/g, '') === b.getText().replace(/\s+/g, '');
    walk(ctx.sourceFile, (node) => {
      if (ts.isIfStatement(node) && node.elseStatement && !ts.isIfStatement(node.elseStatement) && same(node.thenStatement, node.elseStatement)) {
        out.push(at(ctx.sourceFile, 'identicalBranches', node.expression, 'Both branches do the same thing, so the condition has no effect.', 'info'));
      }
      if (ts.isConditionalExpression(node) && same(node.whenTrue, node.whenFalse)) {
        out.push(at(ctx.sourceFile, 'identicalBranches', node, 'Both results are the same, so the condition has no effect.', 'info', [{ title: 'Keep only the value', edits: [replace(ctx.sourceFile, node, node.whenTrue.getText())] }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'constantCondition',
  title: 'Constant condition',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const condition = ts.isIfStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isWhileStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition : undefined;
      const c = condition && unparen(condition);
      if (!c) return;
      const value = c.kind === ts.SyntaxKind.TrueKeyword ? true : c.kind === ts.SyntaxKind.FalseKeyword ? false : ts.isNumericLiteral(c) ? c.text !== '0' : ts.isStringLiteral(c) ? c.text !== '' : undefined;
      // `while (true)` is the usual endless loop.
      if (value === undefined || (value && ts.isWhileStatement(node))) return;
      out.push(at(ctx.sourceFile, 'constantCondition', c, `The condition is always ${value}.`, 'info'));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'selfComparison',
  title: 'Comparison with itself',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !isSimple(node.left) || unparen(node.left).getText() !== unparen(node.right).getText()) return;
      const k = node.operatorToken.kind;
      if (!comparisons.has(k) && ![ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(k)) return;
      const nanCheck = isNegative(k);
      out.push(at(ctx.sourceFile, 'selfComparison', node, nanCheck ? `${node.left.getText()} !== itself is a hidden NaN check; Number.isNaN() says so.` : `${node.left.getText()} is compared with itself.`, nanCheck ? 'info' : 'warning', nanCheck ? [{ title: 'Use Number.isNaN()', edits: [replace(ctx.sourceFile, node, `Number.isNaN(${node.left.getText()})`)] }] : undefined));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'typeofTypo',
  title: 'Misspelled typeof result',
  defaultSeverity: 'error',
  run: (ctx) => {
    const out: Finding[] = [];
    const valid = new Set(['string', 'number', 'bigint', 'boolean', 'symbol', 'undefined', 'object', 'function']);
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !comparisons.has(node.operatorToken.kind)) return;
      const literal = ts.isTypeOfExpression(unparen(node.left)) ? unparen(node.right) : ts.isTypeOfExpression(unparen(node.right)) ? unparen(node.left) : undefined;
      if (literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) && !valid.has(literal.text)) {
        const guess = [...valid].find((v) => v.startsWith(literal.text.slice(0, 2)));
        out.push(at(ctx.sourceFile, 'typeofTypo', literal, `typeof never returns '${literal.text}'${guess ? `; did you mean '${guess}'?` : '.'}`, 'error', guess ? [{ title: `Change to '${guess}'`, edits: [replace(ctx.sourceFile, literal, `'${guess}'`)], preferred: true }] : undefined));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'returnInFinally',
  title: 'return in finally',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isTryStatement(node) && node.finallyBlock) {
        walkInScope(node.finallyBlock, (inner) => {
          if (ts.isReturnStatement(inner) || ts.isThrowStatement(inner)) {
            out.push(at(ctx.sourceFile, 'returnInFinally', inner, `A ${ts.isReturnStatement(inner) ? 'return' : 'throw'} in finally replaces any error or return value from the try block.`, 'warning'));
          }
        });
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'throwLiteral',
  title: 'Throwing a non-Error',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const thrown = ts.isThrowStatement(node) ? unparen(node.expression) : undefined;
      if (thrown && (ts.isStringLiteral(thrown) || ts.isNoSubstitutionTemplateLiteral(thrown) || ts.isTemplateExpression(thrown) || ts.isNumericLiteral(thrown))) {
        const message = ts.isNumericLiteral(thrown) ? `'${thrown.text}'` : thrown.getText();
        out.push(at(ctx.sourceFile, 'throwLiteral', thrown, 'Throw an Error, so the error has a stack trace.', 'warning', [{ title: 'Wrap in new Error()', edits: [replace(ctx.sourceFile, thrown, `new Error(${message})`)], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'noEffectExpression',
  title: 'Expression with no effect',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isExpressionStatement(node)) return;
      const e = unparen(node.expression);
      const isDirective = ts.isStringLiteral(e) && (ts.isSourceFile(node.parent) || ts.isBlock(node.parent));
      const pure =
        ts.isIdentifier(e) || ts.isNumericLiteral(e) || (ts.isStringLiteral(e) && !isDirective) ||
        (ts.isBinaryExpression(e) && (comparisons.has(e.operatorToken.kind) || [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken].includes(e.operatorToken.kind)) && !ts.isCallExpression(unparen(e.right)) && !ts.isCallExpression(unparen(e.left))) ||
        (ts.isPrefixUnaryExpression(e) && [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(e.operator));
      if (pure && !(ts.isStringLiteral(e) && isDirective)) {
        out.push(at(ctx.sourceFile, 'noEffectExpression', node, 'This expression does nothing: did you mean to assign, return or call it?', 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'debuggerStatement',
  title: 'debugger statement',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isDebuggerStatement(node)) {
        out.push(at(ctx.sourceFile, 'debuggerStatement', node, 'debugger stops the program when DevTools are open; remove it before committing.', 'warning', [{ title: 'Remove debugger', edits: [removeStatement(ctx.sourceFile, node)], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'consoleLog',
  title: 'console.log left in code',
  defaultSeverity: 'hint',
  optIn: true,
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && /^console\.(log|debug|info|trace|dir)$/.test(node.expression.expression.getText())) {
        out.push(at(ctx.sourceFile, 'consoleLog', node.expression, `${node.expression.expression.getText()}() is debugging output; remove it or use a logger.`, 'hint', [{ title: 'Remove the call', edits: [removeStatement(ctx.sourceFile, node)], preferred: true }]));
      }
    });
    return out;
  },
});
