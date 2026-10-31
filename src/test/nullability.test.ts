import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { nullabilityReport } from '../inspect/nullability';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/nullable.ts');

function labels(nodes: readonly ReportNode[]): string[] {
  const result: string[] = [];
  forEachReportNode(nodes, (n, depth) => result.push(`${'  '.repeat(depth)}${n.label}`));
  return result;
}

test('a nullable variable is traced through its initializer into the returns of the called function', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${la|bel}'));
  assert.equal(report.roots[0].label, 'label: string | null');
  assert.deepEqual(labels(report.roots.slice(1)), [
    'Paths that produce null or undefined',
    '  initialized to lookup()',
    '    lookup is declared to return string | null',
    '    lookup returns null',
    '      null literal',
  ]);
});

test('a narrowed variable lists the guard that rules out null', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${us|er.name}'));
  assert.equal(report.roots[0].description, 'never null or undefined here');
  const guards = report.roots.find((r) => r.label === 'Ruled out by');
  assert.deepEqual(guards?.children?.map((c) => c.label), ['!user']);
});

test('module state lists its declaration and every assignment of undefined', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${cur|rent?.name}'));
  assert.deepEqual(labels(report.roots.slice(1)), [
    'Paths that produce null or undefined',
    '  declared as User | undefined',
    '  current is declared without a value',
    '  assigned undefined in logout',
    '    undefined literal',
  ]);
});

test('an optional parameter lists call sites that omit it or pass undefined', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, 'return na|me ??'));
  assert.deepEqual(labels(report.roots.slice(1)), [
    'Paths that produce null or undefined',
    '  name is an optional parameter',
    '  caller omits the argument',
    '  caller passes undefined',
    '    undefined literal',
  ]);
});
