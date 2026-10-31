import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { listMovableMembers, moduleSpecifier, moveMembers } from '../refactor/moveMembers';
import { RefactorError } from '../refactor/types';
import { changedText, fixtures, virtualProject } from './helpers';

const dir = path.join(fixtures, 'move/src');
const shapes = path.join(dir, 'shapes.ts');
const geometry = path.join(dir, 'geometry.ts');
const app = path.join(dir, 'app.ts');
const index = path.join(dir, 'index.ts');
const project = () => virtualProject('move', 'src/shapes.ts');

test('lists top-level declarations with their kind and export status', () => {
  const members = listMovableMembers(project(), shapes);
  assert.deepEqual(
    members.map((m) => `${m.name}:${m.kind}:${m.exported}`),
    ['TAU:const:false', 'Shape:interface:true', 'circleArea:function:true', 'squareArea:function:true', 'Square:class:true', 'UNIT:const:true', 'ZERO:const:true'],
  );
});

test('moving a function into an existing module updates imports and redirects re-exports', () => {
  const result = moveMembers(project(), shapes, ['squareArea'], geometry, { keepReExport: false });
  assert.deepEqual(result.conflicts, []);
  assert.match(changedText(result, geometry), /export function perimeter[\s\S]*export function squareArea\(side: number\): number/);
  const source = changedText(result, shapes);
  assert.doesNotMatch(source, /function squareArea/);
  assert.match(source, /import \{ squareArea \} from '\.\/geometry';/);
  const consumer = changedText(result, app);
  assert.match(consumer, /from '\.\/geometry'/);
  assert.doesNotMatch(consumer, /squareArea \} from '\.\/shapes'/);
  assert.equal(changedText(result, index), "export { UNIT, circleArea } from './shapes';\nexport { squareArea as sq } from './geometry';\n");
});

test('private dependencies of moved code are exported and imported', () => {
  const result = moveMembers(project(), shapes, ['circleArea'], geometry, { keepReExport: false });
  assert.match(changedText(result, shapes), /export const TAU = Math\.PI \* 2;/);
  assert.match(changedText(result, geometry), /import \{ TAU \} from '\.\/shapes';/);
  assert.deepEqual(result.conflicts, []);
});

test('several non-adjacent declarations move together', () => {
  const result = moveMembers(project(), shapes, ['circleArea', 'Square'], geometry, { keepReExport: false });
  const target = changedText(result, geometry);
  assert.match(target, /function circleArea/);
  assert.match(target, /class Square implements Shape/);
  assert.deepEqual(result.conflicts, []);
});

test('keeping a re-export leaves the source module API unchanged', () => {
  const result = moveMembers(project(), shapes, ['squareArea'], geometry, { keepReExport: true });
  assert.match(changedText(result, shapes), /export \{ squareArea \} from '\.\/geometry';\n$/);
});

test('moving into a new module creates it', () => {
  const circle = path.join(dir, 'circle.ts');
  const result = moveMembers(project(), shapes, ['circleArea'], circle, { keepReExport: false });
  const created = result.changes.find((c) => c.file.endsWith('circle.ts'));
  assert.equal(created?.before, undefined);
  assert.match(created?.after ?? '', /export function circleArea/);
});

test('invalid moves are rejected with an explanation', () => {
  assert.throws(() => moveMembers(project(), shapes, ['UNIT'], geometry, { keepReExport: false }), /same statement/);
  assert.throws(() => moveMembers(project(), shapes, ['nothing'], geometry, { keepReExport: false }), RefactorError);
  assert.throws(() => moveMembers(project(), shapes, ['circleArea'], shapes, { keepReExport: false }), /different module/);
});

test('module specifiers follow the style of the import they replace', () => {
  assert.equal(moduleSpecifier('/p/src/a.ts', '/p/src/lib/b.ts', './x'), './lib/b');
  assert.equal(moduleSpecifier('/p/src/a.ts', '/p/b.ts', './x.js'), '../b.js');
  assert.equal(moduleSpecifier('/p/src/a.ts', '/p/src/lib/index.ts', undefined), './lib');
});
