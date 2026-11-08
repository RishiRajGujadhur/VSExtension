import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectionStatusLabel, rowAccessibleLabel, spokenPlace, toneWord } from '../structure/accessibility';

const at = { file: '/repo/src/cart.ts', line: 11, character: 0, endLine: 11, endCharacter: 4 };

test('a result row says its tone in words, not only with the icon color', () => {
  assert.equal(rowAccessibleLabel({ label: 'user.name', description: 'may be undefined here', tone: 'warning', location: at }), 'Warning: user.name, may be undefined here. cart.ts, line 12.');
  assert.equal(toneWord('ok'), 'Safe');
  assert.equal(toneWord(undefined), undefined);
});

test('a result row says what is inside it and what can be done with it', () => {
  assert.equal(rowAccessibleLabel({ label: 'Flows in', children: [{ label: 'a' }, { label: 'b' }] }, { explainable: false }), 'Flows in. 2 rows inside.');
  assert.equal(rowAccessibleLabel({ label: 'x!', tone: 'warning', location: at }, { fixable: true, explainable: true }), 'Warning: x!. cart.ts, line 12. Fix available. Explanation available.');
  // A row that was acted on says so and drops its warning.
  assert.equal(rowAccessibleLabel({ label: 'unused', tone: 'warning' }, { done: 'removed', fixable: true }), 'unused. Done: removed.');
});

test('places are spoken as file and line', () => {
  assert.equal(spokenPlace('C:\\repo\\src\\cart.ts', 0), 'cart.ts, line 1');
});

test('the inspections status bar item is read as counts with their kind', () => {
  assert.equal(inspectionStatusLabel({ error: 2, warning: 1, info: 0 }), 'TypeScript Structure: 2 errors, 1 warning in this file. Open the inspections menu.');
  assert.equal(inspectionStatusLabel({ error: 0, warning: 0, info: 0 }), 'TypeScript Structure: no problems in this file. Open the inspections menu.');
  assert.match(inspectionStatusLabel({ error: 0, warning: 0, info: 0 }, true), /paused/);
});
