import * as ts from 'typescript';
import { findNode } from '../analysis/impact';
import { normalizePath } from '../analysis/paths';
import { resolveAlias } from '../analysis/referenceIndex';
import { CallContext, ParameterSpec, changeSignature } from './changeSignature';
import { FunctionNode, isValidIdentifier, parenthesize } from './common';
import { Edit, replace } from './edits';
import { Conflict, RefactorError, RefactorResult } from './types';
import { VirtualProject } from './virtualProject';

export interface IntroduceParameterOptions {
  name: string;
  /** required: callers pass the expression. optional: it becomes the default value and callers are unchanged. */
  mode: 'required' | 'optional';
  /** Replace every identical expression in the function, not just the selected one. */
  replaceAll: boolean;
}

export interface IntroduceParameterInfo {
  expression: string;
  functionName: string;
  suggestedName: string;
  type: string;
  occurrences: number;
}

interface Selection {
  expression: ts.Expression;
  fn: FunctionNode;
  nameNode: ts.Node;
  functionName: string;
}

export function describeIntroduceParameter(project: VirtualProject, fileName: string, start: number, end: number): IntroduceParameterInfo {
  const selection = select(project, fileName, start, end);
  checkMovable(project, selection, 'optional');
  return {
    expression: selection.expression.getText(),
    functionName: selection.functionName,
    suggestedName: suggestName(selection),
    type: typeOf(project, selection.expression),
    occurrences: occurrences(selection).length,
  };
}

export function introduceParameter(project: VirtualProject, fileName: string, start: number, end: number, options: IntroduceParameterOptions): RefactorResult {
  const selection = select(project, fileName, start, end);
  const { fn, expression } = selection;
  if (!isValidIdentifier(options.name)) {
    throw new RefactorError(`'${options.name}' is not a valid parameter name.`);
  }
  if (fn.parameters.some((p) => p.name.getText() === options.name) || declaredInBody(fn).has(options.name)) {
    throw new RefactorError(`'${options.name}' is already used in ${selection.functionName}.`);
  }
  const substitutions = checkMovable(project, selection, options.mode);
  const checker = project.program().getTypeChecker();
  const sourceFile = expression.getSourceFile();
  const typed = !/\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const type = typed ? typeOf(project, expression) : '';
  const valueText = unparenthesizedText(expression);
  const conflicts: Conflict[] = [];

  const existing: ParameterSpec[] = fn.parameters.map((p, i) => ({ originalIndex: i, name: p.name.getText(sourceFile) }));
  const restIndex = fn.parameters.findIndex((p) => p.dotDotDotToken);
  const added: ParameterSpec =
    options.mode === 'optional'
      ? { name: options.name, type: type || undefined, initializer: valueText, callValue: '' }
      : {
          name: options.name,
          type: type || undefined,
          callValue: (context) => callValue(checker, selection, substitutions, context, conflicts),
        };
  const parameters = restIndex >= 0 ? [...existing.slice(0, restIndex), added, ...existing.slice(restIndex)] : [...existing, added];

  const targets = options.replaceAll ? occurrences(selection) : [expression];
  const result = changeSignature(
    project,
    sourceFile.fileName,
    selection.nameNode.getStart(sourceFile),
    {
      parameters,
      bodyEdits: (): Edit[] => targets.map((t) => replace(t.getStart(sourceFile), t.end, options.name)),
    },
    `Introduce Parameter ${options.name}`,
  );
  result.conflicts.unshift(...conflicts);
  return result;
}

function select(project: VirtualProject, fileName: string, start: number, end: number): Selection {
  const sourceFile = project.sourceFile(fileName);
  const text = sourceFile.text;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;

  let expression: ts.Expression | undefined;
  for (let node: ts.Node | undefined = findNode(sourceFile, start); node && !ts.isSourceFile(node); node = node.parent) {
    if (node.getStart(sourceFile) <= start && node.end >= end && isIntroducible(node)) {
      // An empty selection picks the innermost complete expression at the cursor.
      if (start === end || (node.getStart(sourceFile) === start && node.end === end)) {
        expression = node;
      }
      break;
    }
  }
  if (!expression) {
    throw new RefactorError('Select a complete expression inside a function.');
  }
  if (start === end && ts.isCallExpression(expression.parent) && expression.parent.expression === expression) {
    expression = expression.parent; // On a method name, take the call rather than the unbound method.
  }
  for (let node: ts.Node = expression.parent; !ts.isSourceFile(node); node = node.parent) {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const owner = node.parent;
      const nameNode =
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name
          ? node.name
          : (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) && owner.initializer === node
            ? owner.name
            : undefined;
      if (!nameNode) {
        throw new RefactorError('The expression must be inside a named function, method or function-valued variable.');
      }
      if (!('body' in node) || !node.body || !isWithin(expression, node.body)) {
        throw new RefactorError('Select an expression in the function body.');
      }
      return { expression, fn: node, nameNode, functionName: nameNode.getText(sourceFile) };
    }
  }
  throw new RefactorError('The expression must be inside a function.');
}

function isIntroducible(node: ts.Node): node is ts.Expression {
  if (!ts.isExpression(node) || ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return false;
  }
  const parent = node.parent;
  // Names in `a.b`, object keys and declaration names are not standalone expressions.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return false;
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
  return !ts.isOmittedExpression(node) && !ts.isSpreadElement(node);
}

/**
 * Checks that the expression can be evaluated outside the function and returns how each of
 * its references to the function's own parameters and `this` must be substituted at a call.
 */
function checkMovable(project: VirtualProject, selection: Selection, mode: IntroduceParameterOptions['mode']): Substitution[] {
  const { expression, fn } = selection;
  const checker = project.program().getTypeChecker();
  const substitutions: Substitution[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'arguments') {
      throw new RefactorError("The expression uses 'arguments', which has no meaning outside the function.");
    }
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      throw new RefactorError(`The expression uses '${ts.isAwaitExpression(node) ? 'await' : 'yield'}', which cannot move to a parameter.`);
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (ts.isArrowFunction(fn) && mode === 'required') {
        throw new RefactorError("The expression uses 'this' inside an arrow function, which callers cannot supply.");
      }
      substitutions.push({ node, kind: 'this' });
    }
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const declaration = symbol && resolveAlias(checker, symbol).declarations?.[0];
      if (declaration && ts.isParameter(declaration) && declaration.parent === fn) {
        substitutions.push({ node, kind: 'parameter', index: fn.parameters.indexOf(declaration) });
      } else if (declaration && isWithin(declaration, fn) && !isWithin(declaration, expression)) {
        throw new RefactorError(`The expression uses '${node.text}', which is declared inside ${selection.functionName}.`);
      } else if (symbol && mode === 'required') {
        substitutions.push({ node, kind: 'free', symbol: resolveAlias(checker, symbol) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return substitutions;
}

type Substitution =
  | { node: ts.Node; kind: 'this' }
  | { node: ts.Node; kind: 'parameter'; index: number }
  | { node: ts.Node; kind: 'free'; symbol: ts.Symbol };

/** The expression as a caller must write it: the function's parameters become the call's arguments. */
function callValue(checker: ts.TypeChecker, selection: Selection, substitutions: Substitution[], context: CallContext, conflicts: Conflict[]): string {
  const { expression, fn } = selection;
  const sourceFile = expression.getSourceFile();
  const callFile = context.call.getSourceFile();
  const base = expression.getStart(sourceFile);
  let text = unparenthesizedText(expression);
  const offset = expression.getText(sourceFile).indexOf(text);
  const location = () => ({ file: normalizePath(callFile.fileName), ...callFile.getLineAndCharacterOfPosition(context.call.getStart(callFile)) });
  const replacements: { start: number; end: number; text: string }[] = [];

  for (const substitution of substitutions) {
    const start = substitution.node.getStart(sourceFile) - base - offset;
    const end = substitution.node.end - base - offset;
    if (start < 0 || end > text.length) continue;
    if (substitution.kind === 'parameter') {
      const argument = context.argumentText(substitution.index);
      const fallback = fn.parameters[substitution.index].initializer?.getText(sourceFile) ?? 'undefined';
      replacements.push({ start, end, text: parenthesize(argument ?? fallback) });
    } else if (substitution.kind === 'this') {
      const callee = context.call.expression;
      if (ts.isPropertyAccessExpression(callee) && isPlainReference(callee.expression)) {
        replacements.push({ start, end, text: callee.expression.getText(callFile) });
      } else {
        conflicts.push({ message: `Cannot tell what 'this' is at the call ${context.call.getText(callFile)}; it was left as 'this'.`, location: location() });
      }
    } else if (!inScope(checker, substitution.symbol, context.call)) {
      conflicts.push({ message: `'${substitution.node.getText(sourceFile)}' is not in scope at ${context.call.getText(callFile)}; add an import there.`, location: location() });
    }
  }
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, r.start) + r.text + text.slice(r.end);
  }
  return text;
}

/** Whether the symbol is visible under its own name at `at`, directly or through an import. */
function inScope(checker: ts.TypeChecker, symbol: ts.Symbol, at: ts.Node): boolean {
  return checker
    .getSymbolsInScope(at, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
    .some((s) => s.getName() === symbol.getName() && (s === symbol || resolveAlias(checker, s) === symbol));
}

function isPlainReference(node: ts.Expression): boolean {
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(node) && isPlainReference(node.expression));
}

/** Expressions in the function body with the same text as the selection. */
function occurrences(selection: Selection): ts.Expression[] {
  const { expression, fn } = selection;
  const normalize = (n: ts.Node) => unparenthesizedText(n as ts.Expression).replace(/\s+/g, ' ');
  const wanted = normalize(expression);
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === expression.kind && isIntroducible(node) && normalize(node) === wanted) {
      found.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  if ('body' in fn && fn.body) visit(fn.body);
  return found.length > 0 ? found : [expression];
}

function typeOf(project: VirtualProject, expression: ts.Expression): string {
  if (/\.[cm]?jsx?$/i.test(expression.getSourceFile().fileName)) {
    return '';
  }
  const checker = project.program().getTypeChecker();
  const type = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(expression));
  const text = checker.typeToString(type, expression, ts.TypeFormatFlags.NoTruncation);
  // Types that cannot be written at the declaration are left to inference.
  return /import\(|^any$|typeof /.test(text) ? '' : text;
}

function suggestName(selection: Selection): string {
  const expr = selection.expression;
  let base = 'value';
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isIdentifier(inner)) base = inner.text;
  else if (ts.isPropertyAccessExpression(inner)) base = inner.name.text;
  else if (ts.isCallExpression(inner)) {
    const callee = ts.isPropertyAccessExpression(inner.expression) ? inner.expression.name.text : inner.expression.getText();
    base = callee.replace(/^(get|create|compute|calculate|load|read|find)(?=[A-Z])/, '');
    base = base.charAt(0).toLowerCase() + base.slice(1);
  } else if (ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner)) base = 'text';
  else if (ts.isArrayLiteralExpression(inner)) base = 'items';
  else if (ts.isObjectLiteralExpression(inner)) base = 'options';
  if (!isValidIdentifier(base)) base = 'value';
  const used = new Set([...selection.fn.parameters.map((p) => p.name.getText()), ...declaredInBody(selection.fn)]);
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  return name;
}

function declaredInBody(fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isParameter(node)) && node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  if ('body' in fn && fn.body) visit(fn.body);
  return names;
}

function unparenthesizedText(expression: ts.Expression): string {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner.getText();
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.getStart() >= container.getStart() && node.end <= container.end;
}
