import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { DeadExportResult, findDeadExports } from '../inspect/deadExports';
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

test('exports unused from the entry points are dead; re-exports and export * keep them alive', () => {
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
