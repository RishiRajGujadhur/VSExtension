import * as ts from 'typescript';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, forEachReportNode, nodeSnippet, plural, withPlace } from '../structure/report';
import {
  FunctionWithBody,
  accessExpression,
  argumentFor,
  callSitesOf,
  calledFunction,
  containsNullish,
  enclosingFunction,
  forEachInFunction,
  functionLabel,
  identifierAt,
  isFunctionWithBody,
  nodeText,
  referencesAt,
  skipOuterExpressions,
  symbolAt,
  typeText,
  writeOf,
} from '../structure/util';

const maxDepth = 5;

/** Explains which definitions, assignments, returns and call sites can make a value null or undefined. */
export class NullabilityExplorer {
  private readonly checker: ts.TypeChecker;
  private readonly visited = new Set<ts.Node>();

  constructor(
    private readonly project: VirtualProject,
    private readonly builder: ReportBuilder,
  ) {
    this.checker = project.program().getTypeChecker();
  }

  /** The nullable sources of an expression, as a tree of explanations. */
  sources(expression: ts.Node, depth = 0): ReportNode[] {
    const node = skipOuterExpressions(expression as ts.Expression);
    if (depth > maxDepth || this.visited.has(node)) {
      return [];
    }
    this.visited.add(node);
    if (node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined') || ts.isVoidExpression(node)) {
      return [this.leaf(`${node.getText()} literal`, node, 'error')];
    }
    if (ts.isConditionalExpression(node)) {
      return [node.whenTrue, node.whenFalse].filter((b) => this.nullable(b)).flatMap((b) => this.sources(b, depth + 1));
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
        return this.nullable(node.right) ? this.sources(node.right, depth + 1) : [];
      }
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return [this.leaf(`${nodeText(node.left)} is falsy`, node.left, 'warning', 'the && expression yields the left value')];
      }
      if (kind === ts.SyntaxKind.EqualsToken) {
        return this.sources(node.right, depth + 1);
      }
    }
    if (ts.isAwaitExpression(node)) {
      return this.sources(node.expression, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return this.accessSources(node, depth);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return this.callSources(node, depth);
    }
    if (ts.isIdentifier(node)) {
      return this.identifierSources(node, depth);
    }
    return this.nullable(node) ? [this.leaf(`${nodeText(node)}: ${this.typeOf(node)}`, node, 'warning')] : [];
  }

  private identifierSources(identifier: ts.Identifier, depth: number): ReportNode[] {
    const symbol = symbolAt(this.checker, identifier);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || declaration.getSourceFile().isDeclarationFile) {
      return [this.leaf(`${identifier.text}: ${this.typeOf(identifier)}`, identifier, 'warning', 'declared outside the project')];
    }
    if (ts.isParameter(declaration)) {
      return this.parameterSources(declaration, depth);
    }
    if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
      return this.propertySources(declaration, depth);
    }
    const results: ReportNode[] = [];
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.type && containsNullish(this.checker.getTypeFromTypeNode(declaration.type))) {
        results.push(this.leaf(`declared as ${declaration.type.getText()}`, declaration.type, 'info'));
      }
      if (!declaration.initializer && !ts.isForOfStatement(declaration.parent.parent) && !ts.isForInStatement(declaration.parent.parent)) {
        results.push(this.leaf(`${identifier.text} is declared without a value`, declaration, 'error', 'undefined until assigned'));
      } else if (declaration.initializer && this.nullable(declaration.initializer)) {
        results.push(this.group(`initialized to ${nodeText(declaration.initializer)}`, declaration.initializer, this.sources(declaration.initializer, depth + 1)));
      }
    } else if (ts.isBindingElement(declaration)) {
      results.push(this.leaf(`destructured: ${this.typeOf(declaration.name)}`, declaration, 'warning', declaration.initializer ? `default ${nodeText(declaration.initializer)}` : undefined));
    }
    results.push(...this.assignmentSources(declaration, depth));
    return results;
  }

  private parameterSources(parameter: ts.ParameterDeclaration, depth: number): ReportNode[] {
    const results: ReportNode[] = [];
    if (parameter.questionToken) {
      results.push(this.leaf(`${parameter.name.getText()} is an optional parameter`, parameter, 'warning', 'callers may omit it'));
    }
    if (parameter.type && containsNullish(this.checker.getTypeFromTypeNode(parameter.type))) {
      results.push(this.leaf(`declared as ${parameter.type.getText()}`, parameter.type, 'info'));
    }
    const fn = parameter.parent;
    if (isFunctionWithBody(fn) && !parameter.initializer) {
      for (const { call } of callSitesOf(this.project.service, fn).calls) {
        const { expression, note } = argumentFor(call, parameter);
        const where = `${functionLabel(enclosingFunction(call))}`;
        if (!expression && note?.startsWith('omitted')) {
          results.push(this.leaf(`${where} omits the argument`, call, 'error', nodeSnippet(call, 40)));
        } else if (expression && this.nullable(expression)) {
          results.push(this.group(`${where} passes ${nodeText(expression)}`, expression, this.sources(expression, depth + 1), 'call site'));
        }
      }
    }
    results.push(...this.assignmentSources(parameter, depth));
    return results;
  }

  private propertySources(declaration: ts.Declaration, depth: number): ReportNode[] {
    const results: ReportNode[] = [];
    const named = declaration as ts.PropertyDeclaration;
    if (named.questionToken) {
      results.push(this.leaf(`${named.name.getText()} is an optional property`, declaration, 'warning'));
    }
    if (named.type && containsNullish(this.checker.getTypeFromTypeNode(named.type))) {
      results.push(this.leaf(`declared as ${named.type.getText()}`, named.type, 'info'));
    }
    if (ts.isPropertyDeclaration(declaration) && !declaration.initializer && !declaration.questionToken && !declaration.exclamationToken && !named.type) {
      results.push(this.leaf('no initializer', declaration, 'warning'));
    }
    if ((ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer && this.nullable(declaration.initializer)) {
      results.push(this.group(`initialized to ${nodeText(declaration.initializer)}`, declaration.initializer, this.sources(declaration.initializer, depth + 1)));
    }
    results.push(...this.assignmentSources(declaration, depth));
    return results;
  }

  /** Assignments anywhere in the project that store a possibly-null value. */
  private assignmentSources(declaration: ts.Declaration, depth: number): ReportNode[] {
    const name = (declaration as ts.NamedDeclaration).name;
    if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) {
      return [];
    }
    const results: ReportNode[] = [];
    for (const reference of referencesAt(this.project.service, declaration.getSourceFile().fileName, name.getStart())) {
      const write = writeOf(accessExpression(reference));
      if (write && ts.isBinaryExpression(write) && write.operatorToken.kind === ts.SyntaxKind.EqualsToken && this.nullable(write.right)) {
        results.push(this.group(`assigned ${nodeText(write.right)} in ${functionLabel(enclosingFunction(write))}`, write, this.sources(write.right, depth + 1)));
      }
    }
    return results;
  }

  private accessSources(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): ReportNode[] {
    const results: ReportNode[] = [];
    if (node.questionDotToken || hasOptionalChainAbove(node)) {
      results.push(this.group(`optional chaining: undefined when ${nodeText(node.expression)} is null or undefined`, node.expression, this.nullable(node.expression) ? this.sources(node.expression, depth + 1) : []));
    }
    if (ts.isElementAccessExpression(node)) {
      if (this.project.program().getCompilerOptions().noUncheckedIndexedAccess) {
        results.push(this.leaf(`index lookup ${nodeText(node)} may be missing`, node, 'warning', 'noUncheckedIndexedAccess'));
      }
      return results;
    }
    const symbol = this.checker.getSymbolAtLocation(node.name);
    const declaration = symbol?.valueDeclaration;
    if (declaration && !declaration.getSourceFile().isDeclarationFile) {
      results.push(...this.propertySources(declaration, depth));
    } else if (this.nullable(node) && !node.questionDotToken) {
      results.push(this.leaf(`${nodeText(node)}: ${this.typeOf(node)}`, node, 'warning', 'library type'));
    }
    return results;
  }

  private callSources(call: ts.CallExpression | ts.NewExpression, depth: number): ReportNode[] {
    const fn = calledFunction(this.checker, call);
    if (!fn) {
      const signature = this.checker.getResolvedSignature(call);
      const returns = signature ? typeText(this.checker, signature.getReturnType(), call) : this.typeOf(call);
      return [this.leaf(`${nodeText(call.expression)}() returns ${returns}`, call, 'warning', libraryReason(this.checker, call) ?? 'declared outside the project')];
    }
    return this.returnSources(fn, depth);
  }

  /** The returns of a function that give null or undefined, including falling off its end. */
  returnSources(fn: FunctionWithBody, depth = 0): ReportNode[] {
    const results: ReportNode[] = [];
    if (fn.type && containsNullish(this.checker.getTypeFromTypeNode(fn.type))) {
      results.push(this.leaf(`${functionLabel(fn)} is declared to return ${fn.type.getText()}`, fn.type, 'info'));
    }
    for (const returned of returnsOf(fn)) {
      if (!returned.expression) {
        results.push(this.leaf(`${functionLabel(fn)} returns without a value`, returned, 'error'));
      } else if (this.nullable(returned.expression)) {
        results.push(this.group(`${functionLabel(fn)} returns ${nodeText(returned.expression)}`, returned, this.sources(returned.expression, depth + 1)));
      }
    }
    if (ts.isBlock(fn.body!) && canFallOffEnd(fn.body)) {
      results.push(this.leaf(`${functionLabel(fn)} can reach its end without returning`, fn.body.getLastToken() ?? fn.body, 'error', 'returns undefined'));
    }
    return results;
  }

  nullable(node: ts.Node): boolean {
    try {
      return containsNullish(this.checker.getTypeAtLocation(node));
    } catch {
      return false;
    }
  }

  /** "null", "undefined" or "null or undefined": which of the two the value's type allows. */
  nullishWord(node: ts.Node): string {
    let type: ts.Type;
    try {
      type = this.checker.getTypeAtLocation(node);
    } catch {
      return 'null or undefined';
    }
    const parts = type.isUnion() ? type.types : [type];
    const hasNull = parts.some((t) => t.flags & ts.TypeFlags.Null);
    const hasUndefined = parts.some((t) => t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    return hasNull && !hasUndefined ? 'null' : hasUndefined && !hasNull ? 'undefined' : 'null or undefined';
  }

  typeOf(node: ts.Node): string {
    return typeText(this.checker, this.checker.getTypeAtLocation(node), node);
  }

  private leaf(label: string, node: ts.Node, tone: ReportNode['tone'], description?: string): ReportNode {
    return { label, description: withPlace(node, description), icon: tone === 'error' ? 'circle-slash' : tone === 'info' ? 'symbol-key' : 'warning', tone, location: this.builder.at(node) };
  }

  private group(label: string, node: ts.Node, children: ReportNode[], description?: string): ReportNode {
    return { label, description: withPlace(node, description), icon: 'arrow-small-left', tone: 'warning', location: this.builder.at(node), children: children.length ? children : undefined, expanded: true };
  }
}

function hasOptionalChainAbove(node: ts.Node): boolean {
  return ts.isOptionalChain(node) && !!(node.flags & ts.NodeFlags.OptionalChain);
}

function returnsOf(fn: FunctionWithBody): ts.ReturnStatement[] {
  if (!ts.isBlock(fn.body!)) {
    return [];
  }
  const returns: ts.ReturnStatement[] = [];
  forEachInFunction(fn.body, (node) => {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
    }
  });
  return returns;
}

/** Whether control can reach the closing brace, roughly: the last statement is not a return or throw. */
function canFallOffEnd(body: ts.Block): boolean {
  const ends = (statement: ts.Statement | undefined): boolean => {
    if (!statement) {
      return false;
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return true;
    }
    if (ts.isBlock(statement)) {
      return ends(statement.statements[statement.statements.length - 1]);
    }
    if (ts.isIfStatement(statement)) {
      return !!statement.elseStatement && ends(statement.thenStatement) && ends(statement.elseStatement);
    }
    if (ts.isTryStatement(statement)) {
      return ends(statement.tryBlock) && (!statement.catchClause || ends(statement.catchClause.block));
    }
    if (ts.isSwitchStatement(statement)) {
      const clauses = statement.caseBlock.clauses;
      return clauses.some(ts.isDefaultClause) && clauses.every((c) => c.statements.length === 0 || ends(c.statements[c.statements.length - 1]));
    }
    if (ts.isWhileStatement(statement) || ts.isForStatement(statement)) {
      // `while (true)` without a break never falls through.
      const condition = ts.isWhileStatement(statement) ? statement.expression : statement.condition;
      return !condition || condition.kind === ts.SyntaxKind.TrueKeyword;
    }
    return false;
  };
  return body.statements.length > 0 && !ends(body.statements[body.statements.length - 1]) && returnsValue(body);
}

function returnsValue(body: ts.Block): boolean {
  let found = false;
  forEachInFunction(body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      found = true;
    }
  });
  return found;
}

/** Conditions before the expression that rule out null, explaining why it is safe here. */
function guardsBefore(expression: ts.Node, name: string): ts.Node[] {
  const guards: ts.Node[] = [];
  const mentions = (node: ts.Node) => new RegExp(`(^|[^\\w$.])${name.replace(/[$.]/g, '\\$&')}([^\\w$]|$)`).test(node.getText());
  let current = expression;
  for (let parent = expression.parent; parent && !ts.isSourceFile(parent); current = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === current && mentions(parent.expression)) {
      guards.push(parent.expression);
    }
    if (ts.isConditionalExpression(parent) && parent.whenTrue === current && mentions(parent.condition)) {
      guards.push(parent.condition);
    }
    if (ts.isBinaryExpression(parent) && parent.right === current && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && mentions(parent.left)) {
      guards.push(parent.left);
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      // Early exits: `if (!user) return;` before the expression.
      for (const statement of parent.statements) {
        if (statement === current) {
          break;
        }
        if (ts.isIfStatement(statement) && mentions(statement.expression) && exits(statement.thenStatement)) {
          guards.push(statement.expression);
        }
      }
    }
    if (isFunctionWithBody(parent)) {
      break;
    }
  }
  return guards;
}

function exits(statement: ts.Statement): boolean {
  const last = ts.isBlock(statement) ? statement.statements[statement.statements.length - 1] : statement;
  return !!last && (ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isContinueStatement(last) || ts.isBreakStatement(last));
}

const maxUses = 50;

/** Every read of a variable, parameter or property, and whether its type still includes null or undefined there. */
function usesOf(project: VirtualProject, explorer: NullabilityExplorer, builder: ReportBuilder, expression: ts.Node): ReportNode[] {
  const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  if (!ts.isIdentifier(name)) {
    return [];
  }
  const uses: ReportNode[] = [];
  for (const reference of referencesAt(project.service, name.getSourceFile().fileName, name.getStart())) {
    const access = accessExpression(reference);
    const parent = reference.parent;
    if ((parent as ts.NamedDeclaration).name === reference || writeOf(access) || uses.length >= maxUses) {
      continue;
    }
    const check = isNullCheck(access as ts.Expression);
    const nullable = !check && explorer.nullable(access);
    const line = reference.getSourceFile().getLineAndCharacterOfPosition(reference.getStart()).line + 1;
    // The expression around the use; for `${x}` in a template, the whole template.
    const context = ts.isTemplateSpan(access.parent) ? access.parent.parent : access.parent;
    uses.push({
      label: nodeSnippet(context, 50),
      description: `line ${line} · ${check ? 'check' : nullable ? `may be ${explorer.nullishWord(access)}` : 'safe'}`,
      icon: check ? 'filter' : nullable ? 'warning' : 'pass',
      tone: check ? undefined : nullable ? 'warning' : 'ok',
      role: 'read',
      location: builder.at(reference),
      // A use that may be null usually has a compiler error there, with fixes such as optional chaining.
      action: nullable && !check ? { kind: 'quickFix' } : undefined,
    });
  }
  return uses;
}

/** Whether the use tests for null rather than relying on a value: `!x`, `x ?? d`, `x?.y`, `x === null`, `typeof x`, `if (x)`. */
function isNullCheck(use: ts.Expression): boolean {
  const parent = use.parent;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isTypeOfExpression(parent) || (ts.isPropertyAccessExpression(parent) && parent.expression === use && parent.questionDotToken)) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    const other = parent.left === use ? parent.right : parent.left;
    const nullish = other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === 'undefined');
    if ((kind === ts.SyntaxKind.QuestionQuestionToken && parent.left === use) || (nullish && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(kind))) {
      return true;
    }
  }
  return ((ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === use) || (ts.isConditionalExpression(parent) && parent.condition === use);
}

/** Nullability of what a function returns, for the cursor on its name. */
function returnsReport(project: VirtualProject, fn: FunctionWithBody): Report {
  const name = functionLabel(fn);
  const builder = new ReportBuilder('nullability', `Nullability of ${name}()`);
  const explorer = new NullabilityExplorer(project, builder);
  const checker = project.program().getTypeChecker();
  const signature = checker.getSignatureFromDeclaration(fn);
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  // The awaited type for async functions: `Promise<T | undefined>` resolves to a nullable value.
  const resolved = returnType && (checker.getAwaitedType(returnType) ?? returnType);
  const nullable = !!resolved && containsNullish(resolved);
  const sources = explorer.returnSources(fn);
  const roots: ReportNode[] = [
    {
      label: `${name}() returns ${resolved ? typeText(checker, resolved, fn) : 'unknown'}`,
      description: nullable ? 'may return null or undefined' : 'never returns null or undefined',
      icon: nullable ? 'warning' : 'pass',
      tone: nullable ? 'warning' : 'ok',
      location: builder.at((fn as ts.FunctionDeclaration).name ?? fn),
    },
  ];
  if (sources.length > 0) {
    roots.push({ label: 'Returns that produce null or undefined', icon: 'git-merge', expanded: true, children: sources });
  }
  return builder.finish(roots, nullable ? plural(sources.filter((s) => s.tone !== 'info').length, 'nullable return') : 'safe');
}

/** Nullability Path Explorer for the expression at the cursor. */
const libraryReasons: { receiver: string; method: string; reason: string }[] = [];

/** The receiver of a method call in the terms of libraryReasons: Array for arrays, else the type's name. */
function receiverNames(checker: ts.TypeChecker, receiver: ts.Expression): string[] {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  const names = [checker.isArrayType(type) || checker.isTupleType(type) ? 'Array' : '', type.flags & ts.TypeFlags.StringLike ? 'String' : '', type.getSymbol()?.getName() ?? ''];
  return names.filter(Boolean);
}

libraryReasons.push({ receiver: 'Array', method: 'findLast', reason: 'undefined when nothing matches' });

libraryReasons.push({ receiver: 'Array', method: 'pop', reason: 'undefined when the array is empty' });
libraryReasons.push({ receiver: 'Array', method: 'shift', reason: 'undefined when the array is empty' });

libraryReasons.push({ receiver: 'Array', method: 'at', reason: 'undefined when the index is past either end' });
libraryReasons.push({ receiver: 'String', method: 'at', reason: 'undefined when the index is past either end' });

libraryReasons.push({ receiver: 'Map', method: 'get', reason: 'undefined when the key is missing' });
libraryReasons.push({ receiver: 'WeakMap', method: 'get', reason: 'undefined when the key is missing' });
libraryReasons.push({ receiver: 'ReadonlyMap', method: 'get', reason: 'undefined when the key is missing' });

libraryReasons.push({ receiver: 'Document', method: 'querySelector', reason: 'null when no element matches' });
libraryReasons.push({ receiver: 'Element', method: 'querySelector', reason: 'null when no element matches' });
libraryReasons.push({ receiver: 'HTMLElement', method: 'querySelector', reason: 'null when no element matches' });
libraryReasons.push({ receiver: 'Document', method: 'getElementById', reason: 'null when no element has that id' });

libraryReasons.push({ receiver: 'Element', method: 'closest', reason: 'null when no ancestor matches' });
libraryReasons.push({ receiver: 'HTMLElement', method: 'closest', reason: 'null when no ancestor matches' });
libraryReasons.push({ receiver: 'Element', method: 'getAttribute', reason: 'null when the attribute is not set' });
libraryReasons.push({ receiver: 'HTMLElement', method: 'getAttribute', reason: 'null when the attribute is not set' });

libraryReasons.push({ receiver: 'Storage', method: 'getItem', reason: 'null when nothing is stored under the key' });

libraryReasons.push({ receiver: 'RegExp', method: 'exec', reason: 'null when the pattern does not match' });
libraryReasons.push({ receiver: 'String', method: 'match', reason: 'null when the pattern does not match' });

libraryReasons.push({ receiver: 'URLSearchParams', method: 'get', reason: 'null when the parameter is missing' });
libraryReasons.push({ receiver: 'Headers', method: 'get', reason: 'null when the header is missing' });
libraryReasons.push({ receiver: 'FormData', method: 'get', reason: 'null when the field is missing' });

libraryReasons.push({ receiver: 'HTMLCanvasElement', method: 'getContext', reason: 'null when the context type is not supported' });
libraryReasons.push({ receiver: 'CSSStyleDeclaration', method: 'getPropertyValue', reason: 'empty when the property is not set' });
libraryReasons.push({ receiver: 'DOMTokenList', method: 'item', reason: 'null when the index is out of range' });
libraryReasons.push({ receiver: 'NodeList', method: 'item', reason: 'null when the index is out of range' });

/** Why a library call can give null or undefined, such as Array.find when nothing matches. */
export function libraryReason(checker: ts.TypeChecker, call: ts.Expression): string | undefined {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  const names = receiverNames(checker, call.expression.expression);
  return libraryReasons.find((r) => r.method === method && names.includes(r.receiver))?.reason;
}

libraryReasons.push({ receiver: 'Array', method: 'find', reason: 'undefined when nothing matches' });

export function nullabilityReport(project: VirtualProject, fileName: string, offset: number): Report {
  const sourceFile = project.sourceFile(fileName);
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a variable, property access or call.');
  const declared = identifier.parent;
  if (isFunctionWithBody(declared) && (declared as ts.FunctionDeclaration).name === identifier) {
    return returnsReport(project, declared);
  }
  let expression: ts.Node = accessExpression(identifier);
  const parent = expression.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expression) {
    expression = parent;
  }
  const text = nodeText(expression);
  const builder = new ReportBuilder('nullability', `Nullability of ${text}`);
  const explorer = new NullabilityExplorer(project, builder);
  const options = project.program().getCompilerOptions();
  if (!options.strict && !options.strictNullChecks) {
    builder.warnings.push('strictNullChecks is off, so types do not record null or undefined; only literal sources are shown.');
  }
  const type = explorer.typeOf(expression);
  const nullableHere = explorer.nullable(expression);
  const which = explorer.nullishWord(expression);
  const roots: ReportNode[] = [
    {
      label: `${text}: ${type}`,
      description: nullableHere ? `may be ${which} here` : 'never null or undefined here',
      icon: nullableHere ? 'warning' : 'pass',
      tone: nullableHere ? 'warning' : 'ok',
      location: builder.at(expression),
    },
  ];
  const sources = explorer.sources(expression);
  if (sources.length > 0) {
    roots.push({ label: nullableHere ? `Paths that produce ${which}` : 'Possible null sources before narrowing', icon: 'git-merge', expanded: true, children: sources });
  }
  if (!nullableHere) {
    const guards = guardsBefore(expression, ts.isIdentifier(expression) ? expression.text : expression.getText().split(/[.(?[]/)[0]);
    if (guards.length > 0) {
      roots.push({
        label: 'Ruled out by',
        icon: 'shield',
        expanded: true,
        children: guards.map((g) => ({ label: nodeText(g), icon: 'filter', tone: 'ok' as const, location: builder.at(g) })),
      });
    }
  }
  const uses = usesOf(project, explorer, builder, expression);
  if (uses.length > 0) {
    const count = (tone: ReportNode['tone']) => uses.filter((u) => u.tone === tone).length;
    const unsafe = count('warning');
    roots.push({
      label: 'Uses',
      description: [`${count('ok')} safe`, plural(uses.length - unsafe - count('ok'), 'check'), `${unsafe} may be ${which}`].join(', '),
      icon: 'references',
      children: uses,
      expanded: unsafe > 0,
    });
  }
  // Count where the paths end (a literal, an omitted argument, a library call), not the branches leading there.
  let origins = 0;
  forEachReportNode(sources, (node) => {
    if (!node.children?.length && node.tone !== 'info') {
      origins++;
    }
  });
  return builder.finish(roots, nullableHere ? plural(origins, 'source') : 'safe here');
}
