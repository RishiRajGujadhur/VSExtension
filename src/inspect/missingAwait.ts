import * as ts from 'typescript';
import { Finding, Inspection, InspectionContext } from './inspection';
import { FunctionWithBody, calledFunction, enclosingFunction, forEachDescendant, forEachInFunction, functionLabel, isThenable, nodeText, skipOuterExpressions, symbolAt, containsNullish } from '../structure/util';

export function isAsync(fn: ts.Node | undefined): boolean {
  return !!fn && (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
}

const promiseCombinators = new Set(['all', 'allSettled', 'race', 'any']);

/**
 * Interprocedural Missing Await: promises that are created and then dropped, including those
 * that travel through wrapper functions and helpers that never await them.
 */
export const missingAwait: Inspection = {
  id: 'missingAwait',
  title: 'Missing await',
  defaultSeverity: 'warning',
  run(context) {
    const findings: Finding[] = [];
    const visit = (node: ts.Node) => {
      checkFloating(context, node, findings);
      checkCondition(context, node, findings);
      checkStringified(context, node, findings);
      checkHelperArgument(context, node, findings);
      checkAsyncCallback(context, node, findings);
      checkReturnInTry(context, node, findings);
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
    return findings;
  },
};

function thenable(context: InspectionContext, node: ts.Node): boolean {
  try {
    return isThenable(context.checker, context.checker.getTypeAtLocation(node));
  } catch {
    return false;
  }
}

function awaitFix(context: InspectionContext, expression: ts.Expression, title = 'Add await'): Finding['fixes'] {
  return [{ title, preferred: true, edits: [{ start: expression.getStart(context.sourceFile), end: expression.getStart(context.sourceFile), text: 'await ' }] }];
}

/** A call statement whose promise nobody awaits, returns or handles. */
function checkFloating(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  if (!ts.isExpressionStatement(node)) {
    return;
  }
  const expression = skipOuterExpressions(node.expression);
  if (ts.isVoidExpression(expression) || ts.isAwaitExpression(expression) || (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
    return;
  }
  if (!thenable(context, expression) || handlesRejection(expression)) {
    return;
  }
  const fn = enclosingFunction(node);
  const origin = promiseOrigin(context, expression);
  const via = origin.length > 0 ? ` (from ${origin.map((o) => `${calleeName(o)}()`).join(' → ')})` : '';
  const what = ts.isCallExpression(expression) ? `${calleeName(expression)}()` : nodeText(expression);
  const fixes: Finding['fixes'] = [];
  if (isAsync(fn)) {
    fixes.push(...awaitFix(context, node.expression)!);
  }
  const makeAsync = fn && !isAsync(fn) ? asyncFix(context, fn, node.expression) : undefined;
  if (makeAsync) {
    fixes.push(makeAsync);
  }
  fixes.push({ title: 'Mark as intentionally not awaited (void)', edits: [{ start: node.expression.getStart(context.sourceFile), end: node.expression.getStart(context.sourceFile), text: 'void ' }] });
  // `.catch` binds to the whole expression only when it is a call or a name, not `a ? p() : q()`.
  if (ts.isCallExpression(expression) || ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    fixes.push({ title: 'Handle the rejection with .catch()', edits: [{ start: expression.end, end: expression.end, text: '.catch((error) => console.error(error))' }] });
  }
  findings.push({
    inspection: 'missingAwait',
    message: isAsync(fn)
      ? `The promise returned by ${what}${via} is not awaited, so this function continues before it settles and its rejection is unhandled.`
      : `The promise returned by ${what}${via} is neither awaited nor returned, so its rejection is unhandled.`,
    start: expression.getStart(context.sourceFile),
    end: expression.end,
    severity: 'warning',
    fixes,
    related: origin.map((o) => ({ message: `the promise comes from ${calleeName(o)}()`, node: o })),
  });
}

/** Makes the enclosing function async and awaits the expression, wrapping a declared return type in Promise<…>. */
function asyncFix(context: InspectionContext, fn: FunctionWithBody, expression: ts.Expression): NonNullable<Finding['fixes']>[number] | undefined {
  if (ts.isConstructorDeclaration(fn) || ts.isAccessor(fn) || (fn as ts.FunctionDeclaration).asteriskToken) {
    return undefined;
  }
  const sourceFile = context.sourceFile;
  // `async` goes before `function`, a method's name, or an arrow's parameters, after any other modifiers.
  const keyword = fn.getChildren(sourceFile).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
  const at = keyword ? keyword.getStart(sourceFile) : ts.isMethodDeclaration(fn) ? fn.name.getStart(sourceFile) : ts.isArrowFunction(fn) ? fn.getStart(sourceFile) : undefined;
  if (at === undefined) {
    return undefined;
  }
  const edits = [
    { start: at, end: at, text: 'async ' },
    { start: expression.getStart(sourceFile), end: expression.getStart(sourceFile), text: 'await ' },
  ];
  if (fn.type && !isThenable(context.checker, context.checker.getTypeFromTypeNode(fn.type))) {
    edits.push({ start: fn.type.getStart(sourceFile), end: fn.type.end, text: `Promise<${fn.type.getText(sourceFile)}>` });
  }
  return { title: `Make ${functionLabel(fn)} async and await the call`, edits };
}

/** `.catch(…)` or `.then(onFulfilled, onRejected)` handle the rejection of the chain. */
function handlesRejection(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  const method = expression.expression.name.text;
  return method === 'catch' || (method === 'then' && expression.arguments.length >= 2);
}

/** Wrapper functions that pass on a promise from another call: `save()` → `api.post()`. */
export function promiseOrigin(context: InspectionContext, expression: ts.Expression, depth = 0, seen = new Set<ts.Node>()): ts.CallExpression[] {
  if (!ts.isCallExpression(expression) || depth > 5) {
    return [];
  }
  const fn = calledFunction(context.checker, expression);
  if (!fn || isAsync(fn) || seen.has(fn)) {
    return [];
  }
  seen.add(fn);
  const returned = returnedExpressions(fn).map(skipOuterExpressions).find((e) => ts.isCallExpression(e) && thenable(context, e));
  if (!returned || !ts.isCallExpression(returned)) {
    return [];
  }
  return [returned, ...promiseOrigin(context, returned, depth + 1, seen)];
}

function returnedExpressions(fn: FunctionWithBody): ts.Expression[] {
  if (!ts.isBlock(fn.body!)) {
    return [fn.body as ts.Expression];
  }
  const results: ts.Expression[] = [];
  forEachInFunction(fn.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      results.push(node.expression);
    }
  });
  return results;
}

export function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const callee = skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? `${nodeText(callee.expression)}.${callee.name.text}` : nodeText(callee);
}

/** A promise used as a condition is always truthy. */
function checkCondition(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  let condition: ts.Expression | undefined;
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    condition = node.expression;
  } else if (ts.isConditionalExpression(node)) {
    condition = node.condition;
  } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    condition = node.operand;
  } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    condition = node.left;
  }
  if (!condition) {
    return;
  }
  const inner = skipOuterExpressions(condition);
  if (ts.isBinaryExpression(inner) || ts.isPrefixUnaryExpression(inner) || !thenable(context, inner)) {
    return;
  }
  // `if (promise)` that also might be undefined is a legitimate presence check.
  if (containsNullish(context.checker.getTypeAtLocation(inner))) {
    return;
  }
  findings.push({
    inspection: 'missingAwait',
    message: `${nodeText(inner)} is a promise, which is always truthy. Did you mean to await it?`,
    start: inner.getStart(context.sourceFile),
    end: inner.end,
    severity: 'warning',
    fixes: isAsync(enclosingFunction(node)) ? awaitFix(context, inner) : undefined,
  });
}

/** A promise in a template literal or string concatenation prints `[object Promise]`. */
function checkStringified(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  let operand: ts.Expression | undefined;
  if (ts.isTemplateSpan(node)) {
    operand = node.expression;
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const stringSide = [node.left, node.right].find((s) => context.checker.getTypeAtLocation(s).flags & ts.TypeFlags.StringLike);
    operand = stringSide ? [node.left, node.right].find((s) => s !== stringSide && thenable(context, s)) : undefined;
  }
  if (!operand || !thenable(context, operand)) {
    return;
  }
  findings.push({
    inspection: 'missingAwait',
    message: `${nodeText(operand)} is a promise and is converted to the text "[object Promise]". Did you mean to await it?`,
    start: operand.getStart(context.sourceFile),
    end: operand.end,
    severity: 'warning',
    fixes: isAsync(enclosingFunction(node)) ? [{ title: 'Add await', preferred: true, edits: [{ start: operand.getStart(context.sourceFile), end: operand.end, text: `(await ${operand.getText(context.sourceFile)})` }] }] : undefined,
  });
}

type Consumption = { kind: 'awaits' } | { kind: 'unknown' } | { kind: 'drops'; chain: ts.ParameterDeclaration[] };

/** A promise handed to a project function whose parameter does not expect one and which never awaits it. */
function checkHelperArgument(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  if (!ts.isCallExpression(node) || !node.arguments.length) {
    return;
  }
  const fn = calledFunction(context.checker, node);
  if (!fn) {
    return;
  }
  node.arguments.forEach((argument, index) => {
    const parameter = fn.parameters[Math.min(index, fn.parameters.length - 1)];
    if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !thenable(context, argument)) {
      return;
    }
    const result = consumption(context, fn, parameter, 0, new Set());
    if (result.kind !== 'drops') {
      return;
    }
    const chain = result.chain.map((p) => `${functionLabel(p.parent)}(${p.name.getText()})`).join(' → ');
    findings.push({
      inspection: 'missingAwait',
      message: `${nodeText(argument)} is a promise, but ${chain} never awaits it, so its result and rejection are lost.`,
      start: argument.getStart(context.sourceFile),
      end: argument.end,
      severity: 'warning',
      fixes: isAsync(enclosingFunction(node)) ? awaitFix(context, argument, 'Await before passing') : undefined,
      related: result.chain.map((p) => ({ message: `${p.name.getText()} is not awaited in ${functionLabel(p.parent)}`, node: p })),
    });
  });
}

function consumption(context: InspectionContext, fn: FunctionWithBody, parameter: ts.ParameterDeclaration, depth: number, seen: Set<ts.Node>): Consumption {
  const declaredType = context.checker.getTypeAtLocation(parameter);
  if (isThenable(context.checker, declaredType) || seen.has(parameter) || depth > 4) {
    return { kind: 'awaits' };
  }
  seen.add(parameter);
  const symbol = context.checker.getSymbolAtLocation(parameter.name);
  let unknown = false;
  let awaited = false;
  let passedOn: Consumption | undefined;
  forEachDescendant(fn.body!, (node) => {
    if (awaited || !ts.isIdentifier(node) || symbolAt(context.checker, node) !== symbol) {
      return;
    }
    let use: ts.Node = node;
    while (ts.isParenthesizedExpression(use.parent) || ts.isAsExpression(use.parent) || ts.isNonNullExpression(use.parent)) {
      use = use.parent;
    }
    const parent = use.parent;
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === use) || ts.isYieldExpression(parent)) {
      awaited = true;
    } else if (ts.isPropertyAccessExpression(parent) && ['then', 'catch', 'finally'].includes(parent.name.text)) {
      awaited = true;
    } else if (ts.isCallExpression(parent) && parent.arguments.includes(use as ts.Expression)) {
      const callee = calledFunction(context.checker, parent);
      const target = skipOuterExpressions(parent.expression);
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Promise' && promiseCombinators.has(target.name.text)) {
        awaited = true;
      } else if (callee) {
        const index = parent.arguments.indexOf(use as ts.Expression);
        const next = callee.parameters[Math.min(index, callee.parameters.length - 1)];
        const result = next && !next.dotDotDotToken && ts.isIdentifier(next.name) ? consumption(context, callee, next, depth + 1, seen) : { kind: 'unknown' as const };
        if (result.kind === 'awaits') {
          awaited = true;
        } else if (result.kind === 'unknown') {
          unknown = true;
        } else {
          passedOn = result;
        }
      } else if (!(ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'console')) {
        unknown = true;
      }
    } else if (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent)) {
      // `Promise.all([p, q])`
      awaited = true;
    } else if (!ts.isTemplateSpan(parent) && !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      // Stored, spread or otherwise escaping: cannot be followed.
      unknown = true;
    }
  });
  if (awaited) {
    return { kind: 'awaits' };
  }
  if (unknown) {
    return { kind: 'unknown' };
  }
  return { kind: 'drops', chain: [parameter, ...(passedOn?.kind === 'drops' ? passedOn.chain : [])] };
}

/** `items.forEach(async (x) => …)` runs the callbacks without waiting for them. */
function checkAsyncCallback(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return;
  }
  const method = node.expression.name.text;
  const callback = node.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !isAsync(callback)) {
    return;
  }
  if (method === 'forEach') {
    findings.push({
      inspection: 'missingAwait',
      message: 'forEach ignores the promises returned by an async callback, so the loop does not wait and rejections are unhandled. Use for…of with await, or await Promise.all(items.map(…)).',
      start: node.expression.name.getStart(context.sourceFile),
      end: node.expression.name.end,
      severity: 'warning',
    });
  } else if (method === 'map' && ts.isExpressionStatement(node.parent)) {
    findings.push({
      inspection: 'missingAwait',
      message: 'The promises created by this async map callback are discarded. Wrap it in await Promise.all(…).',
      start: node.expression.name.getStart(context.sourceFile),
      end: node.expression.name.end,
      severity: 'warning',
      fixes: isAsync(enclosingFunction(node))
        ? [{ title: 'Wrap in await Promise.all(…)', preferred: true, edits: [{ start: node.getStart(context.sourceFile), end: node.end, text: `await Promise.all(${node.getText(context.sourceFile)})` }] }]
        : undefined,
    });
  }
}

/** `return fetchX()` inside `try` of an async function: the rejection bypasses the catch block. */
function checkReturnInTry(context: InspectionContext, node: ts.Node, findings: Finding[]): void {
  if (!ts.isReturnStatement(node) || !node.expression || ts.isAwaitExpression(skipOuterExpressions(node.expression))) {
    return;
  }
  const fn = enclosingFunction(node);
  if (!isAsync(fn) || !thenable(context, node.expression)) {
    return;
  }
  for (let current: ts.Node = node; current.parent && current !== fn; current = current.parent) {
    const parent = current.parent;
    if (ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) {
      findings.push({
        inspection: 'missingAwait',
        message: 'This promise is returned without await inside try, so if it rejects, the catch block below does not run.',
        start: node.expression.getStart(context.sourceFile),
        end: node.expression.end,
        severity: 'warning',
        fixes: awaitFix(context, node.expression),
        related: [{ message: 'catch block that is bypassed', node: parent.catchClause }],
      });
      return;
    }
  }
}
