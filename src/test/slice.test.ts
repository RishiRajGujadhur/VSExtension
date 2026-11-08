import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { sliceAt } from '../inspect/slice';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/control.ts');

/** The first line of every box in the slice, start and cursor box included. */
function slice(marker: string, direction: 'backward' | 'forward'): string[] {
  const s = sliceAt(virtualProject('inspect', 'src/control.ts'), file, offsetIn(file, marker), direction);
  return s.nodes.map((id) => s.cfg.nodes[id].lines[0]);
}

test('backward slice: the assignments that can reach the value, and the decisions that control them', () => {
  assert.deepEqual(slice('return per|mission;', 'backward'), [
    '!user.active',
    "let permission = 'read'",
    'switch (user.role)',
    "permission = 'write'",
    'sensitive',
    "permission = 'limited'",
    "permission = 'none'",
    'return permission',
  ]);
});

test('backward slice of a loop result includes the loop and the check that skips items', () => {
  assert.deepEqual(slice('return su|m;', 'backward'), ['let sum = 0', 'for (const item of items)', 'item < 0', 'sum += item', 'return sum']);
});

test('forward slice: what reads the value, and what that decides', () => {
  // Everything after `let permission = 'read'` that uses permission: the switch cases only assign it, so only the return reads it.
  assert.deepEqual(slice("let per|mission = 'read'", 'forward'), ["let permission = 'read'", 'return permission']);
  // The sensitive parameter decides whether 'limited' is assigned, which then reaches the return.
  assert.deepEqual(slice('if (sens|itive)', 'forward'), ['sensitive', "permission = 'limited'", 'return permission']);
});
