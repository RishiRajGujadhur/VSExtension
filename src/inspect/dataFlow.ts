import * as ts from 'typescript';
import { learnMore } from './patternLinks';
import { raceFindings, variableUse } from './races';
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
  // `<Price amount={count} />` names the prop at a call site: the call site sets it.
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    const value = parent.initializer && ts.isJsxExpression(parent.initializer) ? parent.initializer.expression : parent.initializer;
    return step('write', `set by <${nodeText(parent.parent.parent.tagName)} ${node.getText()}=${value ? nodeText(value) : 'true'}>`, value);
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
export function dataFlowReport(project: VirtualProject, fileName: string, offset: number, options: { byDirection?: boolean } = {}): Report {
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
  const scopeRow = (scope: ts.Node | ts.SourceFile, scoped: FlowStep[]): ReportNode => ({
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
  const byDirection = options.byDirection ?? false;
  // By direction, the code that writes the value goes under Flows in and the code that reads it under Flows out.
  const isWrite = (s: FlowStep) => ['declaration', 'write', 'update', 'mutation', 'import'].includes(s.kind);
  const scopeRows = (pick: (s: FlowStep) => boolean) =>
    [...groups].map(([scope, scoped]) => [scope, scoped.filter(pick)] as const).filter(([, scoped]) => scoped.length > 0).map(([scope, scoped]) => scopeRow(scope, scoped));
  const roots: ReportNode[] = byDirection ? [] : scopeRows(() => true);
  const codeGroup = (label: string, icon: string, rows: ReportNode[]): ReportNode[] =>
    rows.length ? [{ label, description: plural(rows.length, 'function'), icon, expanded: rows.length <= 3 || rows.some((r) => r.children?.some((c) => c.focus)), children: rows }] : [];
  const written = byDirection ? scopeRows(isWrite) : [];
  const read = byDirection ? scopeRows((s) => !isWrite(s)) : [];
  // Where the value comes from and where it goes, before the step-by-step timeline.
  const inflows = [...flowsIn(project, steps, name, builder), ...stateInflows(project, declaration, name, builder)];
  const destructured = declaration && ts.isBindingElement(declaration) ? incomingProperty(project, declaration, builder) : [];
  if (destructured.length > 0) {
    inflows.unshift({ label: 'Incoming values from call sites', icon: 'call-incoming', expanded: true, children: destructured });
  }
  if (declaration && ts.isParameter(declaration) && isFunctionWithBody(declaration.parent)) {
    const incoming = incomingValues(project, declaration, builder);
    if (incoming.length > 0) {
      inflows.unshift({ label: 'Incoming values from call sites', icon: 'call-incoming', expanded: true, children: incoming });
    }
  }
  const outflows = flowsOut(project, steps, builder);
  const risky = inflows.filter((r) => r.tone === 'warning').length;
  const inNote = inflows.length ? `${plural(inflows.length, 'source')} of the value${risky ? `, ${risky} may be null or undefined` : ''}` : 'no values assigned';
  const outNote = outflows.length ? `${plural(outflows.length, 'place')} the value goes` : byDirection ? 'not passed on' : 'the value stays here';
  roots.unshift(
    {
      label: 'Flows in',
      description: written.length ? `${inNote}, written in ${plural(written.length, 'function')}` : inNote,
      icon: 'arrow-circle-right',
      expanded: true,
      children: [...inflows, ...codeGroup('Where it is written', 'edit', written)],
    },
    {
      label: 'Flows out',
      description: read.length ? `${outNote}, read in ${plural(read.length, 'function')}` : outNote,
      icon: 'arrow-circle-left',
      expanded: true,
      children: [...outflows, ...codeGroup('Where it is read', 'eye', read)],
    },
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
      children: groupPatterns(patterns.map((p) => ({ name: p.name, row: { label: p.name, description: p.evidence, tooltip: `**${p.name}**: ${p.meaning}\n\n${p.evidence}${learnMore(p.name)}`, icon: 'symbol-namespace', location: p.node ? builder.at(p.node) : undefined, action: { kind: 'explainPattern', name: p.name } } }))),
    });
  }
  // Shared state read, awaited and written: the same findings as Race Conditions.
  const races = raceFindings(variableUse(project, fileName, offset, { name, steps, declaration }));
  if (races.length) {
    roots.push({
      label: 'Race conditions',
      description: `${plural(races.length, 'possible race')} between async calls`,
      icon: 'warning',
      tone: 'warning',
      expanded: true,
      children: races.map((r) => ({ label: r.message, tooltip: r.message, icon: 'watch', tone: 'warning', location: r.write ? builder.at(r.write.node) : r.fn ? builder.at(r.fn) : undefined })),
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
    // A value that may be null or undefined is flagged where it comes in, before anything reads it.
    const nullish = forOf || step.kind === 'update' ? undefined : nullishNote(checker, value);
    rows.push({
      label: forOf ? `each item of ${nodeText(value)}` : step.kind === 'update' ? step.label : `= ${nodeText(value)}`,
      description: [`line ${lineOf(step.node)} · ${functionLabel(enclosingFunction(step.node))}`, nullish].filter(Boolean).join(' · '),
      tone: nullish ? 'warning' : undefined,
      tooltip: nullish ? `This value ${nullish}: check it before using it, or run Nullability for where it comes from.` : undefined,
      icon: nullish ? 'warning' : step.kind === 'declaration' ? 'symbol-variable' : 'edit',
      role: 'write',
      location: builder.at(step.node),
      children: sourcesOf(checker, value, name, builder),
    });
  }
  return rows;
}

/**
 * React state: `const [count, setCount] = useState(0)` gets its values from the initial value and from every
 * `setCount(…)` call, which are not assignments to `count` itself.
 */
function stateInflows(project: VirtualProject, declaration: ts.Declaration | undefined, name: string, builder: ReportBuilder): ReportNode[] {
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isArrayBindingPattern(declaration.parent) || declaration.parent.elements[0] !== declaration) {
    return [];
  }
  const variable = declaration.parent.parent;
  const call = ts.isVariableDeclaration(variable) && variable.initializer && skipParentheses(variable.initializer);
  if (!call || !ts.isCallExpression(call) || !/(^|\.)use(State|Reducer)$/.test(call.expression.getText())) {
    return [];
  }
  const checker = project.program().getTypeChecker();
  const rows: ReportNode[] = [];
  const initial = call.arguments[0];
  if (initial) {
    rows.push({ label: `initial state ${nodeText(initial)}`, description: `line ${lineOf(initial)} · ${functionLabel(enclosingFunction(call))}`, icon: 'symbol-variable', role: 'write', location: builder.at(initial), children: sourcesOf(checker, initial, name, builder) });
  }
  const setter = declaration.parent.elements[1];
  if (!setter || !ts.isBindingElement(setter) || !ts.isIdentifier(setter.name)) {
    return rows;
  }
  for (const reference of referencesAt(project.service, setter.getSourceFile().fileName, setter.name.getStart())) {
    const use = reference.parent;
    if (!ts.isCallExpression(use) || use.expression !== reference || !use.arguments[0]) {
      continue;
    }
    const value = use.arguments[0];
    // A function passed to the setter computes the next state from the previous one.
    const updater = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
    const nullish = updater ? undefined : nullishNote(checker, value);
    rows.push({
      label: `${setter.name.text}(${nodeText(value)})`,
      tone: nullish ? 'warning' : undefined,
      description: [`line ${lineOf(use)} · ${functionLabel(enclosingFunction(use))}`, updater ? 'from the previous state' : '', nullish].filter(Boolean).join(' · '),
      tooltip: updater ? 'An updater function: React calls it with the current state and stores what it returns.' : `Stores ${nodeText(value)} as the next ${name}.`,
      icon: 'edit',
      role: 'write',
      location: builder.at(use),
      children: updater ? [] : sourcesOf(checker, value, name, builder),
    });
  }
  return rows;
}

/** "may be undefined" when the value's type includes null or undefined. */
function nullishNote(checker: ts.TypeChecker, value: ts.Node): string | undefined {
  const type = checker.getTypeAtLocation(value);
  const parts = type.isUnion() ? type.types : [type];
  const words = [parts.some((t) => t.flags & ts.TypeFlags.Null) ? 'null' : '', parts.some((t) => t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) ? 'undefined' : ''].filter(Boolean);
  return words.length ? `may be ${words.join(' or ')}` : undefined;
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
  | { kind: 'return'; fn: ts.Node | undefined }
  | { kind: 'prop'; attribute: ts.JsxAttribute };

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
    // `<Price amount={total} />`: the value becomes a prop of the component.
    if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
      return { kind: 'prop', attribute: parent.parent };
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
    } else if (flow.kind === 'prop') {
      const element = flow.attribute.parent.parent;
      const prop = flow.attribute.name.getText();
      const target = propBinding(checker, element.tagName, prop);
      rows.push({
        label: `→ prop ${prop} of <${nodeText(element.tagName)}>`,
        description,
        tooltip: target ? `Becomes ${prop} inside ${nodeText(element.tagName)}; Trace This Value follows it there.` : undefined,
        icon: 'symbol-property',
        role: 'read',
        location: builder.at(step.node),
        action: target ? followFlow(target) : undefined,
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

/** The name a component gives a prop, such as `amount` in `function Price({ amount })` or `props` in `Price(props)`. */
function propBinding(checker: ts.TypeChecker, tagName: ts.JsxTagNameExpression, prop: string): ts.Node | undefined {
  let symbol = checker.getSymbolAtLocation(tagName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration;
  const fn = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
  if (!fn || !isFunctionWithBody(fn) || fn.getSourceFile().isDeclarationFile) {
    return undefined;
  }
  const props = fn.parameters[0];
  if (props && ts.isObjectBindingPattern(props.name)) {
    return props.name.elements.find((e) => (e.propertyName ?? e.name).getText() === prop)?.name;
  }
  return props && ts.isIdentifier(props.name) ? props.name : undefined;
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

/**
 * A property destructured from a parameter, such as the `amount` prop of `Price({ amount })`: what each call site
 * passes for it, from the JSX attribute or the object literal, or that it is left out.
 */
function incomingProperty(project: VirtualProject, binding: ts.BindingElement, builder: ReportBuilder): ReportNode[] {
  const parameter = binding.parent.parent;
  if (!ts.isObjectBindingPattern(binding.parent) || !ts.isParameter(parameter) || !isFunctionWithBody(parameter.parent)) {
    return [];
  }
  const fn = parameter.parent as Parameters<typeof callSitesOf>[1];
  const index = fn.parameters.indexOf(parameter);
  const prop = (binding.propertyName ?? binding.name).getText();
  const omitted = binding.initializer ? `omitted, default ${nodeText(binding.initializer)}` : 'omitted (undefined)';
  return callSitesOf(project.service, fn).calls.map(({ call }): ReportNode => {
    const where = `${functionLabel(enclosingFunction(call))} · ${baseName(call.getSourceFile().fileName)}`;
    let value: ts.Node | undefined;
    let label = omitted;
    if (ts.isJsxOpeningElement(call) || ts.isJsxSelfClosingElement(call)) {
      const attribute = index === 0 ? jsxAttribute(call, prop) : undefined;
      value = attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute?.initializer;
      label = attribute ? (value ? nodeText(value) : 'true') : omitted;
    } else if (ts.isCallExpression(call) || ts.isNewExpression(call)) {
      const argument = call.arguments?.[index];
      const property = argument && ts.isObjectLiteralExpression(argument) ? argument.properties.find((p) => p.name?.getText() === prop) : undefined;
      value = property && ts.isPropertyAssignment(property) ? property.initializer : property && ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      label = value ? nodeText(value) : argument && !ts.isObjectLiteralExpression(argument) ? `${nodeText(argument)}.${prop}` : omitted;
    }
    return { label, description: where, icon: 'arrow-left', tone: value || label !== omitted || binding.initializer ? undefined : 'info', role: 'read', location: builder.at(value ?? call) };
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

/**
 * One row per pattern. A pattern found in several places becomes a group ("Controlled component · 7 places")
 * with one row per place, so a long list of the same pattern reads as a single entry.
 */
export function groupPatterns(found: readonly { name: string; row: ReportNode }[]): ReportNode[] {
  const byName = new Map<string, ReportNode[]>();
  for (const { name, row } of found) {
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  return [...byName].map(([name, rows]) => {
    if (rows.length === 1) {
      return rows[0];
    }
    const files = new Set(rows.map((r) => r.location?.file).filter(Boolean)).size;
    return {
      ...rows[0],
      label: name,
      description: `${plural(rows.length, 'place')}${files > 1 ? ` in ${plural(files, 'file')}` : ''}`,
      location: undefined,
      expanded: rows.length <= 3,
      children: rows.map((r) => ({
        label: r.description ?? r.label,
        description: r.location ? `${baseName(r.location.file)}:${r.location.line + 1}` : undefined,
        tooltip: r.tooltip,
        icon: 'symbol-namespace',
        location: r.location,
      })),
    };
  });
}
