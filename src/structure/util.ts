import ts = require('typescript');
import { findIdentifier, findNode } from '../analysis/impact';
import { pathKey } from '../analysis/paths';
import { projectSourceFiles, resolveAlias } from '../analysis/referenceIndex';
import { AnalysisError } from '../analysis/types';

export type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)) &&
    !!node.body
  );
}

/** The innermost function whose body contains the node, if any. */
export function enclosingFunction(node: ts.Node): FunctionWithBody | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionWithBody(current)) {
      return current;
    }
  }
  return undefined;
}

/** The function declared or called at the offset, or the one containing it. */
export function functionAtOffset(sourceFile: ts.SourceFile, offset: number, checker: ts.TypeChecker): FunctionWithBody {
  const identifier = findIdentifier(sourceFile, offset);
  if (identifier) {
    const declared = declaredFunction(identifier);
    if (declared) {
      return declared;
    }
    const symbol = symbolAt(checker, identifier);
    const target = symbol?.declarations?.map(functionOfDeclaration).find((f): f is FunctionWithBody => !!f && !f.getSourceFile().isDeclarationFile);
    if (target) {
      return target;
    }
  }
  const node = findNode(sourceFile, offset);
  const containing = isFunctionWithBody(node) ? node : enclosingFunction(node);
  if (!containing) {
    throw new AnalysisError('Place the cursor in a function or on a call.');
  }
  return containing;
}

/** The function a declaration name introduces, such as `f` in `const f = () => …`. */
function declaredFunction(name: ts.Node): FunctionWithBody | undefined {
  const parent = name.parent;
  return parent && (parent as ts.NamedDeclaration).name === name ? functionOfDeclaration(parent) : undefined;
}

export function functionOfDeclaration(declaration: ts.Node): FunctionWithBody | undefined {
  if (isFunctionWithBody(declaration)) {
    return declaration;
  }
  if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
    const initializer = skipOuterExpressions(declaration.initializer);
    return isFunctionWithBody(initializer) ? initializer : undefined;
  }
  return undefined;
}

export function skipOuterExpressions(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The name node under which a function is declared, for finding its references. */
export function functionNameNode(fn: FunctionWithBody): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessor(fn) || ts.isSetAccessor(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    return fn.name;
  }
  if (ts.isConstructorDeclaration(fn)) {
    return fn.parent.name;
  }
  let parent = fn.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    parent = parent.parent;
  }
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && !ts.isComputedPropertyName(parent.name)) {
    return parent.name;
  }
  return undefined;
}

/** A readable name such as `Cart.total`, `loadUser` or `arrow function`. */
export function functionLabel(fn: ts.Node | undefined): string {
  if (!fn) {
    return 'module scope';
  }
  if (ts.isSourceFile(fn)) {
    return 'module scope';
  }
  const name = isFunctionWithBody(fn) ? functionNameNode(fn) : (fn as ts.NamedDeclaration).name;
  const owner = fn.parent && (ts.isClassLike(fn.parent) || ts.isObjectLiteralExpression(fn.parent)) ? fn.parent : undefined;
  const ownerName = owner && ts.isClassLike(owner) && owner.name ? `${owner.name.text}.` : '';
  if (ts.isConstructorDeclaration(fn)) {
    return `${name?.getText() ?? 'class'} constructor`;
  }
  if (name) {
    return `${ownerName}${name.getText()}`;
  }
  return ts.isArrowFunction(fn) ? 'arrow function' : 'anonymous function';
}

export function identifierAt(sourceFile: ts.SourceFile, offset: number, hint: string): ts.Identifier | ts.PrivateIdentifier {
  const identifier = findIdentifier(sourceFile, offset);
  if (!identifier) {
    throw new AnalysisError(hint);
  }
  return identifier;
}

/** The symbol a name refers to, following import aliases to the original declaration. */
export function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const parent = node.parent;
  const symbol =
    parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
  return symbol ? resolveAlias(checker, symbol) : undefined;
}

/** Whether a value of this type has a callable `then`, as awaiting it would use. */
export function isThenable(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
    return false;
  }
  if (type.isUnion()) {
    return type.types.some((t) => isThenable(checker, t));
  }
  const then = type.getProperty('then');
  if (!then) {
    return false;
  }
  const thenType = checker.getTypeOfSymbol(then);
  return thenType.getCallSignatures().length > 0;
}

export function containsNullish(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.some(containsNullish);
  }
  return !!(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
}

/** The function body a call executes, when it is part of the project. */
export function calledFunction(checker: ts.TypeChecker, call: ts.CallLikeExpression): FunctionWithBody | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration && !ts.isJSDocSignature(declaration) && !declaration.getSourceFile().isDeclarationFile) {
    return isFunctionWithBody(declaration) ? declaration : undefined;
  }
  // Calls through a variable whose type has no declaration-backed signature.
  const callee = ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : undefined;
  const symbol = callee ? symbolAt(checker, ts.isPropertyAccessExpression(callee) ? callee.name : callee) : undefined;
  return symbol?.declarations?.map(functionOfDeclaration).find((f): f is FunctionWithBody => !!f && !f.getSourceFile().isDeclarationFile);
}

/** For a name, the expression that reads or writes it: `a.b` for `b`, otherwise the name itself. */
export function accessExpression(node: ts.Node): ts.Node {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)) {
    return parent;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return parent;
  }
  return node;
}

export function skipParentheses(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isAsExpression(current.parent))) {
    current = current.parent;
  }
  return current;
}

const assignmentOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return assignmentOperators.has(kind);
}

/** The assignment, update or delete expression that writes to the expression, if any. */
export function writeOf(expression: ts.Node): ts.BinaryExpression | ts.PrefixUnaryExpression | ts.PostfixUnaryExpression | ts.DeleteExpression | ts.Node | undefined {
  const node = skipParentheses(expression);
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
    return parent;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return parent;
  }
  if (ts.isDeleteExpression(parent)) {
    return parent;
  }
  // Destructuring assignment targets: `[a, b] = …`, `({ a } = …)`, `for (a of …)`.
  if (isDestructuringTarget(node)) {
    return parent;
  }
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) {
    return parent;
  }
  return undefined;
}

function isDestructuringTarget(node: ts.Node): boolean {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (ts.isShorthandPropertyAssignment(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === current) || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) {
      current = parent.parent;
      continue;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      current = parent;
      continue;
    }
    if (!ts.isObjectLiteralExpression(current) && !ts.isArrayLiteralExpression(current)) {
      return false;
    }
    const outer = skipParentheses(current).parent;
    return ts.isBinaryExpression(outer) && outer.operatorToken.kind === ts.SyntaxKind.EqualsToken && outer.left === skipParentheses(current);
  }
}

/** Every reference to the symbol declared or used at the position, across the project. */
export function referencesAt(service: ts.LanguageService, fileName: string, position: number): ts.Node[] {
  const program = service.getProgram()!;
  const nodes: ts.Node[] = [];
  const seen = new Set<string>();
  for (const symbol of service.findReferences(fileName, position) ?? []) {
    for (const reference of symbol.references) {
      const key = `${pathKey(reference.fileName)}:${reference.textSpan.start}`;
      const sourceFile = program.getSourceFile(reference.fileName);
      if (seen.has(key) || !sourceFile || sourceFile.isDeclarationFile) {
        continue;
      }
      seen.add(key);
      nodes.push(findNode(sourceFile, reference.textSpan.start));
    }
  }
  return nodes.sort(compareNodes);
}

export function compareNodes(a: ts.Node, b: ts.Node): number {
  const fileA = a.getSourceFile().fileName;
  const fileB = b.getSourceFile().fileName;
  return fileA === fileB ? a.getStart() - b.getStart() : fileA.localeCompare(fileB);
}

export interface CallSite {
  /** The call, `new` or JSX element that invokes the function. */
  call: ts.CallExpression | ts.NewExpression | ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.Decorator | ts.TaggedTemplateExpression;
  reference: ts.Node;
}

/** Places that invoke the function, plus references that pass it around as a value. */
export function callSitesOf(service: ts.LanguageService, fn: FunctionWithBody): { calls: CallSite[]; escapes: ts.Node[] } {
  const name = functionNameNode(fn);
  const calls: CallSite[] = [];
  const escapes: ts.Node[] = [];
  if (!name) {
    return { calls, escapes };
  }
  for (const reference of referencesAt(service, name.getSourceFile().fileName, name.getStart())) {
    if (reference === name || reference.parent === name) {
      continue;
    }
    const expression = accessExpression(reference);
    const parent = skipParentheses(expression).parent;
    const callee = skipParentheses(expression);
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isTaggedTemplateExpression(parent) || ts.isDecorator(parent)) && ('tag' in parent ? parent.tag : parent.expression) === callee) {
      calls.push({ call: parent, reference });
    } else if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === callee) {
      calls.push({ call: parent, reference });
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === callee && ['call', 'apply', 'bind'].includes(parent.name.text)) {
      escapes.push(reference);
    } else if (!isImportOrExport(reference) && !isTypePosition(reference) && !(ts.isClassDeclaration(fn.parent) && reference === fn.parent.name)) {
      escapes.push(reference);
    }
  }
  return { calls, escapes };
}

export function isImportOrExport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isExportAssignment(current) || ts.isImportEqualsDeclaration(current)) {
      return !ts.isExportAssignment(current) || current.expression !== node;
    }
    if (ts.isStatement(current)) {
      return false;
    }
  }
  return false;
}

export function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) {
      return true;
    }
    if (ts.isHeritageClause(current)) {
      return current.token === ts.SyntaxKind.ImplementsKeyword;
    }
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) {
      return false;
    }
  }
  return false;
}

/** The argument a call passes for the parameter at `index`, or why there is none. */
export function argumentFor(
  call: CallSite['call'],
  parameter: ts.ParameterDeclaration,
): { expression?: ts.Expression; note?: string } {
  const fn = parameter.parent;
  const index = fn.parameters.indexOf(parameter);
  if (ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call)) {
    if (index !== 0) {
      return { note: 'JSX passes only props' };
    }
    return { note: 'JSX props' };
  }
  if (ts.isDecorator(call) || ts.isTaggedTemplateExpression(call)) {
    return { note: 'decorator or tagged template' };
  }
  const args = call.arguments ?? ts.factory.createNodeArray();
  const spreadAt = args.findIndex(ts.isSpreadElement);
  if (spreadAt >= 0 && spreadAt <= index) {
    return { note: `spread ${nodeText(args[spreadAt])}` };
  }
  if (parameter.dotDotDotToken) {
    return args.length > index ? { expression: args[index], note: 'rest' } : { note: 'no rest arguments' };
  }
  if (index >= args.length) {
    return { note: parameter.initializer ? `default ${nodeText(parameter.initializer)}` : 'omitted (undefined)' };
  }
  return { expression: args[index] };
}

/** The JSX attribute value a component call passes for a prop, by name. */
export function jsxAttribute(call: ts.JsxOpeningElement | ts.JsxSelfClosingElement, prop: string): ts.JsxAttribute | undefined {
  return call.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === prop);
}

export function nodeText(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 50 ? `${text.slice(0, 49)}…` : text;
}

export function isProjectFile(program: ts.Program, sourceFile: ts.SourceFile): boolean {
  return projectSourceFiles(program).includes(sourceFile);
}

/** Visits nodes without descending into nested functions or classes. */
export function forEachInFunction(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, function walk(child) {
    visit(child);
    if (!isFunctionWithBody(child) && !ts.isClassLike(child)) {
      ts.forEachChild(child, walk);
    }
  });
}

/** Visits nodes including nested functions; for effects that run when inner callbacks run. */
export function forEachDescendant(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, function walk(child) {
    visit(child);
    ts.forEachChild(child, walk);
  });
}

export function typeText(checker: ts.TypeChecker, type: ts.Type, enclosing?: ts.Node): string {
  return checker.typeToString(type, enclosing, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
}

/** The condition an expression is tested in, when it sits in an `if`, loop, ternary or logical operand. */
export function enclosingCondition(node: ts.Node): ts.Expression | undefined {
  let current = node;
  for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === current) {
      return parent.expression;
    }
    if (ts.isForStatement(parent) && parent.condition === current) {
      return parent.condition;
    }
    if (ts.isConditionalExpression(parent) && parent.condition === current) {
      return parent.condition;
    }
    if (ts.isSwitchStatement(parent) && parent.expression === current) {
      return parent.expression;
    }
    if (ts.isBinaryExpression(parent) && parent.left === current && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) {
      return parent;
    }
    if (ts.isStatement(parent) || isFunctionWithBody(parent)) {
      return undefined;
    }
  }
  return undefined;
}

export function sourceFileOf(program: ts.Program, fileName: string): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new AnalysisError(`${fileName} isn't in the compiler project.`, 'project');
  }
  return sourceFile;
}

const nodeLists = new WeakMap<ts.SourceFile, ts.Node[]>();

/**
 * Every node of a file in source order, collected once per file version. The pattern detectors and the quality
 * inspections, some 100 checks, walk the same file; sharing one walk is most of their speed.
 */
export function allNodes(sourceFile: ts.SourceFile): readonly ts.Node[] {
  let nodes = nodeLists.get(sourceFile);
  if (!nodes) {
    const all: ts.Node[] = [];
    const collect = (node: ts.Node): void => {
      all.push(node);
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    nodeLists.set(sourceFile, (nodes = all));
  }
  return nodes;
}
