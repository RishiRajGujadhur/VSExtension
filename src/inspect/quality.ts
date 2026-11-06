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

qualityInspections.push({
  id: 'parseIntRadix',
  title: 'parseInt without a radix',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isCallExpression(node) && /^(Number\.)?parseInt$/.test(node.expression.getText()) && node.arguments.length === 1) {
        out.push(at(ctx.sourceFile, 'parseIntRadix', node, 'Pass the radix: without it, "0x10" parses as hexadecimal.', 'info', [{ title: 'Add radix 10', edits: [{ start: node.arguments[0].end, end: node.arguments[0].end, text: ', 10' }], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'arrayIndexKey',
  title: 'Array index as React key',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText() !== 'key' || !node.initializer || !ts.isJsxExpression(node.initializer) || !node.initializer.expression || !ts.isIdentifier(node.initializer.expression)) return;
      const name = node.initializer.expression.text;
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && /\.map$/.test(p.parent.expression.getText()) && p.parameters[1]?.name.getText() === name) {
          out.push(at(ctx.sourceFile, 'arrayIndexKey', node, 'An index as key mixes up component state when items are added, removed or reordered; use an id from the item.', 'info'));
          break;
        }
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'forInArray',
  title: 'for…in over an array',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isForInStatement(node)) {
        const type = ctx.checker.getTypeAtLocation(node.expression);
        if (ctx.checker.isArrayType(type) || ctx.checker.isTupleType(type)) {
          out.push(at(ctx.sourceFile, 'forInArray', node.expression, 'for…in over an array gives string indexes, including inherited properties; use for…of for the items.', 'warning'));
        }
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'sparseArray',
  title: 'Hole in an array literal',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isArrayLiteralExpression(node) && node.elements.some(ts.isOmittedExpression) && !ts.isBinaryExpression(node.parent)) {
        out.push(at(ctx.sourceFile, 'sparseArray', node, 'A double comma leaves a hole, which map and forEach skip; was a value left out?', 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'instanceofArray',
  title: 'instanceof Array',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && node.right.getText() === 'Array') {
        out.push(at(ctx.sourceFile, 'instanceofArray', node, 'instanceof Array fails for arrays from other frames or realms; Array.isArray() works for all.', 'info', [{ title: 'Use Array.isArray()', edits: [replace(ctx.sourceFile, node, `Array.isArray(${node.left.getText()})`)], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'evalUse',
  title: 'eval or new Function',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if ((ts.isCallExpression(node) && node.expression.getText() === 'eval') || (ts.isNewExpression(node) && node.expression.getText() === 'Function')) {
        out.push(at(ctx.sourceFile, 'evalUse', node, 'Running a string as code is unsafe with any outside input and slow; avoid it.', 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'timerString',
  title: 'String passed to a timer',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const arg = ts.isCallExpression(node) && /^(window\.|globalThis\.)?(setTimeout|setInterval)$/.test(node.expression.getText()) ? node.arguments[0] : undefined;
      if (arg && (ts.isStringLiteral(arg) || ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.push(at(ctx.sourceFile, 'timerString', arg, 'A string here is run like eval; pass a function instead.', 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'primitiveWrapper',
  title: 'new String, Number or Boolean',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isNewExpression(node) && /^(String|Number|Boolean)$/.test(node.expression.getText())) {
        const start = node.getStart(ctx.sourceFile);
        out.push(at(ctx.sourceFile, 'primitiveWrapper', node, `new ${node.expression.getText()}() makes an object, which is always truthy and not ===; call it without new to convert.`, 'warning', [{ title: "Remove 'new'", edits: [{ start, end: node.expression.getStart(ctx.sourceFile), text: '' }], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'promiseResolveInAsync',
  title: 'Promise.resolve or reject in an async function',
  defaultSeverity: 'hint',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isFunctionLike(node) || !(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) || !('body' in node) || !node.body) return;
      walkInScope(node.body as ts.Node, (inner) => {
        const call = ts.isReturnStatement(inner) && inner.expression && ts.isCallExpression(inner.expression) ? inner.expression : undefined;
        const callee = call?.expression.getText();
        if (call && (callee === 'Promise.resolve' || callee === 'Promise.reject') && call.arguments.length <= 1) {
          const value = call.arguments[0]?.getText() ?? '';
          const text = callee === 'Promise.resolve' ? `return${value ? ` ${value}` : ''};` : `throw ${value || 'undefined'};`;
          out.push(at(ctx.sourceFile, 'promiseResolveInAsync', call, callee === 'Promise.resolve' ? 'An async function already wraps its result in a promise.' : 'In an async function, throw rejects the promise.', 'hint', [{ title: callee === 'Promise.resolve' ? 'Return the value' : 'Throw the error', edits: [replace(ctx.sourceFile, inner, text)], preferred: true }]));
        }
      });
    });
    return out;
  },
});

qualityInspections.push({
  id: 'caseFallthrough',
  title: 'Case falls through',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    const jumps = (s: ts.Statement | undefined): boolean => !!s && (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s) || (ts.isBlock(s) && jumps(s.statements[s.statements.length - 1])));
    walk(ctx.sourceFile, (node) => {
      if (!ts.isCaseBlock(node)) return;
      node.clauses.forEach((clause, i) => {
        const next = node.clauses[i + 1];
        if (!next || clause.statements.length === 0 || jumps(clause.statements[clause.statements.length - 1])) return;
        // `// falls through` before the next case says it is on purpose.
        if (/falls?\s*through/i.test(ctx.sourceFile.text.slice(clause.statements[clause.statements.length - 1].end, next.getStart(ctx.sourceFile)))) return;
        out.push(at(ctx.sourceFile, 'caseFallthrough', next, `The case before runs on into this one; add break, or a // falls through comment if it is meant to.`, 'warning'));
      });
    });
    return out;
  },
});

qualityInspections.push({
  id: 'duplicateImport',
  title: 'Module imported twice',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    const seen = new Map<string, boolean>();
    for (const statement of ctx.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
      const key = `${statement.moduleSpecifier.text}|${statement.importClause.isTypeOnly}`;
      if (seen.has(key)) {
        out.push(at(ctx.sourceFile, 'duplicateImport', statement.moduleSpecifier, `'${statement.moduleSpecifier.text}' is already imported above; merge the imports.`, 'info'));
      }
      seen.set(key, true);
    }
    return out;
  },
});

qualityInspections.push({
  id: 'looseEquality',
  title: 'Loose equality (== and !=)',
  defaultSeverity: 'info',
  optIn: true,
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken && node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken)) return;
      // `== null` checks for null and undefined at once, on purpose.
      if ([node.left, node.right].some((e) => unparen(e).kind === ts.SyntaxKind.NullKeyword)) return;
      const strict = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ? '===' : '!==';
      out.push(at(ctx.sourceFile, 'looseEquality', node.operatorToken, `${node.operatorToken.getText()} converts types before comparing; use ${strict}.`, 'info', [{ title: `Use ${strict}`, edits: [replace(ctx.sourceFile, node.operatorToken, strict)], preferred: true }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'awaitInLoop',
  title: 'await inside a loop',
  defaultSeverity: 'info',
  optIn: true,
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!(ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node)) || (ts.isForOfStatement(node) && node.awaitModifier)) return;
      walkInScope(node.statement, (inner) => {
        if (ts.isAwaitExpression(inner)) {
          out.push(at(ctx.sourceFile, 'awaitInLoop', inner, 'Each iteration waits for the one before; if they are independent, start them together with Promise.all.', 'info'));
        }
      });
    });
    return out;
  },
});

qualityInspections.push({
  id: 'redundantReturnAwait',
  title: 'return await outside try',
  defaultSeverity: 'hint',
  optIn: true,
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isReturnStatement(node) || !node.expression || !ts.isAwaitExpression(node.expression)) return;
      for (let p: ts.Node = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
        if (ts.isTryStatement(p)) return;
      }
      const awaitKeyword = node.expression.getFirstToken(ctx.sourceFile)!;
      out.push(at(ctx.sourceFile, 'redundantReturnAwait', awaitKeyword, 'Outside try, returning the promise directly behaves the same.', 'hint', [{ title: "Remove 'await'", edits: [{ start: awaitKeyword.getStart(ctx.sourceFile), end: node.expression.expression.getStart(ctx.sourceFile), text: '' }] }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'deleteArrayElement',
  title: 'delete on an array element',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isDeleteExpression(node) && ts.isElementAccessExpression(unparen(node.expression))) {
        const target = (unparen(node.expression) as ts.ElementAccessExpression).expression;
        if (ctx.checker.isArrayType(ctx.checker.getTypeAtLocation(target))) {
          out.push(at(ctx.sourceFile, 'deleteArrayElement', node, 'delete leaves a hole and keeps the length; use splice() to remove the item.', 'warning'));
        }
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'booleanLiteralCompare',
  title: 'Comparison with true or false',
  defaultSeverity: 'hint',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)) return;
      const literal = (e: ts.Expression) => (unparen(e).kind === ts.SyntaxKind.TrueKeyword ? true : unparen(e).kind === ts.SyntaxKind.FalseKeyword ? false : undefined);
      const [value, other] = literal(node.right) !== undefined ? [literal(node.right), node.left] : [literal(node.left), node.right];
      // `boolean` itself, not `boolean | undefined`, where === true also checks for undefined.
      if (value === undefined || !(ctx.checker.getTypeAtLocation(other).flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))) return;
      const positive = value !== isNegative(node.operatorToken.kind);
      const text = other.getText();
      out.push(at(ctx.sourceFile, 'booleanLiteralCompare', node, `${text} is already a boolean.`, 'hint', [{ title: positive ? `Use ${text}` : `Use !${text}`, edits: [replace(ctx.sourceFile, node, positive ? text : `!${/^[\w.]+$/.test(text) ? text : `(${text})`}`)], preferred: true }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'wrongDirectionLoop',
  title: 'Loop counting the wrong way',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isForStatement(node) || !node.condition || !node.incrementor || !ts.isBinaryExpression(node.condition)) return;
      const counter = unparen(node.condition.left).getText();
      const k = node.condition.operatorToken.kind;
      const up = k === ts.SyntaxKind.LessThanToken || k === ts.SyntaxKind.LessThanEqualsToken;
      const down = k === ts.SyntaxKind.GreaterThanToken || k === ts.SyntaxKind.GreaterThanEqualsToken;
      const inc = node.incrementor;
      const step = (ts.isPrefixUnaryExpression(inc) || ts.isPostfixUnaryExpression(inc)) && inc.operand.getText() === counter ? (inc.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1) : ts.isBinaryExpression(inc) && inc.left.getText() === counter ? (inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? 1 : inc.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ? -1 : 0) : 0;
      if ((up && step < 0) || (down && step > 0)) {
        out.push(at(ctx.sourceFile, 'wrongDirectionLoop', node.incrementor, `${counter} moves away from the end condition, so this loop may never stop.`, 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'negatedInOrInstanceof',
  title: '\'!\' before \'in\' or \'instanceof\'',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.InKeyword || node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) && ts.isPrefixUnaryExpression(node.left) && node.left.operator === ts.SyntaxKind.ExclamationToken) {
        const op = node.operatorToken.getText();
        out.push(at(ctx.sourceFile, 'negatedInOrInstanceof', node, `!${node.left.operand.getText()} ${op} … negates ${node.left.operand.getText()} first; wrap the whole test in !( … ).`, 'warning', [{ title: `Use !(… ${op} …)`, edits: [replace(ctx.sourceFile, node, `!(${node.left.operand.getText()} ${op} ${node.right.getText()})`)], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'bitwiseInCondition',
  title: 'Bitwise \'&\' or \'|\' in a condition',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const condition = ts.isIfStatement(node) || ts.isWhileStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition : undefined;
      const c = condition && unparen(condition);
      if (!c || !ts.isBinaryExpression(c) || (c.operatorToken.kind !== ts.SyntaxKind.AmpersandToken && c.operatorToken.kind !== ts.SyntaxKind.BarToken)) return;
      // Flag masks such as `flags & 4` are bitwise on purpose.
      if ([c.left, c.right].some((o) => ts.isNumericLiteral(unparen(o)) || /flag|mask|bits/i.test(o.getText()))) return;
      const logical = c.operatorToken.kind === ts.SyntaxKind.AmpersandToken ? '&&' : '||';
      out.push(at(ctx.sourceFile, 'bitwiseInCondition', c.operatorToken, `Bitwise ${c.operatorToken.getText()} in a condition; did you mean ${logical}?`, 'info', [{ title: `Use ${logical}`, edits: [replace(ctx.sourceFile, c.operatorToken, logical)] }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'dateMonthOverflow',
  title: 'Month 12 or more in new Date()',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const month = ts.isNewExpression(node) && node.expression.getText() === 'Date' && node.arguments && node.arguments.length >= 2 ? node.arguments[1] : undefined;
      if (month && ts.isNumericLiteral(month) && Number(month.text) >= 12) {
        out.push(at(ctx.sourceFile, 'dateMonthOverflow', month, `Months count from 0, so ${month.text} rolls over into the next year.`, 'info'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'jsonStringifyCollection',
  title: 'JSON.stringify of a Map or Set',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isCallExpression(node) && node.expression.getText() === 'JSON.stringify' && node.arguments[0]) {
        const name = ctx.checker.getTypeAtLocation(node.arguments[0]).getSymbol()?.getName();
        if (name === 'Map' || name === 'Set' || name === 'WeakMap' || name === 'WeakSet') {
          out.push(at(ctx.sourceFile, 'jsonStringifyCollection', node.arguments[0], `JSON.stringify turns a ${name} into {}; convert it first, such as ${name.endsWith('Map') ? 'Object.fromEntries(map)' : '[...set]'}.`, 'warning'));
        }
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'sortWithoutCompare',
  title: 'Sorting numbers without a compare function',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 0 || !ts.isPropertyAccessExpression(node.expression) || !['sort', 'toSorted'].includes(node.expression.name.text)) return;
      const type = ctx.checker.getTypeAtLocation(node.expression.expression);
      if (!ctx.checker.isArrayType(type)) return;
      const element = ctx.checker.getTypeArguments(type as ts.TypeReference)[0];
      if (element && element.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) {
        const open = node.end - 1;
        out.push(at(ctx.sourceFile, 'sortWithoutCompare', node.expression.name, `${node.expression.name.text}() without a compare function sorts numbers as text: [10, 9, 1] becomes [1, 10, 9].`, 'warning', [{ title: 'Sort numerically', edits: [{ start: open, end: open, text: '(a, b) => a - b' }], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'duplicateCaseLabel',
  title: 'Duplicate case label',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isCaseBlock(node)) return;
      const seen = new Set<string>();
      for (const clause of node.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const key = clause.expression.getText().replace(/\s+/g, '');
        if (seen.has(key)) {
          out.push(at(ctx.sourceFile, 'duplicateCaseLabel', clause.expression, `case ${clause.expression.getText()} appears twice; the second one never runs.`, 'warning'));
        }
        seen.add(key);
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'unnecessaryOptionalChain',
  title: 'Unnecessary optional chain',
  defaultSeverity: 'hint',
  run: (ctx) => {
    const out: Finding[] = [];
    const options = ctx.program.getCompilerOptions();
    if (!(options.strictNullChecks ?? options.strict)) return out;
    walk(ctx.sourceFile, (node) => {
      if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) || !node.questionDotToken) return;
      const type = ctx.checker.getTypeAtLocation(node.expression);
      const nullable = (t: ts.Type): boolean => !!(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (t.isUnion() && t.types.some(nullable));
      if (nullable(type)) return;
      const token = node.questionDotToken;
      const text = ts.isPropertyAccessExpression(node) ? '.' : '';
      out.push(at(ctx.sourceFile, 'unnecessaryOptionalChain', token, `${node.expression.getText()} is never null or undefined here, so ?. is not needed.`, 'hint', [{ title: "Remove '?'", edits: [{ start: token.getStart(ctx.sourceFile), end: token.end, text }] }]));
    });
    return out;
  },
});

qualityInspections.push({
  id: 'replaceFirstOnly',
  title: 'replace() with a string changes only the first match',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'replace' && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]) && ctx.checker.getTypeAtLocation(node.expression.expression).flags & ts.TypeFlags.StringLike) {
        out.push(at(ctx.sourceFile, 'replaceFirstOnly', node.expression.name, `replace() with a string changes only the first '${node.arguments[0].text}'; use replaceAll() for every one.`, 'info', [{ title: 'Use replaceAll()', edits: [replace(ctx.sourceFile, node.expression.name, 'replaceAll')] }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'arrayConstructorLength',
  title: 'new Array(n) makes empty slots',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText() === 'Array' && node.arguments?.length === 1 && ctx.checker.getTypeAtLocation(node.arguments[0]).flags & ts.TypeFlags.NumberLike && ts.isPropertyAccessExpression(node.parent) && ['map', 'forEach', 'filter', 'reduce'].includes(node.parent.name.text)) {
        out.push(at(ctx.sourceFile, 'arrayConstructorLength', node, `Array(n) has empty slots that ${node.parent.name.text}() skips; use Array.from({ length: n }, …).`, 'info'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'floatEquality',
  title: 'Exact comparison of decimal arithmetic',
  defaultSeverity: 'info',
  run: (ctx) => {
    const out: Finding[] = [];
    const decimalArithmetic = (e: ts.Expression): boolean => {
      const u = unparen(e);
      return ts.isBinaryExpression(u) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(u.operatorToken.kind) && /\d\.\d/.test(u.getText());
    };
    walk(ctx.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind) && (decimalArithmetic(node.left) || decimalArithmetic(node.right))) {
        out.push(at(ctx.sourceFile, 'floatEquality', node, 'Decimal arithmetic is rarely exact (0.1 + 0.2 !== 0.3); compare with a tolerance such as Number.EPSILON.', 'info'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'unusedCatchBinding',
  title: 'Unused catch variable',
  defaultSeverity: 'hint',
  optIn: true,
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const name = ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : undefined;
      if (name && !new RegExp(`\\b${name}\\b`).test((node as ts.CatchClause).block.getText())) {
        const clause = node as ts.CatchClause;
        const start = clause.getStart(ctx.sourceFile) + 'catch'.length;
        out.push(at(ctx.sourceFile, 'unusedCatchBinding', clause.variableDeclaration!, `${name} is never used; catch without a variable says so.`, 'hint', [{ title: `Remove (${name})`, edits: [{ start, end: clause.block.getStart(ctx.sourceFile), text: ' ' }] }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'missingCallbackReturn',
  title: 'Callback that never returns a value',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    const needsValue = /^(map|filter|find|findIndex|findLast|findLastIndex|some|every|reduce|reduceRight|flatMap|sort|toSorted)$/;
    walk(ctx.sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !needsValue.test(node.expression.name.text)) return;
      const callback = node.arguments[0];
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body) || callback.body.statements.length === 0) return;
      let returns = false;
      walkInScope(callback.body, (inner) => {
        if (ts.isReturnStatement(inner) && inner.expression) returns = true;
      });
      if (!returns && !callback.body.statements.some((s) => ts.isThrowStatement(s))) {
        out.push(at(ctx.sourceFile, 'missingCallbackReturn', callback, `This ${node.expression.name.text}() callback never returns a value, so every result is undefined. Add return, or use an expression body.`, 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'objectLiteralComparison',
  title: 'Comparison with a new object or array',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !comparisons.has(node.operatorToken.kind)) return;
      const literal = [node.left, node.right].map(unparen).find((e) => ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e));
      if (literal) {
        out.push(at(ctx.sourceFile, 'objectLiteralComparison', node, `A new ${ts.isArrayLiteralExpression(literal) ? 'array' : 'object'} is never equal to anything else; check its contents, such as .length === 0.`, 'warning'));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'replaceAllWithoutGlobal',
  title: 'replaceAll() with a regex missing \'g\'',
  defaultSeverity: 'error',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const pattern = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(replaceAll|matchAll)$/.test(node.expression.name.text) ? node.arguments[0] : undefined;
      if (pattern && ts.isRegularExpressionLiteral(pattern) && !/\/[a-z]*g[a-z]*$/.test(pattern.text)) {
        const name = (node as ts.CallExpression & { expression: ts.PropertyAccessExpression }).expression.name.text;
        out.push(at(ctx.sourceFile, 'replaceAllWithoutGlobal', pattern, `${name}() throws a TypeError for a regex without the g flag.`, 'error', [{ title: "Add the 'g' flag", edits: [{ start: pattern.end, end: pattern.end, text: 'g' }], preferred: true }]));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'asyncEffect',
  title: 'Async function passed to useEffect',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      const effect = ts.isCallExpression(node) && /^(React\.)?(useEffect|useLayoutEffect|useInsertionEffect)$/.test(node.expression.getText()) ? node.arguments[0] : undefined;
      if (effect && (ts.isArrowFunction(effect) || ts.isFunctionExpression(effect)) && effect.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        out.push(at(ctx.sourceFile, 'asyncEffect', effect, 'An async effect returns a promise, so React gets no cleanup function and errors go unhandled. Call an async function inside the effect instead.', 'warning'));
      }
    });
    return out;
  },
});
