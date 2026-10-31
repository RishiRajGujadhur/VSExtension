import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { changeSignature, describeFunction } from '../refactor/changeSignature';
import { RefactorError } from '../refactor/types';
import { changedText, fixtures, offsetIn, virtualProject } from './helpers';

const math = path.join(fixtures, 'refactor/src/math.ts');
const use = path.join(fixtures, 'refactor/src/use.ts');
const scaleAt = () => offsetIn(math, 'function |scale');

test('describes parameters, defaults and return type', () => {
  const info = describeFunction(virtualProject('refactor'), math, scaleAt());
  assert.equal(info.name, 'scale');
  assert.deepEqual(info.parameters.map((p) => [p.name, p.type, p.initializer]), [['value', 'number', ''], ['factor', 'number', ''], ['offset', '', '0']]);
  assert.equal(info.returnType, 'number');
});

test('reordering parameters rewrites calls, including nested and multi-line ones', () => {
  const result = changeSignature(virtualProject('refactor'), math, scaleAt(), {
    parameters: [{ originalIndex: 1, name: 'factor' }, { originalIndex: 0, name: 'value' }, { originalIndex: 2, name: 'offset' }],
  });
  assert.match(changedText(result, math), /export function scale\(factor: number, value: number, offset = 0\): number/);
  const out = changedText(result, use);
  assert.match(out, /export const a = scale\(3, 2\);/);
  assert.match(out, /export const b = scale\(4, scale\(2, 1\), 5\);/);
  assert.match(out, /map\(\(x\) => scale\(2, x\)\)/);
  assert.match(out, /scale\(\n  20,\n  10,\n\);/);
  assert.deepEqual(result.conflicts.filter((c) => !c.message.includes('value')), []);
});

test('adding a parameter fills skipped optional arguments with undefined', () => {
  const result = changeSignature(virtualProject('refactor'), math, scaleAt(), {
    parameters: [{ originalIndex: 0, name: 'value' }, { originalIndex: 1, name: 'factor' }, { originalIndex: 2, name: 'offset' }, { name: 'round', type: 'boolean', callValue: 'false' }],
  });
  assert.match(changedText(result, math), /offset = 0, round: boolean\)/);
  const out = changedText(result, use);
  assert.match(out, /scale\(2, 3, undefined, false\)/);
  assert.match(out, /scale\(scale\(1, 2, undefined, false\), 4, 5, false\)/);
});

test('removing a parameter still used in the body is reported as a conflict', () => {
  const result = changeSignature(virtualProject('refactor'), math, scaleAt(), {
    parameters: [{ originalIndex: 0, name: 'value' }, { originalIndex: 1, name: 'factor' }],
  });
  assert.match(changedText(result, use), /export const b = scale\(scale\(1, 2\), 4\);/);
  assert.ok(result.conflicts.some((c) => c.message.includes("'offset' is still used")));
});

test('renaming the function and a parameter updates imports, calls and the body', () => {
  const result = changeSignature(virtualProject('refactor'), math, scaleAt(), {
    name: 'resize',
    parameters: [{ originalIndex: 0, name: 'value' }, { originalIndex: 1, name: 'multiplier' }, { originalIndex: 2, name: 'offset' }],
  });
  const decl = changedText(result, math);
  assert.match(decl, /export function resize\(value: number, multiplier: number, offset = 0\)/);
  assert.match(decl, /return value \* multiplier \+ offset;/);
  const out = changedText(result, use);
  assert.match(out, /import \{ Shape, Square, greet, resize, sum \} from '\.\/math';/);
  assert.match(out, /export const a = resize\(2, 3\);/);
});

test('an interface method change applies to implementations and calls through both', () => {
  const result = changeSignature(virtualProject('refactor'), math, offsetIn(math, '  |area(scale: number): number {'), {
    parameters: [{ originalIndex: 0, name: 'scale' }, { name: 'precision', type: 'number', callValue: '2' }],
  });
  const decl = changedText(result, math);
  assert.match(decl, /area\(scale: number, precision: number\): number;/);
  assert.match(decl, /area\(scale: number, precision: number\): number \{/);
  const out = changedText(result, use);
  assert.match(out, /new Square\(2\)\.area\(3, 2\)/);
  assert.match(out, /shape\.area\(2, 2\)/);
  assert.deepEqual(result.conflicts, []);
});

test('rest parameters keep collecting the remaining arguments', () => {
  const result = changeSignature(virtualProject('refactor'), math, offsetIn(math, 'function |sum'), {
    parameters: [{ name: 'start', type: 'number', callValue: '0' }, { originalIndex: 0, name: 'first' }, { originalIndex: 1, name: 'rest' }],
  });
  assert.match(changedText(result, math), /sum\(start: number, first: number, \.\.\.rest: number\[\]\)/);
  assert.match(changedText(result, use), /sum\(0, 1, 2, 3\)/);
});

test('arrow functions and return types', () => {
  const result = changeSignature(virtualProject('refactor'), math, offsetIn(math, 'const |greet'), {
    parameters: [{ originalIndex: 0, name: 'name' }],
    returnType: 'string',
  });
  assert.match(changedText(result, math), /export const greet = \(name: string\): string => /);
  assert.ok(result.conflicts.some((c) => c.message.includes("'punctuation' is still used")));
});

test('value usages and new type errors are reported, not silently ignored', () => {
  const result = changeSignature(virtualProject('refactor'), math, scaleAt(), {
    parameters: [{ originalIndex: 0, name: 'value' }, { originalIndex: 1, name: 'factor' }, { originalIndex: 2, name: 'offset' }, { name: 'unit', type: 'string' }],
  });
  assert.ok(result.conflicts.some((c) => c.message.includes('stored as a value')));
  assert.ok(result.conflicts.some((c) => c.message.startsWith('New error')));
});

test('invalid specs are rejected', () => {
  assert.throws(
    () => changeSignature(virtualProject('refactor'), math, scaleAt(), { parameters: [{ originalIndex: 0, name: 'a' }, { originalIndex: 1, name: 'a' }] }),
    RefactorError,
  );
  assert.throws(
    () => changeSignature(virtualProject('refactor'), math, offsetIn(math, 'function |sum'), { parameters: [{ originalIndex: 1, name: 'rest' }, { originalIndex: 0, name: 'first' }] }),
    /must stay last/,
  );
});
