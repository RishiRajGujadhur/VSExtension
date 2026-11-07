import * as ts from 'typescript';
import { VirtualProject } from '../refactor/virtualProject';
import { Report, ReportBuilder, ReportNode, nodeSnippet, plural } from '../structure/report';
import { FunctionWithBody, accessExpression, enclosingFunction, functionLabel, isFunctionWithBody, writeOf } from '../structure/util';
import { FlowStep, dataFlowSteps } from './dataFlow';

/** One use of the variable, placed in time within its function. */
export interface Access {
  kind: 'read' | 'check' | 'write' | 'mutation' | 'init';
  /** The reference itself. */
  node: ts.Node;
  /** When it takes effect: a read when evaluated, a write when its whole assignment finishes. */
  time: number;
  fn?: FunctionWithBody;
  /** An await in the same function comes before it, so other code may have run in between. */
  afterAwait: boolean;
  /** A write made by +=, ++ and the like, which adds to the value rather than replacing it. */
  compound?: boolean;
}

/** How widely the variable is shared, which decides whether two calls can interfere. */
export type Sharing = 'module' | 'property' | 'closure' | 'local';

export interface VariableUse {
  name: string;
  declaration?: ts.Node;
  sharing: Sharing;
  accesses: Access[];
}

export interface RaceFinding {
  kind: 'lost-update' | 'check-then-act' | 'many-writers';
  fn?: FunctionWithBody;
  /** The await that leaves the gap, for the first two kinds. */
  gap?: ts.Node;
  /** The write that may overwrite another call's work. */
  write?: Access;
  message: string;
}

/** Every read, check, write and mutation of the variable at the offset, with its function and await position. */
export function variableUse(project: VirtualProject, fileName: string, offset: number): VariableUse {
  const { name, steps, declaration } = dataFlowSteps(project, fileName, offset);
  const accesses = steps.flatMap(toAccesses);
  return { name, declaration, sharing: sharingOf(declaration, accesses), accesses: accesses.sort((a, b) => a.time - b.time) };
}

function toAccesses(step: FlowStep): Access[] {
  const fn = enclosingFunction(step.node);
  const at = (kind: Access['kind'], time: number): Access => ({ kind, node: step.node, time, fn, afterAwait: fn ? awaitsIn(fn).some((a) => a.end <= time) : false });
  const expression = accessExpression(step.node);
  switch (step.kind) {
    case 'declaration':
      return [at('init', step.node.getStart())];
    case 'write':
      return [at('write', (writeOf(expression) ?? expression).getEnd())];
    case 'update':
      // x += …, x++: the old value is read first and the new one written when the expression finishes.
      return [at('read', step.node.getStart()), { ...at('write', (writeOf(expression) ?? expression).getEnd()), compound: true }];
    case 'mutation': {
      const call = ts.findAncestor(step.node, ts.isCallExpression);
      const assignment = ts.findAncestor(step.node, (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken);
      return [at('mutation', (call ?? assignment ?? step.node).getEnd())];
    }
    case 'condition':
      return [at('check', step.node.getStart())];
    case 'import':
      return [];
    default:
      return [at('read', step.node.getStart())];
  }
}

/** The awaits of the function itself, not of functions nested in it. */
function awaitsIn(fn: FunctionWithBody): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && isFunctionWithBody(node)) {
      return;
    }
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
      found.push(ts.isForOfStatement(node) ? node.expression : node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

function sharingOf(declaration: ts.Node | undefined, accesses: Access[]): Sharing {
  if (!declaration || ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
    return 'property';
  }
  const owner = enclosingFunction(declaration);
  if (!owner) {
    return 'module';
  }
  return accesses.some((a) => a.fn && a.fn !== owner) ? 'closure' : 'local';
}

/** Where a function runs from when it is not called directly: a timer, a promise callback or an event handler. */
export function callbackOf(fn: FunctionWithBody | undefined): string | undefined {
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
    return undefined;
  }
  const parent = fn.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn)) {
    const callee = ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : parent.expression.getText();
    return /^(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|then|catch|finally|addEventListener|on|once|subscribe|useEffect|useLayoutEffect)$/.test(callee) ? `${callee}()` : undefined;
  }
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return `${parent.parent.name.getText()} handler`;
  }
  return undefined;
}

const isAsync = (fn: FunctionWithBody | undefined) => !!fn && (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0;

/** Read-await-write, check-await-write and writers that run at different times, on shared state. */
export function raceFindings(use: VariableUse): RaceFinding[] {
  if (use.sharing === 'local') {
    return [];
  }
  const findings: RaceFinding[] = [];
  const byFunction = new Map<FunctionWithBody, Access[]>();
  for (const access of use.accesses) {
    if (access.fn) {
      byFunction.set(access.fn, [...(byFunction.get(access.fn) ?? []), access]);
    }
  }
  for (const [fn, accesses] of byFunction) {
    const awaits = awaitsIn(fn);
    for (const write of accesses.filter((a) => a.kind === 'write' || a.kind === 'mutation')) {
      // A read or check before an await, and this write after it: another call can change the value during the wait.
      for (const before of accesses.filter((a) => (a.kind === 'read' || a.kind === 'check') && a.time < write.time)) {
        const gap = awaits.find((a) => before.time < a.end && a.end <= write.time);
        if (!gap) {
          continue;
        }
        const wait = nodeSnippet(gap, 30);
        findings.push(
          before.kind === 'check'
            ? { kind: 'check-then-act', fn, gap, write, message: `${functionLabel(fn)} checks ${use.name}, waits at ${wait}, then sets it: two calls can both pass the check before either one sets it.` }
            : { kind: 'lost-update', fn, gap, write, message: `${functionLabel(fn)} reads ${use.name}, waits at ${wait}, then writes it: a change made by another call during the wait is overwritten (a lost update).` },
        );
        break;
      }
    }
  }
  // Writers that run at different times: async functions and callbacks. When one of them replaces the value with =,
  // the one that finishes last decides it; += and push() only add to it.
  const writers = [...byFunction].filter(([fn, accesses]) => accesses.some((a) => a.kind === 'write' || a.kind === 'mutation') && (isAsync(fn) || callbackOf(fn)));
  if (writers.length >= 2 && writers.some(([, accesses]) => accesses.some((a) => a.kind === 'write' && !a.compound))) {
    findings.push({
      kind: 'many-writers',
      message: `${use.name} is changed from ${writers.length} places that run at different times (${writers.map(([fn]) => callbackOf(fn) ?? functionLabel(fn)).join(', ')}): the order they finish in decides its value.`,
    });
  }
  return findings;
}

const sharingText: Record<Sharing, string> = {
  module: 'module-level: every caller shares one value',
  property: 'a property: every user of the same object shares it',
  closure: 'captured by inner functions, which share it',
  local: 'local: each call has its own copy',
};

function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function accessRow(access: Access, builder: ReportBuilder): ReportNode {
  const statement = ts.findAncestor(access.node, (n) => ts.isExpressionStatement(n) || ts.isVariableStatement(n) || ts.isIfStatement(n) || ts.isReturnStatement(n)) ?? access.node;
  const text = ts.isIfStatement(statement) ? `if (${nodeSnippet(statement.expression, 40)})` : nodeSnippet(statement, 50);
  return {
    label: text,
    description: [`line ${lineOf(access.node)}`, access.kind === 'check' ? 'checked' : access.kind === 'init' ? 'initial value' : access.kind, access.afterAwait ? 'after an await' : undefined].filter(Boolean).join(' · '),
    icon: access.kind === 'mutation' ? 'edit' : access.kind === 'write' || access.kind === 'init' ? 'pencil' : access.kind === 'check' ? 'question' : 'eye',
    tone: access.kind === 'mutation' || access.kind === 'write' ? 'info' : undefined,
    location: builder.at(access.node),
  };
}

function functionRows(use: VariableUse, builder: ReportBuilder, keep: (a: Access) => boolean): ReportNode[] {
  const groups = new Map<ts.Node | undefined, Access[]>();
  for (const access of use.accesses.filter(keep)) {
    groups.set(access.fn, [...(groups.get(access.fn) ?? []), access]);
  }
  return [...groups].map(([fn, accesses]) => {
    const f = fn as FunctionWithBody | undefined;
    const changes = accesses.filter((a) => a.kind === 'write' || a.kind === 'mutation').length;
    return {
      label: f ? functionLabel(f) : 'module scope',
      description: [
        changes ? plural(changes, 'change') : accesses.every((a) => a.kind === 'init') ? 'initial value' : plural(accesses.length, 'use'),
        isAsync(f) ? 'async' : undefined,
        callbackOf(f) ? `runs from ${callbackOf(f)}` : undefined,
        accesses.some((a) => a.afterAwait && a.kind !== 'read' && a.kind !== 'check') ? 'changes after an await' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      icon: f ? 'symbol-function' : 'file-code',
      location: f ? builder.at(f) : undefined,
      expanded: true,
      children: accesses.map((a) => accessRow(a, builder)),
    };
  });
}

/** Mutation Tracking for This Variable: every function that assigns or changes it, and when that happens. */
export function variableMutationReport(project: VirtualProject, fileName: string, offset: number): Report {
  const use = variableUse(project, fileName, offset);
  const builder = new ReportBuilder('variableMutations', `Mutations of ${use.name}`);
  const changes = (a: Access) => a.kind === 'write' || a.kind === 'mutation' || a.kind === 'init';
  const rows = functionRows(use, builder, changes);
  const roots: ReportNode[] = [
    { label: use.name, description: sharingText[use.sharing], icon: 'symbol-variable', location: use.declaration ? builder.at(use.declaration) : undefined },
    ...rows,
  ];
  const races = raceFindings(use);
  if (races.length) {
    roots.push({ label: 'Possible race conditions', description: plural(races.length, 'finding'), icon: 'warning', tone: 'warning', expanded: true, children: races.map((r) => raceRow(r, builder)) });
  }
  const count = use.accesses.filter((a) => a.kind === 'write' || a.kind === 'mutation').length;
  return builder.finish(roots, count ? `${plural(count, 'change')} in ${plural(rows.filter((r) => !/^initial value/.test(r.description ?? '')).length, 'place')}` : 'never changed after it is declared');
}

function raceRow(finding: RaceFinding, builder: ReportBuilder): ReportNode {
  const titles = { 'lost-update': 'Lost update', 'check-then-act': 'Check, then act', 'many-writers': 'Several async writers' } as const;
  return {
    label: titles[finding.kind],
    description: finding.fn ? functionLabel(finding.fn) : undefined,
    tooltip: finding.message,
    icon: 'warning',
    tone: 'warning',
    location: finding.write ? builder.at(finding.write.node) : finding.fn ? builder.at(finding.fn) : undefined,
    children: finding.gap ? [{ label: `waits here: ${nodeSnippet(finding.gap, 40)}`, description: `line ${lineOf(finding.gap)}`, icon: 'watch', location: builder.at(finding.gap) }] : undefined,
  };
}

/** Race Conditions: whether async code can interleave between reading and writing the variable at the offset. */
export function raceReport(project: VirtualProject, fileName: string, offset: number): Report {
  const use = variableUse(project, fileName, offset);
  const builder = new ReportBuilder('races', `Race conditions on ${use.name}`);
  const findings = raceFindings(use);
  const roots: ReportNode[] = [{ label: use.name, description: sharingText[use.sharing], icon: 'symbol-variable', location: use.declaration ? builder.at(use.declaration) : undefined }];
  if (findings.length) {
    roots.push({ label: 'Possible race conditions', description: plural(findings.length, 'finding'), icon: 'warning', tone: 'warning', expanded: true, children: findings.map((f) => raceRow(f, builder)) });
  } else {
    roots.push({
      label: use.sharing === 'local' ? 'No race between calls' : 'No read-await-write found',
      description: use.sharing === 'local' ? 'each call has its own copy' : 'no await falls between reading or checking it and writing it',
      icon: 'pass',
      tone: 'ok',
    });
  }
  roots.push({ label: 'Who uses it, in order', icon: 'list-ordered', children: functionRows(use, builder, (a) => a.kind !== 'init') });
  return builder.finish(roots, findings.length ? plural(findings.length, 'possible race') : 'no race found');
}
