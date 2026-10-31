import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { planFileDelete, planSafeDelete } from '../refactor/safeDelete';
import { changedText, fixtures, offsetIn, virtualProject } from './helpers';

const dir = path.join(fixtures, 'safedelete/src');
const lib = path.join(dir, 'lib.ts');
const index = path.join(dir, 'index.ts');
const consumer = path.join(dir, 'consumer.ts');
const project = () => virtualProject('safedelete', 'src/lib.ts');

test('an unused function is deleted with its doc comment, and imports and re-exports of it are removed', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, 'function |unused'));
  assert.equal(plan.kind, 'function');
  assert.ok(plan.usages.every((u) => u.removable));
  assert.equal(plan.usages.length, 2);
  const libText = changedText(plan.result, lib);
  assert.doesNotMatch(libText, /function unused\(|Nobody/);
  assert.match(libText, /export const first = 1, second = 2;\n\nexport function usedOnce/);
  assert.equal(changedText(plan.result, index), "export { Box, usedOnce } from './lib';\n");
  assert.match(changedText(plan.result, consumer), /^import \{ Box, type Options, format, usedOnce \} from '\.\/lib';/);
});

test('a used function lists its blocking usages separately from removable ones', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, 'function |usedOnce'));
  const blocking = plan.usages.filter((u) => !u.removable);
  assert.equal(blocking.length, 1);
  assert.match(blocking[0].lineText, /usedOnce\(\) \+ new Box/);
  assert.equal(blocking[0].location.file, consumer.replace(/\\/g, '/'));
  assert.equal(plan.exported, true);
});

test('recursive self-references do not block deletion', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, 'function |countdown'));
  assert.deepEqual(plan.usages, []);
  assert.doesNotMatch(changedText(plan.result, lib), /countdown/);
});

test('one declarator of a multi-variable statement is removed on its own', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, '|second = 2'));
  assert.match(changedText(plan.result, lib), /^export const first = 1;\n/);
});

test('class members are deleted with their comments; used members are blocked', () => {
  const unusedPlan = planSafeDelete(project(), lib, offsetIn(lib, '|unusedMethod'));
  assert.deepEqual(unusedPlan.usages, []);
  const text = changedText(unusedPlan.result, lib);
  assert.doesNotMatch(text, /unusedMethod|Not called/);
  assert.match(text, /export class Box \{\n  usedMethod\(\): number/);

  const usedPlan = planSafeDelete(project(), lib, offsetIn(lib, '  |usedMethod(): number'));
  assert.equal(usedPlan.usages.filter((u) => !u.removable).length, 1);
});

test('type-only usages block deletion of an interface', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, 'interface |Options'));
  assert.equal(plan.usages.filter((u) => !u.removable).length, 1);
});

test('deleting an unused parameter removes the argument at every call', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, '|unusedFlag'));
  assert.deepEqual(plan.usages, []);
  assert.match(changedText(plan.result, lib), /format\(value: string, prefix: string\)/);
  assert.match(changedText(plan.result, consumer), /format\('x', '> '\)/);
});

test('deleting a parameter used in the body lists those uses', () => {
  const plan = planSafeDelete(project(), lib, offsetIn(lib, '|prefix: string'));
  assert.equal(plan.usages.length, 1);
  assert.match(plan.usages[0].lineText, /return prefix \+ value/);
});

test('a file nothing imports is deleted without usages', () => {
  const plan = planFileDelete(project(), path.join(dir, 'orphan.ts'));
  assert.deepEqual(plan.usages, []);
  assert.deepEqual(plan.result.changes.map((c) => [path.basename(c.file), c.after]), [['orphan.ts', undefined]]);
});

test('an imported file lists its importers and removes the imports when deleted anyway', () => {
  const plan = planFileDelete(project(), path.join(dir, 'helper.ts'));
  assert.equal(plan.usages.length, 1);
  assert.match(plan.usages[0].lineText, /from '\.\/helper'/);
  assert.doesNotMatch(changedText(plan.result, consumer), /helper'/);
});
