import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { nullabilityReport } from '../inspect/nullability';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/nullable.ts');

/** The tree's labels, indented by depth, without the How to fix advice. */
function labels(nodes: readonly ReportNode[]): string[] {
  const result: string[] = [];
  // The Declared row and any non-null assertions are tested on their own.
  forEachReportNode(nodes.filter((n) => n.label !== 'How to fix' && n.label !== 'Declared' && !n.label.startsWith('Asserted non-null')), (n, depth) => result.push(`${'  '.repeat(depth)}${n.label}`));
  return result;
}

test('a nullable variable is traced through its initializer into the returns of the called function', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${la|bel}'));
  assert.equal(report.roots[0].label, 'label: string | null');
  assert.equal(report.roots[0].description, 'may be null here');
  assert.deepEqual(labels(report.roots.slice(1).filter((r) => r.label !== 'Uses')), [
    'Paths that produce null',
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

test('uses of a variable say where it is still nullable', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, 'const us|er = findUser'));
  const uses = report.roots.find((r) => r.label === 'Uses');
  assert.equal(uses?.description, '2 safe, 1 check, 0 may be undefined');
  assert.deepEqual(
    uses?.children?.map((c) => `${c.label} (${c.description})`),
    ['!user (line 30 · check)', 'user.name (line 33 · safe)', 'user.nickname (line 33 · safe)'],
  );
});

test('on a function name, the returns that give null are listed', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, 'function look|up'));
  assert.equal(report.title, 'Nullability of lookup()');
  assert.equal(report.roots[0].label, 'lookup() returns string | null');
  assert.deepEqual(labels(report.roots.slice(1)), [
    'Returns that produce null or undefined',
    '  lookup is declared to return string | null',
    '  lookup returns null',
    '    null literal',
  ]);
  assert.equal(report.description, '1 nullable return');
  // Rows say where they are, since sources are often in other files.
  assert.equal(report.roots[1].children?.[1].description, 'nullable.ts:12');
});

test('module state lists its declaration and every assignment of undefined', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${cur|rent?.name}'));
  assert.deepEqual(labels(report.roots.slice(1).filter((r) => r.label !== 'Uses')), [
    'Paths that produce undefined',
    '  declared as User | undefined',
    '  current is declared without a value',
    '  assigned undefined in logout',
    '    undefined literal',
  ]);
  // The declared type only explains; the sources are the missing initializer and the assignment.
  assert.equal(report.description, '2 sources');
});

test('an optional parameter lists call sites that omit it or pass undefined', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, 'return na|me ??'));
  assert.deepEqual(labels(report.roots.slice(1).filter((r) => r.label !== 'Uses')), [
    'Paths that produce undefined',
    '  name is an optional parameter',
    '  caller omits the argument',
    '  caller passes undefined',
    '    undefined literal',
  ]);
});

test('uses of a property list its reads', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '  nick|name?: string'));
  const uses = report.roots.find((r) => r.label === 'Uses');
  assert.equal(uses?.children?.length, 1);
  assert.match(uses?.children?.[0].label ?? '', /user\.nickname/);
  assert.match(uses?.children?.[0].description ?? '', /may be undefined/);
});

test('nullability copes with code that looks like a regular expression', () => {
  const syntax = path.join(fixtures, 'inspect/src/syntax.ts');
  assert.doesNotThrow(() => nullabilityReport(virtualProject('inspect', 'src/syntax.ts'), syntax, offsetIn(syntax, '.te|st(source)')));
});

test('nullability says where the value is declared', () => {
  const report = nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), file, offsetIn(file, '${la|bel}'));
  const declared = report.roots.find((r) => r.label === 'Declared');
  assert.ok(declared?.location, 'a Declared row with its location');
  assert.match(declared!.description!, /nullable\.ts:\d+/);
});
