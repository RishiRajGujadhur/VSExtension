import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeBoxEdit, describeEdit, describeFileChange, describeFunctionChange, differingSpan, speakable } from '../reel/describe';
import { standaloneCharts } from '../inspect/controlFlowChart';
import { compareCharts } from '../inspect/flowCompare';

test('Change describer: a line changed in place says what became what', () => {
  assert.deepEqual(differingSpan('sum = sum * 0.9;', 'sum = sum * 0.8;'), ['0.9', '0.8']);
  assert.equal(describeEdit('sum = sum * 0.9;', 'sum = sum * 0.8;'), 'Changes 0.9 to 0.8 in sum = sum * 0.8.');
  assert.equal(describeEdit('check(a !== b);', 'check((a ?? 1) !== b);'), 'Changes a to (a ?? 1) in check((a ?? 1) !== b).');
  assert.equal(describeEdit('f(a);', 'f(a, b);'), 'Adds , b to f(a, b).');
});

test('Change describer: boxes that gained a helper or a call, comments left out', () => {
  assert.equal(describeBoxEdit('const a = 1;', 'const a = 1;\nfunction sizeOf(x) {'), 'Adds a helper function, sizeOf().');
  assert.equal(describeBoxEdit('init();', 'init();\n// track it\ntrackWindowState(win);\nitems.map(f);'), 'Now calls trackWindowState().');
  assert.equal(describeBoxEdit('init();\nstart(panel);', 'init();'), 'No longer calls start().');
});

test('Change describer: a guard, a changed value and a new call in one function', async () => {
  const file = 'c:/demo/a.ts';
  const before = 'function pay(items: number[]) {\n  let sum = 0;\n  sum = sum * 0.9;\n  return sum;\n}';
  const after = 'function pay(items: number[]) {\n  if (!items.length) throw new Error("empty");\n  let sum = 0;\n  sum = sum * 0.8;\n  audit(sum);\n  return sum;\n}';
  const old = standaloneCharts(file, before)(10);
  const now = standaloneCharts(file, after)(10);
  const sentences = describeFunctionChange('pay', now, compareCharts(old, now), 4, [
    { kind: 'del', text: '  sum = sum * 0.9;', span: [14, 17] },
    { kind: 'add', text: '  sum = sum * 0.8;', span: [14, 17] },
    { kind: 'add', text: '  audit(sum);' },
  ]);
  assert.deepEqual(sentences, ['Throws Error("empty") when !items.length.', 'Changes 0.9 to 0.8 in sum = sum * 0.8.', 'Now calls audit().', '2 new paths; 1 path no longer taken.']);
  // A function that was not there.
  const fresh = describeFunctionChange('pay', now, compareCharts(undefined, now));
  assert.deepEqual(fresh, ['Adds a new function, pay, with 1 decision and 2 paths.', 'It creates Error and calls audit().']);
});

test('Change describer: files, by their imports and exports', () => {
  assert.deepEqual(describeFileChange('src/a.ts', ["import { retry } from './retry';", 'export function charge() {'], ["import { old } from './old';"], false), [
    'Imports retry from ./retry.',
    'No longer imports old from ./old.',
    'Exports charge.',
  ]);
  assert.deepEqual(describeFileChange('src/b.ts', ['export const x = 1;', 'b'], [], true), ['Adds a new file, b.ts, with 2 lines.', 'Exports x.']);
});

test('Change describer: captions read aloud say operators as words and split names', () => {
  assert.equal(speakable('place(): Adds a check: !below && above.'), 'place: Adds a check: not below and above.');
  assert.equal(speakable('Now calls trackWindowState().'), 'Now calls track Window State.');
  assert.equal(speakable('Changes a ?? b to a === b.'), 'Changes a or else b to a equals b.');
});
