import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { findDuplicates } from '../inspect/duplicates';
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
