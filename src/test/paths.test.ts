import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { buildCfg } from '../inspect/controlFlow';
import { cfgPaths, describeChoice, explainValue } from '../inspect/paths';
import { functionAtOffset } from '../structure/util';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/control.ts');
const project = () => virtualProject('inspect', 'src/control.ts');

function pathsOf(marker: string) {
  const p = project();
  return cfgPaths(buildCfg(functionAtOffset(p.sourceFile(file), offsetIn(file, marker), p.program().getTypeChecker())));
}

/** "value <- condition, condition | condition" for each value the explanation finds. */
function valuesOf(marker: string): string[] {
  const explanation = explainValue(project(), file, offsetIn(file, marker));
  return explanation.sources.map((s) => `${s.value} <- ${s.ways.map((w) => w.choices.map(describeChoice).join(', ')).join(' | ')}`);
}

test('every path of getPermission, with the branches it takes and what it returns', () => {
  const { paths, truncated } = pathsOf('function getPer|mission');
  assert.equal(truncated, false);
  assert.deepEqual(
    paths.map((p) => `${p.choices.map(describeChoice).join(', ')} => ${p.ending.text}`),
    [
      "not user.active => 'blocked'",
      "user.active, user.role is 'admin' => permission",
      "user.active, user.role is 'member', sensitive => permission",
      "user.active, user.role is 'member', not sensitive => permission",
      "user.active, user.role is none of 'admin', 'member' => permission",
    ],
  );
  assert.ok(paths.every((p) => p.feasible));
});

test('Explain Value Path: the values permission can return, with the conditions for each', () => {
  // 'blocked' returns before permission exists, so it is not one of its values.
  assert.deepEqual(valuesOf('return per|mission;'), [
    "'write' <- user.active, user.role is 'admin'",
    "'limited' <- user.active, user.role is 'member', sensitive",
    "'read' <- user.active, user.role is 'member', not sensitive",
    "'none' <- user.active, user.role is none of 'admin', 'member'",
  ]);
});

test('a path that tests the same unchanged condition both ways is impossible', () => {
  const { paths } = pathsOf('function twi|ce');
  assert.deepEqual(
    paths.map((p) => `${p.choices.map(describeChoice).join(', ')}: ${p.feasible ? 'possible' : p.reason}`),
    ['flag, flag: possible', 'flag, not flag: flag cannot be both true and false here', 'not flag, flag: flag cannot be both true and false here', 'not flag, not flag: possible'],
  );
  // Only the possible paths give values; the impossible ones are listed apart.
  assert.deepEqual(valuesOf('return la|bel;'), ["'first' + ' again' <- flag, flag", "'none' <- not flag, not flag"]);
  assert.equal(explainValue(project(), file, offsetIn(file, 'return la|bel;')).impossible.length, 2);
});

test('compound updates build on the value before them, through switch fall-through', () => {
  assert.deepEqual(valuesOf('return let|ter;'), [
    "'A or B' + '!' <- score >= 80 | score >= 90",
    "'F' + '!' <- score >= 50",
    "'F' <- none of score >= 90, score >= 80, score >= 50 holds",
  ]);
});

test('loops are taken once or skipped, and a parameter starts as the argument', () => {
  assert.deepEqual(valuesOf('return su|m;'), [
    // Skipping the loop and skipping the negative item both leave 0.
    '0 <- each item of items runs, item < 0, each item of items is done | each item of items is done',
    '0 + item <- each item of items runs, not (item < 0), each item of items is done',
  ]);
  assert.deepEqual(valuesOf('(ite|m < 0)'), ['each item of items <- each item of items runs']);
});
