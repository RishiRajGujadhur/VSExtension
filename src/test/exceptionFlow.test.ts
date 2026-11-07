import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { exceptionFlowReport } from '../inspect/exceptionFlow';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/exceptions.ts');

function outline(nodes: readonly ReportNode[]): string[] {
  const lines: string[] = [];
  forEachReportNode(nodes.filter((n) => n.label !== 'How to fix'), (n, depth) => lines.push(`${'  '.repeat(depth)}${n.label}${n.description ? ` — ${n.description}` : ''}`));
  return lines;
}

test('errors from callees are traced to their throw sites and to how each caller handles them', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function read|Setting'));
  assert.deepEqual(outline(report.roots), [
    'Uncaught — 1 path',
    '  main has no callers: errors are uncaught — via main',
    'Thrown here — 0 errors',
    '  nothing thrown directly',
    'Thrown by called functions — 2 errors',
    "  parseConfig() → throw new ConfigError('empty config') — escapes to the caller",
    "    throw new ConfigError('empty config')",
    '  parseConfig() → JSON.parse(): SyntaxError on invalid JSON — escapes to the caller',
    '    JSON.parse(): SyntaxError on invalid JSON',
    'Error types — ConfigError, SyntaxError',
    '  ConfigError — 1 source',
    '  SyntaxError — 1 source',
    'Escaping errors (2) reach callers',
    '  caught in quietly — empty catch block swallows the error',
    '  propagates through main',
    '    main has no callers: errors are uncaught',
  ]);
});

test('a caller reached by two routes is followed on both', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function vali|date'));
  const callers = outline(report.roots.slice(report.roots.findIndex((r) => r.label.startsWith('Escaping'))));
  assert.deepEqual(callers, [
    'Escaping errors (1) reach callers',
    '  propagates through checkName',
    '    propagates through checkForm',
    '      checkForm has no callers: errors are uncaught',
    '  propagates through checkEmail',
    '    propagates through checkForm',
    '      checkForm has no callers: errors are uncaught',
  ]);
});

test('common library calls that throw are recognized', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function snap|shot'));
  assert.deepEqual(report.roots.find((r) => r.label === 'Thrown here')?.children?.map((c) => c.label), [
    'fs.readFileSync(): Error when the path is missing or not accessible',
    'JSON.stringify(): TypeError on circular structures or BigInt values',
  ]);
});

test('an error that enters an async caller is followed as a rejection', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function parse|Port'));
  const callers = outline(report.roots.slice(report.roots.findIndex((r) => r.label.startsWith('Escaping'))));
  assert.equal(callers[1], '  propagates into async connect, becoming a rejection');
  assert.match(callers[2], /^ {4}not awaited: the rejection is unhandled/);
});

test('errors from a called function can be followed into it', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function read|Setting'));
  const fromCall = report.roots.find((r) => r.label === 'Thrown by called functions')?.children?.[0];
  assert.deepEqual(fromCall?.action, { kind: 'follow', command: 'tsStructure.exceptionFlow', file: fromCall?.action?.file, offset: offsetIn(file, 'function |parseConfig') });
});

test('a catch block that throws a new error transforms it; the new throw escapes', () => {
  const report = exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), file, offsetIn(file, 'function load|Config'));
  const lines = outline(report.roots);
  assert.ok(lines.includes('  throw new ConfigError(`invalid: ${String(error)}`) — escapes to the caller'), lines.join('\n'));
  assert.ok(lines.includes("  parseConfig() → throw new ConfigError('empty config') — caught: throws new ConfigError(`invalid: ${String(error)}`) instead"), lines.join('\n'));
  assert.ok(lines.includes('  catch (error): throws new ConfigError(`invalid: ${String(error)}`) instead'), lines.join('\n'));
});
