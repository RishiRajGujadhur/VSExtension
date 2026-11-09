import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { polishReport, isTestPath } from '../structure/reportPolish';
import { Report, ReportNode } from '../structure/report';

const at = (file: string, line: number) => ({ file, line, character: 0, endLine: line, endCharacter: 1 });
const report = (kind: string, title: string, roots: ReportNode[], description = 'summary'): Report => ({ kind, title, description, roots, warnings: [], fileHashes: {} });

test('test files are recognized by name and folder', () => {
  assert.ok(isTestPath('/p/src/cart.test.ts'));
  assert.ok(isTestPath('/p/src/__tests__/cart.ts'));
  assert.ok(isTestPath('C:\\p\\test\\cart.ts'));
  assert.ok(!isTestPath('/p/src/contest.ts'));
});

test('find usages: the file at the cursor first, lines in order, functions counted, recursion and test-only use', () => {
  const r = report('usages', 'Usages of walk', [
    {
      label: 'Calls',
      description: '3',
      children: [
        { label: 'b.ts', description: 'test · 1', children: [{ label: 'walk()', description: 'spec · line 4', location: at('/p/b.test.ts', 3) }] },
        { label: 'a.ts', description: 'src · 2', children: [
          { label: 'walk(n.child)', description: 'walk · line 9', location: at('/p/a.ts', 8) },
          { label: 'walk(root)', description: 'start · line 2', location: at('/p/a.ts', 1), focus: true },
        ] },
      ],
    },
  ]);
  polishReport(r);
  const calls = r.roots[0];
  assert.equal(calls.children![0].label, 'a.ts');
  assert.deepEqual(calls.children![0].children!.map((c) => c.location!.line), [1, 8]);
  assert.match(calls.description!, /in 3 functions/);
  assert.match(calls.children![0].children![1].description!, /recursive call/);
  // Used outside tests: no warning.
  assert.deepEqual(r.warnings, []);
  // Polishing twice changes nothing.
  const once = JSON.stringify(r);
  polishReport(r);
  assert.equal(JSON.stringify(r), once);
});

test('argument propagation: undefined first, and values that differ only in case', () => {
  const r = report('argumentFlow', 'Propagation of code', [
    { label: 'Values that can arrive', children: [{ label: "'b'" }, { label: "'READ'" }, { label: 'omitted (undefined)' }, { label: "'read'" }] },
  ]);
  polishReport(r);
  assert.equal(r.roots[0].children![0].label, 'omitted (undefined)');
  assert.match(r.warnings[0], /'READ' and 'read' differ only in letter case|'read' and 'READ' differ only in letter case/);
  assert.match(r.description!, /4 distinct values/);
});

test('dead exports: busiest files first, line numbers, entry points folded and sorted', () => {
  const r = report('deadExports', 'Dead exports', [
    { label: 'Unused exports', children: [
      { label: 'one.ts', children: [{ label: 'a', description: 'unused', location: at('/p/one.ts', 4) }] },
      { label: 'two.ts', children: [{ label: 'b', description: 'unused · type', location: at('/p/two.ts', 0) }, { label: 'c', description: 'unused', location: at('/p/two.ts', 9) }] },
    ] },
    { label: 'Entry points', children: [{ label: 'z.ts' }, { label: 'a.ts' }] },
  ]);
  polishReport(r);
  assert.equal(r.roots[0].children![0].label, 'two.ts');
  assert.match(r.roots[0].children![0].children![1].description!, /line 10/);
  assert.match(r.roots[0].description!, /in 2 files/);
  assert.equal(r.roots[1].expanded, false);
  assert.deepEqual(r.roots[1].children!.map((c) => c.label), ['a.ts', 'z.ts']);
  assert.match(r.description!, /1 type among them/);
});

test('graph diff: new cycles first, removed imports good news', () => {
  const r = report('graphDiff', 'Dependency changes since main', [
    { label: 'Added imports', children: [{ label: 'a → b', location: at('/p/a.ts', 0) }] },
    { label: 'Removed imports', children: [{ label: 'c → d', location: at('/p/c.ts', 0) }] },
    { label: 'New import cycles', children: [{ label: 'a → b → a' }] },
  ]);
  polishReport(r);
  assert.equal(r.roots[0].label, 'New import cycles');
  assert.equal(r.roots.find((g) => g.label === 'Removed imports')!.tone, 'ok');
});

test('data flow: a value that goes nowhere says what to try', () => {
  const r = report('dataFlow', 'Data flow of x', [{ label: 'Flows in', children: [] }, { label: 'Flows out', children: [] }]);
  polishReport(r);
  assert.match(r.roots[1].children![0].label, /Not passed on/);
});

test('inspect code: busiest file first, findings by line, the most common problem, the fixes', () => {
  const r = report('inspectCode', 'Inspection results', [
    { label: 'Missing await', children: [
      { label: 'a.ts', description: 'src/a.ts · 1', children: [{ label: 'x', location: at('/p/a.ts', 3) }] },
      { label: 'b.ts', description: 'src/b.ts · 2 · fixable', children: [{ label: 'y', location: at('/p/b.ts', 9) }, { label: 'z', location: at('/p/b.ts', 2) }] },
    ] },
    { label: 'Unsafe assertion', children: [{ label: 'c.ts', description: 'src/c.ts · 1', children: [{ label: 'w', location: at('/p/c.test.ts', 1) }] }] },
  ]);
  polishReport(r);
  assert.match(r.roots[0].label, /1 file can be fixed in one go/);
  const missing = r.roots.find((g) => g.label === 'Missing await')!;
  assert.equal(missing.children![0].label, 'b.ts');
  assert.deepEqual(missing.children![0].children!.map((c) => c.location!.line), [2, 9]);
  assert.match(missing.description!, /in 2 files/);
  assert.match(r.description!, /most common: Missing await \(3\)/);
  assert.match(r.roots.find((g) => g.label === 'Unsafe assertion')!.children![0].description!, /test/);
});

test('structural search: busiest file first, identical matches counted, no match explained', () => {
  const r = report('structuralSearch', 'Matches of $x$.log()', [
    { label: 'a.ts', children: [{ label: 'console.log()', description: 'x = console', location: at('/p/a.ts', 1) }] },
    { label: 'b.ts', children: [{ label: 'console.log()', description: 'x = console', location: at('/p/b.ts', 1) }, { label: 'logger.log()', description: 'x = logger', location: at('/p/b.ts', 5) }] },
  ]);
  polishReport(r);
  assert.equal(r.roots[0].label, 'b.ts');
  assert.match(r.roots[0].children![0].description!, /2 identical/);
  assert.match(r.description!, /most common: x = console \(2\)/);
  const none = report('structuralSearch', 'Matches of nothing', []);
  polishReport(none);
  assert.equal(none.roots[0].label, 'No match');
});
