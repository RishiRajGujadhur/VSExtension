import * as ts from 'typescript';
import { learnMore } from './patternLinks';
import { AnalysisError } from '../analysis/types';
import { DetectedPattern, detectLayers, detectPatterns, patternMeaning } from './patterns';
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
  /** For a hand-off, the parameter the value becomes in the called function. */
  parameter?: ts.ParameterDeclaration;
}

const mutatingMethods = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);

/** Every place a variable, parameter or property is defined, changed, tested, passed on or read, in source order. */
export function dataFlowSteps(project: VirtualProject, fileName: string, offset: number): { name: string; steps: FlowStep[]; declaration?: ts.Declaration } {
  const sourceFile = project.sourceFile(fileName);
  const checker = project.program().getTypeChecker();
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a variable, parameter or property.');
  const symbol = symbolAt(checker, identifier);
  if (!symbol || !(symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property | ts.SymbolFlags.Accessor))) {
    throw new AnalysisError(`'${identifier.text}' isn't a variable, parameter or property.`);
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
    return { ...step('argument', `→ ${nodeText(outerParent.expression)}(…)${target}`), parameter };
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
      description: `${baseName(scope.getSourceFile().fileName)} · ${stepSummary(scoped)}`,
      icon: ts.isSourceFile(scope) ? 'file-code' : 'symbol-function',
      location: builder.at(ts.isSourceFile(scope) ? scope : (scope as ts.Node), scope.getSourceFile()),
      expanded: true,
      children: scoped.map((s) => ({
        label: s.label,
        description: [`line ${lineOf(s.node)}`, shownType(s), atCursor(s) ? 'at cursor' : undefined].filter(Boolean).join(' · '),
        focus: atCursor(s) || undefined,
        action:
          s.parameter && ts.isIdentifier(s.parameter.name)
            ? { kind: 'traceValue', command: 'tsStructure.dataFlow', file: s.parameter.getSourceFile().fileName, offset: s.parameter.name.getStart() }
            : undefined,
        tooltip: `${s.kind} · line ${lineOf(s.node)}${s.type ? `\nType here: ${s.type}` : ''}`,
        icon: icons[s.kind],
        tone: s.kind === 'mutation' ? 'warning' : s.kind === 'write' || s.kind === 'update' ? 'info' : undefined,
        role: s.kind === 'declaration' ? 'definition' : s.kind === 'write' || s.kind === 'update' || s.kind === 'mutation' ? 'write' : 'read',
        location: builder.at(s.node),
      })),
    });
  }
  // Where the value comes from and where it goes, before the step-by-step timeline.
  const inflows = flowsIn(project, steps, name, builder);
  if (declaration && ts.isParameter(declaration) && isFunctionWithBody(declaration.parent)) {
    const incoming = incomingValues(project, declaration, builder);
    if (incoming.length > 0) {
      inflows.unshift({ label: 'Incoming values from call sites', icon: 'call-incoming', expanded: true, children: incoming });
    }
  }
  const outflows = flowsOut(project, steps, builder);
  roots.unshift(
    { label: 'Flows in', description: inflows.length ? `${plural(inflows.length, 'source')} of the value` : 'no values assigned', icon: 'arrow-circle-right', expanded: true, children: inflows },
    { label: 'Flows out', description: outflows.length ? `${plural(outflows.length, 'place')} the value goes` : 'the value stays here', icon: 'arrow-circle-left', expanded: true, children: outflows },
  );
  // Types the value has: patterns about them count too, wherever they are declared.
  const checker = project.program().getTypeChecker();
  const typeDeclarations = steps.flatMap((s) => {
    const symbol = checker.getTypeAtLocation(s.node).getSymbol();
    return symbol?.declarations?.filter((d) => !d.getSourceFile().isDeclarationFile).map((d) => ({ name: symbol.getName(), file: d.getSourceFile() })) ?? [];
  });
  const patterns = patternsAlong(steps, typeDeclarations);
  if (patterns.length > 0) {
    roots.push({
      label: 'Design patterns',
      description: 'how the code this value passes through is organized',
      icon: 'library',
      expanded: true,
      children: patterns.map((p) => ({ label: p.name, description: p.evidence, tooltip: `**${p.name}**: ${p.meaning}\n\n${p.evidence}${learnMore(p.name)}`, icon: 'symbol-namespace', location: p.node ? builder.at(p.node) : undefined, action: { kind: 'explainPattern', name: p.name } })),
    });
  }
  const count = (kinds: FlowKind[]) => steps.filter((s) => kinds.includes(s.kind)).length;
  // Only the counts that aren't zero; the patterns have their own group.
  const counts = [
    [count(['write', 'update', 'declaration']), 'definition'],
    [count(['mutation']), 'mutation'],
    [count(['condition']), 'check'],
    [count(['argument']), 'hand-off'],
  ] as const;
  return builder.finish(roots, counts.filter(([n]) => n > 0).map(([n, what]) => plural(n, what)).join(', ') || 'no definitions found');
}

type Follow = { kind: 'traceValue'; command: string; file: string; offset: number };

/** A row action that opens the data flow of another variable or property. */
function followFlow(name: ts.Node): Follow | undefined {
  const target = ts.isPropertyAccessExpression(name) ? name.name : name;
  return ts.isIdentifier(target) || ts.isPrivateIdentifier(target)
    ? { kind: 'traceValue', command: 'tsStructure.dataFlow', file: target.getSourceFile().fileName, offset: target.getStart() }
    : undefined;
}

/** The values assigned to the variable, each with the variables and calls it is computed from. */
function flowsIn(project: VirtualProject, steps: FlowStep[], name: string, builder: ReportBuilder): ReportNode[] {
  const checker = project.program().getTypeChecker();
  const rows: ReportNode[] = [];
  for (const step of steps) {
    const value = assignedValue(step);
    if (!value) {
      continue;
    }
    const forOf = ts.isForOfStatement(value.parent) && value.parent.expression === value;
    rows.push({
      label: forOf ? `each item of ${nodeText(value)}` : step.kind === 'update' ? step.label : `= ${nodeText(value)}`,
      description: `line ${lineOf(step.node)} · ${functionLabel(enclosingFunction(step.node))}`,
      icon: step.kind === 'declaration' ? 'symbol-variable' : 'edit',
      role: 'write',
      location: builder.at(step.node),
      children: sourcesOf(checker, value, name, builder),
    });
  }
  return rows;
}

/** The expression a declaration, assignment or loop gives the variable. */
function assignedValue(step: FlowStep): ts.Expression | undefined {
  const parent = step.node.parent;
  if (step.kind === 'declaration' && (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isParameter(parent)) && parent.name === step.node) {
    return parent.initializer;
  }
  if (step.kind === 'write' && ts.isVariableDeclaration(parent) && ts.isForOfStatement(parent.parent.parent)) {
    return parent.parent.parent.expression;
  }
  if (step.kind === 'write' || step.kind === 'update') {
    const write = writeOf(accessExpression(step.node));
    return write && ts.isBinaryExpression(write) ? write.right : undefined;
  }
  return undefined;
}

/** Variables, properties and calls an expression reads: what a value is computed from. */
function sourcesOf(checker: ts.TypeChecker, expression: ts.Expression, name: string, builder: ReportBuilder): ReportNode[] {
  const rows = new Map<string, ReportNode>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = nodeText(node.expression);
      rows.set(`call:${callee}`, { label: `returned by ${ts.isNewExpression(node) ? 'new ' : ''}${callee}(…)`, icon: 'symbol-method', location: builder.at(node) });
      node.arguments?.forEach(visit);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && symbol.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Accessor)) {
        rows.set(`read:${node.getText()}`, { label: `from ${nodeText(node)}`, icon: 'symbol-property', location: builder.at(node), action: followFlow(node) });
        return;
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Variable) {
        const self = node.text === name;
        rows.set(`read:${node.text}`, { label: self ? `from ${node.text} (its previous value)` : `from ${node.text}`, icon: 'symbol-variable', location: builder.at(node), action: self ? undefined : followFlow(node) });
      }
      return;
    }
    if (isFunctionWithBody(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...rows.values()];
}

type Outflow =
  | { kind: 'into'; target: ts.Node }
  | { kind: 'argument'; call: ts.CallExpression | ts.NewExpression; index: number }
  | { kind: 'return'; fn: ts.Node | undefined };

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

/** Where an expression's value ends up: a variable it is stored in, a call it is passed to, or a return. */
function outflowOf(node: ts.Node): Outflow | undefined {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === current) {
      return { kind: 'into', target: parent.name };
    }
    if (isAssignment(parent)) {
      return parent.right === current ? { kind: 'into', target: parent.left } : undefined;
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(current as ts.Expression)) {
      return { kind: 'argument', call: parent, index: parent.arguments.indexOf(current as ts.Expression) };
    }
    if (ts.isReturnStatement(parent)) {
      return { kind: 'return', fn: enclosingFunction(parent) };
    }
    if (ts.isArrowFunction(parent) && parent.body === current) {
      return { kind: 'return', fn: parent };
    }
    // Operators, templates, object literals and `await` pass the value on to whatever encloses them.
    const passesThrough =
      ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === current) ||
      (ts.isExpression(parent) && !ts.isCallExpression(parent) && !ts.isNewExpression(parent) && !isFunctionWithBody(parent)) ||
      ts.isTemplateSpan(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isSpreadAssignment(parent);
    if (!passesThrough) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/** Where the variable's value goes: other variables, calls, returns and, through returns, the callers that receive it. */
function flowsOut(project: VirtualProject, steps: FlowStep[], builder: ReportBuilder): ReportNode[] {
  const checker = project.program().getTypeChecker();
  const rows: ReportNode[] = [];
  for (const step of steps) {
    if (['declaration', 'write', 'update', 'import', 'mutation', 'call', 'condition'].includes(step.kind)) {
      continue;
    }
    const flow = outflowOf(accessExpression(step.node));
    if (!flow) {
      continue;
    }
    const description = `line ${lineOf(step.node)} · ${functionLabel(enclosingFunction(step.node))}`;
    if (flow.kind === 'into' && flow.target.getText() === accessExpression(step.node).getText()) {
      // `total = total * 0.9` updates the variable itself; that is a flow in.
      continue;
    }
    if (flow.kind === 'into') {
      rows.push({ label: `→ ${nodeText(flow.target)}`, description, tooltip: nodeSnippet(flow.target.parent, 80), icon: 'arrow-right', role: 'read', location: builder.at(step.node), action: followFlow(flow.target) });
    } else if (flow.kind === 'argument') {
      const callee = calledFunction(checker, flow.call);
      const parameter = callee?.parameters[Math.min(flow.index, callee.parameters.length - 1)];
      rows.push({
        label: `→ ${nodeText(flow.call.expression)}(…)${parameter ? ` as ${parameter.name.getText()}` : ''}`,
        description,
        icon: 'arrow-right',
        role: 'read',
        location: builder.at(step.node),
        action: parameter && ts.isIdentifier(parameter.name) ? followFlow(parameter.name) : undefined,
      });
    } else {
      rows.push({
        label: `returned from ${functionLabel(flow.fn)}`,
        description,
        icon: 'reply',
        role: 'read',
        location: builder.at(step.node),
        expanded: true,
        children: flow.fn && isFunctionWithBody(flow.fn) ? receivers(project, flow.fn, builder) : [],
      });
    }
  }
  return rows;
}

/** What callers do with a function's result: the variables that receive it, or where it goes next. */
function receivers(project: VirtualProject, fn: Parameters<typeof callSitesOf>[1], builder: ReportBuilder): ReportNode[] {
  const { calls } = callSitesOf(project.service, fn);
  return calls.map(({ call }): ReportNode => {
    const flow = outflowOf(call);
    const where = `${functionLabel(enclosingFunction(call))} · ${baseName(call.getSourceFile().fileName)}`;
    const row = { description: where, role: 'read' as const, location: builder.at(call) };
    if (flow?.kind === 'into') {
      return { ...row, label: `received as ${nodeText(flow.target)}`, icon: 'arrow-left', action: followFlow(flow.target) };
    }
    if (flow?.kind === 'return') {
      return { ...row, label: `returned again from ${functionLabel(flow.fn)}`, icon: 'reply' };
    }
    if (flow?.kind === 'argument') {
      return { ...row, label: `passed to ${nodeText(flow.call.expression)}(…)`, icon: 'arrow-right' };
    }
    return { ...row, label: `used in ${nodeSnippet(call.parent, 50)}`, icon: 'eye' };
  });
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

/** "2 writes, 1 check, 1 hand-off": what happens to the value in one function. */
function stepSummary(steps: FlowStep[]): string {
  const groups: [string, FlowKind[]][] = [
    ['write', ['declaration', 'write', 'update']],
    ['mutation', ['mutation']],
    ['check', ['condition']],
    ['hand-off', ['argument']],
    ['read', ['read', 'call', 'return', 'import']],
  ];
  return groups
    .map(([noun, kinds]) => [noun, steps.filter((s) => kinds.includes(s.kind)).length] as const)
    .filter(([, count]) => count > 0)
    .map(([noun, count]) => plural(count, noun))
    .join(', ');
}

function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '');
}

/**
 * Design patterns the value passes through: those whose code contains one of its steps, or that sit
 * inside a function where a step happens, plus layers when its files are in folders named after them.
 */
export function patternsAlong(steps: readonly { node: ts.Node }[], types: readonly { name: string; file: ts.SourceFile }[] = []): (Omit<DetectedPattern, 'node'> & { node?: ts.Node })[] {
  const files = [...new Set(steps.map((s) => s.node.getSourceFile()))];
  const typeNames = new Set(types.map((t) => t.name));
  const typeFiles = [...new Set(types.map((t) => t.file))].filter((f) => !files.includes(f));
  const inside = (inner: ts.Node, outer: ts.Node) => inner.getSourceFile() === outer.getSourceFile() && inner.getStart() >= outer.getStart() && inner.end <= outer.end;
  const scopes = steps.map((s) => enclosingFunction(s.node)).filter((f): f is NonNullable<typeof f> => !!f);
  const found: (Omit<DetectedPattern, 'node'> & { node?: ts.Node })[] = files
    .flatMap(detectPatterns)
    .filter((p) => steps.some((s) => inside(s.node, p.node)) || scopes.some((scope) => inside(p.node, scope)) || (!!p.subject && typeNames.has(p.subject)));
  found.push(...typeFiles.flatMap(detectPatterns).filter((p) => !!p.subject && typeNames.has(p.subject)));
  const layers = detectLayers(files.map((f) => f.fileName));
  if (layers.length >= 2) {
    found.push({ name: 'Layered architecture', evidence: `the value passes through ${layers.join(' → ')}`, meaning: patternMeaning('Layered architecture') });
  }
  // One row per pattern and place.
  return found.filter((p, i) => found.findIndex((q) => q.name === p.name && q.node === p.node) === i);
}
