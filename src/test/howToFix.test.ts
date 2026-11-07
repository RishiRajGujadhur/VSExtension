import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { howToFix } from '../structure/howToFix';

test('How to fix is a collapsed group of tips', () => {
  const group = howToFix(['Check it first.', 'Give it a default.']);
  assert.equal(group.label, 'How to fix');
  assert.equal(group.description, '2 tips');
  assert.equal(group.expanded, undefined);
  assert.deepEqual(group.children?.map((c) => c.label), ['Check it first.', 'Give it a default.']);
});
