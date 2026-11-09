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

test('the program dependence graph links assignments to the reads they reach, and decisions to what they control', async () => {
  const { dependencesOf } = await import('../inspect/dependences');
  const { buildCfg } = await import('../inspect/controlFlow');
  const ts = await import('typescript');
  const source = ts.createSourceFile('pdg.ts', `function f(input: number) {
  let result = input;
  if (input > 10) {
    result = input * 2;
  }
  return result;
}`, ts.ScriptTarget.Latest, true);
  const fn = source.statements[0] as import('typescript').FunctionDeclaration;
  const cfg = buildCfg(fn);
  const box = (text: string) => cfg.nodes.find((n) => n.lines.some((l) => l.includes(text)))!.id;
  const deps = dependencesOf(cfg);
  const data = (from: string, to: string) => deps.data.some((d) => d.from === box(from) && d.to === box(to) && d.name === 'result');
  // Both assignments of result can reach the return; the second only when the condition holds.
  assert.ok(data('let result = input', 'return result'));
  assert.ok(data('result = input * 2', 'return result'));
  assert.ok(deps.control.some((c) => c.from === box('input > 10') && c.to === box('result = input * 2')));
  // The return runs on every path, so the decision doesn't control it.
  assert.ok(!deps.control.some((c) => c.to === box('return result')));
});

test('dependences: parameters come from the start, and changing a property keeps earlier assignments reaching', async () => {
  const { dependencesOf } = await import('../inspect/dependences');
  const { buildCfg } = await import('../inspect/controlFlow');
  const ts = await import('typescript');
  const source = ts.createSourceFile('pdg2.ts', `function g(items: number[], limit: number) {
  const out = [];
  out.push(limit);
  out.length = 2;
  return out;
}`, ts.ScriptTarget.Latest, true);
  const cfg = buildCfg(source.statements[0] as import('typescript').FunctionDeclaration);
  const box = (text: string) => cfg.nodes.find((n) => n.lines.some((l) => l.includes(text)))!.id;
  const deps = dependencesOf(cfg);
  // limit comes from the parameters.
  assert.ok(deps.data.some((d) => d.from === cfg.start && d.name === 'limit' && d.parameter));
  // out.push and out.length change out without replacing it: the declaration still reaches the return.
  const reaching = deps.data.filter((d) => d.to === box('return out') && d.name === 'out').map((d) => d.from);
  assert.ok(reaching.includes(box('const out')), JSON.stringify(deps.data));
});
