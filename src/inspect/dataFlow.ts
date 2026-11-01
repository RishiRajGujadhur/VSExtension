import * as ts from 'typescript';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, nodeSnippet, plural } from '../structure/report';
import {
  accessExpression,
  callSitesOf,
  argumentFor,
  enclosingCondition,
  enclosingFunction,
  functionLabel,
  identifierAt,
  isImportOrExport,
  nodeText,
  referencesAt,
  skipParentheses,
  symbolAt,
  typeText,
  writeOf,
  calledFunction,
  isFunctionWithBody,
  jsxAttribute,
} from '../structure/util';

export type FlowKind = 'declaration' | 'write' | 'update' | 'mutation' | 'condition' | 'argument' | 'return' | 'call' | 'read' | 'import';

export interface FlowStep {
  kind: FlowKind;
  node: ts.Node;
  /** What happens to the value, such as `= price * 2` or `checked: if (price > 0)`. */
  label: string;
  /** The value's type at this point, after narrowing. */
  type?: string;
}

const mutatingMethods = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);

/** Every place a variable, parameter or property is defined, changed, tested, passed on or read, in source order. */
export function dataFlowSteps(project: VirtualProject, fileName: string, offset: number): { name: string; steps: FlowStep[]; declaration?: ts.Declaration } {
  const sourceFile = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a variable, parameter or property.');
  const symbol = symbolAt(checker, identifier);
  if (!symbol || !(symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property | ts.SymbolFlags.Accessor))) {
    throw new AnalysisError(`'${identifier.text}' is not a variable, parameter or property, so it has no data flow to show.`);
  }
  const steps: FlowStep[] = [];
  for (const reference of referencesAt(project.service, fileName, identifier.getStart())) {
    if (ts.isIdentifier(reference) || ts.isPrivateIdentifier(reference) || ts.isStringLiteral(reference)) {
      steps.push(classify(reference, checker));
    }
  }
  return { name: identifier.text, steps, declaration: symbol.valueDeclaration };
}

function classify(node: ts.Node, checker: ts.TypeChecker): FlowStep {
  const step = (kind: FlowKind, label: string, typed: ts.Node | undefined = node): FlowStep => ({
    kind,
    node,
    label,
    type: typed && !isImportOrExport(node) ? safeType(checker, typed) : undefined,
  });
  const parent = node.parent;
  if (isImportOrExport(node)) {
    return { kind: 'import', node, label: ts.isImportSpecifier(parent) || ts.isImportClause(parent) ? 'imported' : 're-exported' };
  }
  if ((parent as ts.NamedDeclaration).name === node) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) {
      const initializer = (parent as ts.VariableDeclaration).initializer;
      if (ts.isParameter(parent)) {
        return step('declaration', initializer ? `parameter, default ${nodeText(initializer)}` : parent.questionToken ? 'optional parameter' : 'parameter');
      }
      if (ts.isBindingElement(parent)) {
        return step('declaration', `destructured${initializer ? `, default ${nodeText(initializer)}` : ''}`);
      }
      if (ts.isVariableDeclaration(parent) && ts.isForOfStatement(parent.parent.parent)) {
        return step('write', `each item of ${nodeText(parent.parent.parent.expression)}`);
      }
      return step('declaration', initializer ? `= ${nodeText(initializer)}` : 'declared without a value');
    }
    return step('declaration', 'declared');
  }
  if (ts.isShorthandPropertyAssignment(parent)) {
    return step('read', `object property ${nodeSnippet(parent.parent, 40)}`);
  }

  const expression = accessExpression(node);
  const write = writeOf(expression);
  if (write) {
    if (ts.isBinaryExpression(write)) {
      const operator = write.operatorToken.getText();
      return step(operator === '=' ? 'write' : 'update', `${operator} ${nodeText(write.right)}`, write.right);
    }
    if (ts.isPrefixUnaryExpression(write) || ts.isPostfixUnaryExpression(write)) {
      return step('update', nodeText(write));
    }
    if (ts.isDeleteExpression(write)) {
      return step('write', 'deleted', undefined);
    }
    return step('write', `assigned by ${nodeSnippet(write, 40)}`);
  }

  const outer = skipParentheses(expression);
  const outerParent = outer.parent;
  // Changes made through the value: `items.push(x)`, `user.name = …`.
  if (ts.isPropertyAccessExpression(outerParent) && outerParent.expression === outer) {
    const call = outerParent.parent;
    if (ts.isCallExpression(call) && call.expression === outerParent && mutatingMethods.has(outerParent.name.text)) {
      return step('mutation', `mutated: .${outerParent.name.text}(${call.arguments.map(nodeText).join(', ')})`);
    }
    const nested = writeOf(outerParent);
    if (nested && ts.isBinaryExpression(nested)) {
      return step('mutation', `.${outerParent.name.text} ${nested.operatorToken.getText()} ${nodeText(nested.right)}`);
    }
  }
  if ((ts.isCallExpression(outerParent) || ts.isNewExpression(outerParent)) && outerParent.arguments?.includes(outer as ts.Expression)) {
    const index = outerParent.arguments.indexOf(outer as ts.Expression);
    const callee = calledFunction(checker, outerParent);
    const parameter = callee?.parameters[Math.min(index, callee.parameters.length - 1)];
    const target = parameter ? ` as ${parameter.name.getText()}` : '';
    return step('argument', `→ ${nodeText(outerParent.expression)}(…)${target}`);
  }
  if ((ts.isCallExpression(outerParent) || ts.isNewExpression(outerParent)) && outerParent.expression === outer) {
    return step('call', `called: ${nodeSnippet(outerParent, 50)}`);
  }
  if (ts.isJsxExpression(outerParent) && ts.isJsxAttribute(outerParent.parent)) {
    return step('argument', `→ prop ${outerParent.parent.name.getText()} of <${nodeText(outerParent.parent.parent.parent.tagName)}>`);
  }
  if (ts.isReturnStatement(outerParent) || (ts.isArrowFunction(outerParent) && outerParent.body === outer)) {
    return step('return', `returned from ${functionLabel(enclosingFunction(outer))}`);
  }
  const condition = enclosingCondition(outer);
  if (condition) {
    const statement = condition.parent;
    const keyword = ts.isIfStatement(statement) ? 'if' : ts.isWhileStatement(statement) ? 'while' : ts.isSwitchStatement(statement) ? 'switch' : '';
    return step('condition', `checked: ${keyword ? `${keyword} (${nodeText(condition)})` : nodeText(condition)}`);
  }
  if (ts.isVariableDeclaration(outerParent) && outerParent.initializer === outer) {
    return step('read', `copied to ${outerParent.name.getText()}`);
  }
  return step('read', `read: ${nodeSnippet(outerParent, 50)}`);
}

function safeType(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  try {
    return typeText(checker, checker.getTypeAtLocation(node), node);
  } catch {
    return undefined;
  }
}

const icons: Record<FlowKind, string> = {
  declaration: 'symbol-variable',
  write: 'edit',
  update: 'diff-modified',
  mutation: 'warning',
  condition: 'filter',
  argument: 'arrow-right',
  return: 'reply',
  call: 'symbol-method',
  read: 'eye',
  import: 'package',
};

/** Data Flow Path Explorer: the variable's life grouped by the function each step happens in. */
export function dataFlowReport(project: VirtualProject, fileName: string, offset: number): Report {
  const { name, steps, declaration } = dataFlowSteps(project, fileName, offset);
  const builder = new ReportBuilder('dataFlow', `Data flow of ${name}`);
  const groups = new Map<ts.Node | ts.SourceFile, FlowStep[]>();
  for (const step of steps) {
    const scope = enclosingFunction(step.node) ?? step.node.getSourceFile();
    groups.set(scope, [...(groups.get(scope) ?? []), step]);
  }
  // Types are shown where they differ from the declared one, so narrowing and widening stand out.
  const declared = steps.find((s) => s.kind === 'declaration')?.type;
  const shownType = (s: FlowStep) => (s.kind === 'declaration' || s.type !== declared ? s.type : undefined);
  const atCursor = (s: FlowStep) => s.node.getSourceFile().fileName === project.sourceFile(fileName).fileName && s.node.getStart() <= offset && offset <= s.node.getEnd();
  const roots: ReportNode[] = [];
  for (const [scope, scoped] of groups) {
    roots.push({
      label: ts.isSourceFile(scope) ? `${baseName(scope.fileName)} (module scope)` : functionLabel(scope),
      description: `${baseName(scope.getSourceFile().fileName)} · ${plural(scoped.length, 'step')}`,
      icon: ts.isSourceFile(scope) ? 'file-code' : 'symbol-function',
      location: builder.at(ts.isSourceFile(scope) ? scope : (scope as ts.Node), scope.getSourceFile()),
      expanded: true,
      children: scoped.map((s) => ({
        label: s.label,
        description: [`line ${lineOf(s.node)}`, shownType(s), atCursor(s) ? 'at cursor' : undefined].filter(Boolean).join(' · '),
        focus: atCursor(s) || undefined,
        tooltip: `${s.kind} · line ${lineOf(s.node)}${s.type ? `\nType here: ${s.type}` : ''}`,
        icon: icons[s.kind],
        tone: s.kind === 'mutation' ? 'warning' : s.kind === 'write' || s.kind === 'update' ? 'info' : undefined,
        role: s.kind === 'declaration' ? 'definition' : s.kind === 'write' || s.kind === 'update' || s.kind === 'mutation' ? 'write' : 'read',
        location: builder.at(s.node),
      })),
    });
  }
  if (declaration && ts.isParameter(declaration) && isFunctionWithBody(declaration.parent)) {
    const incoming = incomingValues(project, declaration, builder);
    if (incoming.length > 0) {
      roots.unshift({ label: 'Incoming values from call sites', icon: 'call-incoming', expanded: true, children: incoming });
    }
  }
  const count = (kinds: FlowKind[]) => steps.filter((s) => kinds.includes(s.kind)).length;
  return builder.finish(
    roots,
    `${plural(count(['write', 'update', 'declaration']), 'definition')}, ${plural(count(['mutation']), 'mutation')}, ${plural(count(['condition']), 'check')}, ${plural(count(['argument']), 'hand-off')}`,
  );
}

function incomingValues(project: VirtualProject, parameter: ts.ParameterDeclaration, builder: ReportBuilder): ReportNode[] {
  const { calls } = callSitesOf(project.service, parameter.parent as Parameters<typeof callSitesOf>[1]);
  return calls.map(({ call }) => {
    let { expression, note } = argumentFor(call, parameter);
    if ((ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call)) && ts.isIdentifier(parameter.name)) {
      note = 'props object';
    }
    if ((ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call)) && ts.isObjectBindingPattern(parameter.name)) {
      const props = parameter.name.elements.map((e) => {
        const attribute = jsxAttribute(call, (e.propertyName ?? e.name).getText());
        return `${(e.propertyName ?? e.name).getText()}=${attribute?.initializer ? nodeText(attribute.initializer) : 'omitted'}`;
      });
      note = props.join(', ');
    }
    return {
      label: expression ? nodeText(expression) : (note ?? 'unknown'),
      description: `${functionLabel(enclosingFunction(call))} · ${baseName(call.getSourceFile().fileName)}`,
      icon: 'arrow-left',
      role: 'read' as const,
      location: builder.at(expression ?? call),
    };
  });
}

function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '');
}
