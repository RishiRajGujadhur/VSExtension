import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { describeIntroduceParameter, introduceParameter } from '../refactor/introduceParameter';
import { RefactorError } from '../refactor/types';
import { changedText, fixtures, virtualProject } from './helpers';

const pricing = path.join(fixtures, 'introduce/src/pricing.ts');
const checkout = path.join(fixtures, 'introduce/src/checkout.ts');
const project = () => virtualProject('introduce', 'src/pricing.ts');

/** The range of the `n`th occurrence of `text` in pricing.ts. */
function range(text: string, n = 0): [number, number] {
  const source = fs.readFileSync(pricing, 'utf8');
  let at = -1;
  for (let i = 0; i <= n; i++) at = source.indexOf(text, at + 1);
  assert.ok(at >= 0, `not found: ${text}`);
  return [at, at + text.length];
}

test('describes the selection with a suggested name, type and occurrence count', () => {
  const info = describeIntroduceParameter(project(), pricing, ...range('(1 + 0.2)'));
  assert.equal(info.functionName, 'price');
  assert.equal(info.type, 'number');
  assert.equal(info.occurrences, 2);
});

test('optional mode makes the expression the default value and leaves callers alone', () => {
  const result = introduceParameter(project(), pricing, ...range('(1 + 0.2)'), { name: 'markup', mode: 'optional', replaceAll: true });
  const text = changedText(result, pricing);
  assert.match(text, /price\(base: number, qty: number, markup: number = 1 \+ 0\.2\)/);
  assert.match(text, /const subtotal = base \* qty \* markup;\n  return subtotal \+ base \* qty \* markup;/);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.conflicts, []);
});

test('required mode passes the expression from every caller, translating parameters to arguments', () => {
  const result = introduceParameter(project(), pricing, ...range('base * qty'), { name: 'gross', mode: 'required', replaceAll: true });
  const text = changedText(result, pricing);
  assert.match(text, /price\(base: number, qty: number, gross: number\)/);
  assert.match(text, /const subtotal = gross \* \(1 \+ 0\.2\);\n  return subtotal \+ gross \* \(1 \+ 0\.2\);/);
  const calls = changedText(result, checkout);
  assert.match(calls, /price\(10, 2, 10 \* 2\)/);
  assert.match(calls, /price\(1 \+ 1, 3, \(1 \+ 1\) \* 3\)/);
  assert.deepEqual(result.conflicts, []);
});

test('replacing only the selected occurrence leaves the others', () => {
  const result = introduceParameter(project(), pricing, ...range('(1 + 0.2)', 1), { name: 'markup', mode: 'optional', replaceAll: false });
  const text = changedText(result, pricing);
  assert.match(text, /const subtotal = base \* qty \* \(1 \+ 0\.2\);\n  return subtotal \+ base \* qty \* markup;/);
});

test('symbols not imported at a call site are reported', () => {
  const result = introduceParameter(project(), pricing, ...range('RATE', 1), { name: 'rate', mode: 'required', replaceAll: true });
  assert.match(changedText(result, checkout), /tax\(5, RATE\)/);
  assert.ok(result.conflicts.some((c) => c.message.includes("'RATE' is not in scope")));
});

test("'this' becomes the call's receiver when it is a plain reference", () => {
  const result = introduceParameter(project(), pricing, ...range('this.items'), { name: 'count', mode: 'required', replaceAll: true });
  const calls = changedText(result, checkout);
  assert.match(calls, /cart\.total\(4, cart\.items\)/);
  assert.ok(result.conflicts.some((c) => c.message.includes("Cannot tell what 'this' is")));
});

test('an empty selection uses the expression at the cursor', () => {
  const [start] = range('toUpperCase');
  const info = describeIntroduceParameter(project(), pricing, start, start);
  assert.equal(info.expression, 'name.toUpperCase()');
  assert.equal(info.suggestedName, 'toUpperCase');
});

test('expressions using locals, or names already taken, are rejected', () => {
  assert.throws(() => introduceParameter(project(), pricing, ...range('local', 1), { name: 'x', mode: 'required', replaceAll: false }), /declared inside tax/);
  assert.throws(() => introduceParameter(project(), pricing, ...range('(1 + 0.2)'), { name: 'qty', mode: 'optional', replaceAll: false }), RefactorError);
  assert.throws(() => introduceParameter(project(), pricing, ...range('ty: n'), { name: 'x', mode: 'optional', replaceAll: false }), RefactorError);
});
