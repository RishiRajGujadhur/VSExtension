import * as ts from 'typescript';
import { AnalysisError } from '../analysis/types';
import { resolveAlias } from '../analysis/referenceIndex';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, plural, codeContextAt, forEachReportNode } from '../structure/report';
import {
  FunctionWithBody,
  argumentFor,
  callSitesOf,
  calledFunction,
  enclosingFunction,
  forEachDescendant,
  functionLabel,
  functionOfDeclaration,
  identifierAt,
  isFunctionWithBody,
  jsxAttribute,
  nodeText,
  skipOuterExpressions,
  symbolAt,
  writeOf,
} from '../structure/util';

/** A parameter, or one property destructured from it such as `title` in `({ title })`. */
type Input = ts.ParameterDeclaration | ts.BindingElement;

function parameterOf(input: Input): ts.ParameterDeclaration {
  let current: ts.Node = input;
  while (!ts.isParameter(current)) {
    current = current.parent;
  }
  return current;
}

function inputLabel(input: Input): string {
  const fn = parameterOf(input).parent;
  return `${ts.isBindingElement(input) ? `${(input.propertyName ?? input.name).getText()} of ` : ''}${parameterOf(input).name.getText().replace(/\s+/g, ' ')} in ${functionLabel(fn)}`;
}

/** Argument Propagation Explorer: where a parameter's values originate and where they travel next. */
export class ArgumentFlow {
  private readonly checker: ts.TypeChecker;

  constructor(
    private readonly project: VirtualProject,
    private readonly builder: ReportBuilder,
    private readonly maxDepth: number,
  ) {
    this.checker = project.program().getTypeChecker();
  }

  /** The values call sites pass for the input, followed back through callers' parameters and locals. */
  origins(input: Input, depth: number, seen: Set<ts.Node>): ReportNode[] {
    const parameter = parameterOf(input);
    const fn = parameter.parent;
    if (!isFunctionWithBody(fn) || seen.has(input) || depth > this.maxDepth) {
      return depth > this.maxDepth ? [{ label: '… (depth limit)', icon: 'ellipsis' }] : [];
    }
    const nextSeen = new Set(seen).add(input);
    const { calls, escapes } = callSitesOf(this.project.service, fn);
    const rows: ReportNode[] = [];
    for (const { call } of calls) {
      const caller = functionLabel(enclosingFunction(call));
      let expression: ts.Expression | undefined;
      let note: string | undefined;
      if (ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call)) {
        const prop = ts.isBindingElement(input) ? (input.propertyName ?? input.name).getText() : undefined;
        const attribute = prop ? jsxAttribute(call, prop) : undefined;
        expression = attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : (attribute?.initializer as ts.Expression | undefined);
        note = prop ? (attribute ? (attribute.initializer ? undefined : 'true (bare attribute)') : 'omitted') : 'props object';
      } else {
        ({ expression, note } = argumentFor(call, parameter));
        if (expression && ts.isBindingElement(input)) {
          note = `property ${(input.propertyName ?? input.name).getText()} of ${nodeText(expression)}`;
          expression = undefined;
        }
      }
      if (!expression) {
        rows.push({ label: note ?? 'unknown', description: `from ${caller}`, icon: 'circle-outline', location: this.builder.at(call) });
        continue;
      }
      rows.push({ ...this.explain(expression, depth + 1, nextSeen), description: `from ${caller}` });
    }
    for (const escape of escapes) {
      rows.push({ label: `passed as a value: ${nodeText(escape.parent)}`, description: 'callers unknown', icon: 'question', tone: 'warning', location: this.builder.at(escape) });
    }
    return rows;
  }

  /** Where one argument expression's value comes from. */
  explain(expression: ts.Expression, depth: number, seen: Set<ts.Node>): ReportNode {
    const node = skipOuterExpressions(expression);
    const location = this.builder.at(node);
    if (ts.isLiteralExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) {
      return { label: nodeText(node), description: 'literal', icon: 'symbol-constant', tone: 'ok', location };
    }
    if (ts.isAwaitExpression(node)) {
      const inner = this.explain(node.expression, depth, seen);
      return { ...inner, label: `await ${inner.label}` };
    }
    if (ts.isConditionalExpression(node)) {
      return { label: nodeText(node), icon: 'git-compare', location, expanded: true, children: [this.explain(node.whenTrue, depth, seen), this.explain(node.whenFalse, depth, seen)] };
    }
    if (ts.isCallExpression(node) && !rootInput(this.checker, node)) {
      return { label: nodeText(node), description: 'return value', icon: 'symbol-method', location };
    }
    const root = rootInput(this.checker, node);
    if (root) {
      const derived = ts.isIdentifier(node) ? '' : `derived: ${nodeText(node)} · `;
      return {
        label: nodeText(node),
        description: `${derived}parameter ${inputLabel(root)}`,
        icon: 'symbol-parameter',
        location,
        expanded: true,
        children: this.origins(root, depth, seen),
      };
    }
    const local = rootLocal(this.checker, node);
    if (local) {
      const children: ReportNode[] = [];
      if (local.initializer && !seen.has(local)) {
        const nextSeen = new Set(seen).add(local);
        children.push({ ...this.explain(local.initializer, depth, nextSeen), description: `initializes ${local.name.getText()}` });
        for (const write of writesOf(this.checker, local)) {
          children.push({ ...this.explain(write.right, depth, nextSeen), description: `assigned to ${local.name.getText()}` });
        }
      }
      return { label: nodeText(node), description: `${ts.isIdentifier(node) ? '' : 'derived from '}local ${local.name.getText()}`, icon: 'symbol-variable', location, expanded: true, children };
    }
    return { label: nodeText(node), description: ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) ? 'literal' : 'expression', icon: 'symbol-misc', location };
  }

  /** Calls, JSX props, returns, stores and derived locals the input's value flows into. */
  destinations(input: Input | ts.VariableDeclaration, depth: number, seen: Set<ts.Node>): ReportNode[] {
    if (seen.has(input) || depth > this.maxDepth) {
      return depth > this.maxDepth ? [{ label: '… (depth limit)', icon: 'ellipsis' }] : [];
    }
    const nextSeen = new Set(seen).add(input);
    const scope: ts.Node | undefined = ts.isVariableDeclaration(input) ? enclosingFunction(input) ?? input.getSourceFile() : parameterOf(input).parent;
    const symbol = ts.isIdentifier(input.name) ? this.checker.getSymbolAtLocation(input.name) : undefined;
    if (!scope || !symbol) {
      return [];
    }
    const rows: ReportNode[] = [];
    forEachDescendant(scope, (node) => {
      if (!ts.isIdentifier(node) || node === input.name || symbolAt(this.checker, node) !== resolveAlias(this.checker, symbol)) {
        return;
      }
      const flow = flowingExpression(node);
      const parent = flow.parent;
      const location = this.builder.at(flow);
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(flow as ts.Expression)) {
        const callee = calledFunction(this.checker, parent);
        const index = parent.arguments.indexOf(flow as ts.Expression);
        const next = callee?.parameters[Math.min(index, callee.parameters.length - 1)];
        const label = `${nodeText(flow)} → ${nodeText(parent.expression)}()`;
        rows.push(
          next
            ? { label, description: `as ${next.name.getText().replace(/\s+/g, ' ')}`, icon: 'arrow-right', location, expanded: true, children: this.destinations(next, depth + 1, nextSeen) }
            : { label, description: 'outside the project', icon: 'arrow-right', tone: 'info', location },
        );
      } else if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
        const attribute = parent.parent;
        const element = attribute.parent.parent;
        const component = this.componentOf(element);
        const prop = attribute.name.getText();
        const target = component && propInput(component, prop);
        rows.push({
          label: `${nodeText(flow)} → <${nodeText(element.tagName)} ${prop}>`,
          description: target ? `prop of ${functionLabel(component)}` : 'intrinsic element or unknown component',
          icon: 'symbol-namespace',
          location,
          expanded: true,
          children: target ? this.destinations(target, depth + 1, nextSeen) : undefined,
        });
      } else if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === flow)) {
        rows.push({ label: `returned: ${nodeText(flow)}`, description: `to callers of ${functionLabel(enclosingFunction(flow))}`, icon: 'reply', location });
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === flow && ts.isIdentifier(parent.name)) {
        rows.push({ label: `${nodeText(flow)} → local ${parent.name.text}`, icon: 'symbol-variable', location, expanded: true, children: this.destinations(parent, depth + 1, nextSeen) });
      } else if (ts.isBinaryExpression(parent) && parent.right === flow && writeOf(parent.left) === parent) {
        rows.push({ label: `stored in ${nodeText(parent.left)}`, icon: 'database', tone: 'info', location });
      }
    });
    return rows;
  }

  private componentOf(element: ts.JsxOpeningLikeElement): FunctionWithBody | undefined {
    const symbol = symbolAt(this.checker, element.tagName);
    return symbol?.declarations?.map(functionOfDeclaration).find((f): f is FunctionWithBody => !!f);
  }
}

/** The prop's input in a component: a destructured binding, or the props parameter itself. */
function propInput(component: FunctionWithBody, prop: string): Input | undefined {
  const props = component.parameters[0];
  if (!props) {
    return undefined;
  }
  if (ts.isObjectBindingPattern(props.name)) {
    return props.name.elements.find((e) => (e.propertyName ?? e.name).getText() === prop);
  }
  return props;
}

/** Climbs from a use to the expression that carries its value on: `name.trim()` for `name`, `a.b` for `a`. */
function flowingExpression(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) {
      current = parent;
    } else if (ts.isCallExpression(parent) && parent.expression === current && ts.isPropertyAccessExpression(current)) {
      current = parent;
    } else if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTemplateSpan(parent)) {
      current = ts.isTemplateSpan(parent) ? parent.parent : parent;
    } else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) {
      current = parent;
    } else {
      return current;
    }
  }
}

/** The parameter (or destructured parameter property) an expression is read from, if any. */
function rootInput(checker: ts.TypeChecker, expression: ts.Node): Input | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) {
    return undefined;
  }
  const declaration = symbolAt(checker, current)?.valueDeclaration;
  if (declaration && (ts.isParameter(declaration) || (ts.isBindingElement(declaration) && isInParameter(declaration)))) {
    return declaration as Input;
  }
  return undefined;
}

function rootLocal(checker: ts.TypeChecker, expression: ts.Node): ts.VariableDeclaration | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  const declaration = ts.isIdentifier(current) ? symbolAt(checker, current)?.valueDeclaration : undefined;
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : undefined;
}

function isInParameter(node: ts.Node): boolean {
  for (let current: ts.Node = node; current; current = current.parent) {
    if (ts.isParameter(current)) {
      return true;
    }
    if (!ts.isBindingElement(current) && !ts.isObjectBindingPattern(current) && !ts.isArrayBindingPattern(current)) {
      return false;
    }
  }
  return false;
}

function writesOf(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): ts.BinaryExpression[] {
  const scope = enclosingFunction(declaration) ?? declaration.getSourceFile();
  const name = declaration.name.getText();
  const writes: ts.BinaryExpression[] = [];
  forEachDescendant(scope, (node) => {
    // By symbol, not by name: a same-named variable in a nested function is a different one.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name && symbolAt(checker, node.left)?.valueDeclaration === declaration) {
      writes.push(node);
    }
  });
  return writes;
}

/** The input at the cursor: a parameter, a destructured prop, or the parameter an argument is passed to. */
function inputAt(project: VirtualProject, fileName: string, offset: number): Input {
  const checker = project.program().getTypeChecker();
  const identifier = identifierAt(project.sourceFile(fileName), offset, 'Place the cursor on a parameter, or on an argument in a call.');
  const declaration = symbolAt(checker, identifier)?.valueDeclaration;
  if (declaration && (ts.isParameter(declaration) || (ts.isBindingElement(declaration) && isInParameter(declaration)))) {
    return declaration as Input;
  }
  // An argument at a call site: explore the callee's parameter.
  const argument = flowingExpression(identifier);
  const call = argument.parent;
  if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(argument as ts.Expression)) {
    const callee = calledFunction(checker, call);
    const parameter = callee?.parameters[Math.min(call.arguments.indexOf(argument as ts.Expression), callee.parameters.length - 1)];
    if (parameter) {
      return parameter;
    }
  }
  throw new AnalysisError(`'${identifier.text}' is not a parameter or an argument passed to a project function.`);
}

export function argumentFlowReport(project: VirtualProject, fileName: string, offset: number, maxDepth = 6): Report {
  const input = inputAt(project, fileName, offset);
  const builder = new ReportBuilder('argumentFlow', `Propagation of ${inputLabel(input)}`);
  const flow = new ArgumentFlow(project, builder, maxDepth);
  const origins = flow.origins(input, 0, new Set());
  const destinations = flow.destinations(input, 0, new Set());
  const roots: ReportNode[] = [
    { label: inputLabel(input), icon: 'symbol-parameter', tone: 'ok', location: builder.at(input.name) },
    { label: 'Where values come from', description: plural(origins.length, 'call site'), icon: 'call-incoming', expanded: true, children: origins.length ? origins : [{ label: 'no call sites in the project', icon: 'dash' }] },
    { label: 'Where the value goes', description: plural(destinations.length, 'destination'), icon: 'call-outgoing', expanded: true, children: destinations.length ? destinations : [{ label: 'not passed on, returned or stored', icon: 'dash' }] },
  ];
  // Every row shows its line of code on hover; values often come from far away.
  const program = project.program();
  forEachReportNode(roots, (node) => {
    const sourceFile = node.location && !node.tooltip ? program.getSourceFile(node.location.file) : undefined;
    if (sourceFile) {
      node.tooltip = codeContextAt(sourceFile, sourceFile.getPositionOfLineAndCharacter(node.location!.line, node.location!.character), 0);
    }
  });
  return builder.finish(roots, `${plural(origins.length, 'call site')}, ${plural(destinations.length, 'hand-off')}`);
}
