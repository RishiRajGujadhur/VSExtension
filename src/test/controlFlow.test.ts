import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { Cfg, buildCfg } from '../inspect/controlFlow';
import { functionAtOffset } from '../structure/util';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/control.ts');

function cfgOf(marker: string): Cfg {
  const project = virtualProject('inspect', 'src/control.ts');
  return buildCfg(functionAtOffset(project.sourceFile(file), offsetIn(file, marker), project.program().getTypeChecker()));
}

/** "from → to [label]" for every edge, by the nodes' first lines. */
function edgesOf(cfg: Cfg): string[] {
  const name = (id: number) => cfg.nodes[id].lines[0];
  return cfg.edges.map((e) => `${name(e.from)} → ${name(e.to)}${e.label ? ` [${e.label}]` : ''}`);
}

test('if, switch with break and default, and early return', () => {
  const cfg = cfgOf('function getPer|mission');
  assert.deepEqual(edgesOf(cfg), [
    'getPermission → !user.active',
    "!user.active → return 'blocked' [yes]",
    "return 'blocked' → end",
    "!user.active → let permission = 'read' [no]",
    "let permission = 'read' → switch (user.role)",
    "switch (user.role) → permission = 'write' [case 'admin']",
    "switch (user.role) → sensitive [case 'member']",
    "sensitive → permission = 'limited' [yes]",
    "switch (user.role) → permission = 'none' [default]",
    "permission = 'write' → return permission",
    "permission = 'limited' → return permission",
    'sensitive → return permission [no]',
    "permission = 'none' → return permission",
    'return permission → end',
  ]);
  assert.ok(!cfg.nodes.some((n) => n.unreachable));
});

test('a for…of loop goes back to its header, and continue skips the rest of the body', () => {
  const cfg = cfgOf('function tot|al');
  const edges = edgesOf(cfg);
  assert.ok(edges.includes('for (const item of items) → item < 0 [each item]'));
  assert.ok(edges.includes('item < 0 → for (const item of items) [yes]'), 'continue goes back to the loop');
  assert.ok(edges.includes('sum += item → for (const item of items)'), 'the body loops back');
  assert.ok(edges.includes('for (const item of items) → return sum [done]'));
  assert.equal(cfg.edges.filter((e) => e.kind === 'back' || e.kind === 'continue').length, 2);
});

test('switch cases without break fall through to the next case', () => {
  const edges = edgesOf(cfgOf('function gra|de'));
  // case >= 90 shares the statements of case >= 80, which falls into case >= 50.
  assert.ok(edges.includes("switch (true) → letter = 'A or B' [case score >= 90]"));
  assert.ok(edges.includes("switch (true) → letter = 'A or B' [case score >= 80]"));
  assert.ok(edges.includes("letter = 'A or B' → letter += '!'"));
  assert.ok(edges.includes("switch (true) → letter += '!' [case score >= 50]"));
  assert.ok(edges.includes('switch (true) → return letter [no case matches]'));
});

test('a labeled break leaves the outer loop', () => {
  const edges = edgesOf(cfgOf('function fi|nd'));
  assert.ok(edges.includes('found = i → return found'), edges.join('\n'));
  assert.ok(edges.includes('let i = 0 → for (let i = 0; i < rows.length; i++)'));
});

test('throw goes to the catch, and both reach finally', () => {
  const edges = edgesOf(cfgOf('function par|se'));
  assert.ok(edges.includes("throw new Error('not a number') → catch (error) [throws]"));
  assert.ok(edges.includes('value = -1 → finally'));
  assert.ok(edges.includes("typeof value !== 'number' → finally [no]"));
  assert.ok(edges.includes("console.log('parsed') → return value"));
});

test('code after a return is unreachable', () => {
  const cfg = cfgOf('function de|ad');
  assert.deepEqual(cfg.nodes.filter((n) => n.unreachable).map((n) => n.lines[0]), ["console.log('never')"]);
});

test('an arrow function with an expression body returns it', () => {
  assert.deepEqual(edgesOf(cfgOf('const dou|ble')), ['double → return n * 2', 'return n * 2 → end']);
});

test('a do…while runs its body, then loops back while the condition holds', () => {
  const edges = edgesOf(cfgOf('function ret|ry'));
  assert.ok(edges.includes('attempts++ → do … while (attempts < 3)'));
  assert.ok(edges.includes('do … while (attempts < 3) → attempts++ [yes]'));
  assert.ok(edges.includes('do … while (attempts < 3) → return attempts [no]'));
});

test('expanding a call splices the called function in, its returns leading to what follows the call', async () => {
  const { controlFlowChart } = await import('../inspect/controlFlowChart');
  const project = virtualProject('inspect', 'src/control.ts');
  const folded = controlFlowChart(project, file, offsetIn(file, 'function bad|ge'));
  const call = folded.nodes.find((n) => n.calls.length)!;
  assert.deepEqual(call.calls.map((c) => `${c.name} ${c.expanded}`), ['getPermission false']);
  assert.equal(folded.paths.length, 1);

  const open = controlFlowChart(project, file, offsetIn(file, 'function bad|ge'), new Set([call.calls[0].key]));
  const name = (id: number) => open.nodes[id].lines[0];
  const edges = open.edges.map((e) => `${name(e.from)} → ${name(e.to)}${e.label ? ` [${e.label}]` : ''}`);
  assert.ok(edges.includes('const permission = getPermission(user, false) → !user.active [calls getPermission]'), edges.join('\n'));
  assert.ok(edges.includes("return 'blocked' → return permission.toUpperCase() [returns]"));
  assert.ok(edges.includes('return permission → return permission.toUpperCase() [returns]'));
  // The spliced boxes belong to getPermission and point into its code; its start and end boxes are left out.
  assert.ok(open.nodes.filter((n) => n.owner === 'getPermission').length >= 8);
  assert.ok(!open.nodes.some((n) => n.owner && (n.kind === 'start' || n.kind === 'end')));
  // Paths now run through the called function.
  assert.equal(open.paths.length, 5);
  assert.ok(open.paths.every((p) => p.ending === 'returns permission.toUpperCase()'));
  assert.equal(open.nodes.find((n) => n.calls.length)!.calls[0].expanded, true);
});
