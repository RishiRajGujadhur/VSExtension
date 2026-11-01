import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { DeadExportResult, deadExportReport, findDeadExports } from '../inspect/deadExports';
import { ReportNode, forEachReportNode } from '../structure/report';
import { defaultEntryPoints, programGraph } from '../navigate/moduleGraph';
import { fixtures, virtualProject } from './helpers';

const root = path.join(fixtures, 'deadexports');

function summary(result: DeadExportResult) {
  const names = (groups: DeadExportResult['unused']) =>
    groups.flatMap((g) => g.exports.map((e) => `${path.basename(g.sourceFile.fileName)}:${e.name}${e.usedLocally ? ' (local)' : ''}`)).sort();
  return {
    entries: result.entries.map((e) => path.basename(e)).sort(),
    unreachable: result.unreachable.map((g) => path.basename(g.sourceFile.fileName)).sort(),
    dead: names(result.unused),
  };
}

test('package.json entry points map back to source files', () => {
  const program = virtualProject('deadexports', 'src/index.ts').program();
  const entries = defaultEntryPoints(root, programGraph(program).files);
  assert.deepEqual(entries.map((e) => path.basename(e)), ['index.ts']);
});

test('rows show the kind of declaration and mark type-only exports', () => {
  const program = virtualProject('deadexports', 'src/index.ts').program();
  const report = deadExportReport(program, { entryPoints: defaultEntryPoints(root, programGraph(program).files), testsAreEntryPoints: true });
  const rows = new Map<string, ReportNode>();
  forEachReportNode(report.roots, (node) => node.action?.name && rows.set(String(node.action.name), node));
  assert.equal(rows.get('unused')?.icon, 'symbol-function');
  assert.equal(rows.get('localOnly')?.icon, 'symbol-constant');
  assert.equal(rows.get('Unused')?.icon, 'symbol-type-parameter');
  assert.equal(rows.get('Unused')?.description, 'unused · type');
  // With only a few results, file rows open by themselves.
  const unused = report.roots.find((r) => r.label === 'Unused exports');
  assert.ok(unused?.children?.every((file) => file.expanded));
});

test('a conventional index file is not an entry point when package.json names another', () => {
  const demo = path.join(fixtures, '..', 'docs', 'demo');
  const program = virtualProject('../docs/demo', 'src/main.ts').program();
  const entries = defaultEntryPoints(demo, programGraph(program).files);
  assert.deepEqual(entries.map((e) => path.basename(e)), ['main.ts']);
  // So exports the barrel re-exports but nothing imports are reported.
  const dead = findDeadExports(program, { entryPoints: entries, testsAreEntryPoints: true }).unused.flatMap((g) => g.exports);
  const clearCart = dead.find((e) => e.name === 'clearCart');
  assert.ok(clearCart, dead.map((e) => e.name).join(', '));
  // index.ts forwards it with `export * from './cart'`.
  assert.deepEqual(clearCart.reexportedBy?.map((f) => path.basename(f)), ['index.ts']);
  assert.equal(dead.find((e) => e.name === 'track'), undefined);
});

test('exports unused from the entry points are dead; re-exports and export * keep them alive', () => {
  // lib.ts:kept is unused too, but documented as @public.
  const program = virtualProject('deadexports', 'src/index.ts').program();
  const entryPoints = defaultEntryPoints(root, programGraph(program).files);
  assert.deepEqual(summary(findDeadExports(program, { entryPoints, testsAreEntryPoints: true })), {
    entries: ['index.ts', 'util.test.ts'],
    unreachable: ['orphan.ts'],
    dead: ['lib.ts:localOnly (local)', 'lib.ts:unused', 'util.ts:Unused'],
  });
  // Without tests as entry points, test-only exports are dead too.
  assert.deepEqual(summary(findDeadExports(program, { entryPoints, testsAreEntryPoints: false })), {
    entries: ['index.ts'],
    unreachable: ['orphan.ts', 'util.test.ts'],
    dead: ['lib.ts:localOnly (local)', 'lib.ts:unused', 'util.ts:Unused', 'util.ts:testedOnly'],
  });
});
