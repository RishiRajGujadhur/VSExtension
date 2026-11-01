import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { copiesReport, duplicatesReport, findDuplicates } from '../inspect/duplicates';
import { fixtures, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/duplicates.ts');

test('copies with renamed variables and different literals are one duplicate group, reported once', () => {
  const sourceFile = virtualProject('inspect', 'src/duplicates.ts').program().getSourceFile(file)!;
  const groups = findDuplicates([sourceFile], { minStatements: 3, minTokens: 30 });
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.fragments.length, 2);
  assert.equal(group.lines, 5);
  assert.deepEqual(
    group.fragments.map((f) => sourceFile.getLineAndCharacterOfPosition(f.start).line + 1),
    [2, 10],
  );
  assert.deepEqual(group.differences, ['total ↔ sum', 'item ↔ parcel', 'items ↔ parcels', '100 ↔ 1000']);
});

test('a different operator or property is not a duplicate', () => {
  const sourceFile = virtualProject('inspect', 'src/duplicates.ts').program().getSourceFile(file)!;
  const groups = findDuplicates([sourceFile], { minStatements: 2, minTokens: 10 });
  assert.ok(groups.every((g) => g.fragments.every((f) => !f.sourceFile.text.slice(f.start, f.end).includes('-='))));
});

test('an empty result says what was searched for', () => {
  const sourceFile = virtualProject('inspect', 'src/duplicates.ts').program().getSourceFile(file)!;
  const report = duplicatesReport([sourceFile], { minStatements: 3, minTokens: 1000 });
  assert.equal(report.roots.length, 0);
  assert.match(report.warnings[0], /^No run of 3 statements and 1000\+ syntax tokens repeats in 1 file\. Lower tsStructure\.duplicates\.minStatements/);
});

test('copies of selected statements are found, with the selection first', () => {
  const sourceFile = virtualProject('inspect', 'src/duplicates.ts').program().getSourceFile(file)!;
  const text = sourceFile.text;
  // The loop and return of totalWeight, selected loosely around the statements.
  const start = text.indexOf('  for (const parcel');
  const end = text.indexOf('}', text.indexOf('return Math.round(sum')) - 1;
  const report = copiesReport([sourceFile], sourceFile, start, end);
  assert.equal(report.title, 'Copies of the selection');
  assert.equal(report.roots[0].label, 'Selection and 1 copy: 4 lines');
  // Each copy can be selected for Extract to function.
  assert.ok(report.roots[0].children?.slice(0, 2).every((c) => c.action?.kind === 'refactor'));
  assert.deepEqual(report.roots[0].children?.map((c) => c.label).slice(0, 2), ['totalWeight · duplicates.ts:11', 'totalPrice · duplicates.ts:3']);
  assert.throws(() => copiesReport([sourceFile], sourceFile, text.indexOf('let total') + 2, text.indexOf('let total') + 5), /Select one or more whole statements/);
});
