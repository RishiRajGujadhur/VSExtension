import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { importCycles } from '../navigate/moduleUsers';
import { ImportEdge, ModuleGraph } from '../navigate/moduleGraph';

/** A graph from "a>b" pairs; a trailing "?" marks a type-only import. */
function graph(...pairs: string[]): ModuleGraph {
  const g: ModuleGraph = { files: new Set(), edges: new Map() };
  for (const pair of pairs) {
    const [from, rest] = pair.split('>');
    const typeOnly = rest.endsWith('?');
    const to = rest.replace('?', '');
    g.files.add(from).add(to);
    const edge: ImportEdge = { from, to, specifier: to, names: [], typeOnly, kind: 'import', line: 0, start: 0, end: 0 };
    g.edges.set(from, [...(g.edges.get(from) ?? []), edge]);
  }
  return g;
}

test('Find Import Cycles: every group of modules that import each other', () => {
  assert.deepEqual(importCycles(graph('a>b', 'b>c', 'c>a', 'c>d')), [['a', 'b', 'c']]);
  assert.deepEqual(importCycles(graph('a>b', 'b>a?')), [], 'type-only imports do not make a cycle');
  assert.deepEqual(importCycles(graph('a>a')), [['a']]);
});

test('Who Imports This File: direct and indirect importers of a module', async () => {
  const { dependents } = await import('../navigate/moduleUsers');
  assert.deepEqual([...dependents(graph('a>b', 'b>c', 'd>c'), 'c')].sort(), [['a', 2], ['b', 1], ['d', 1]]);
});
