import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { ImportEdge, ModuleGraph } from '../navigate/moduleGraph';
import { bundleWeight, bundleWeightReport, formatSize, packageName } from '../navigate/bundleWeight';
import { ProjectService } from '../analysis/project';

const edge = (from: string, to: string, extra: Partial<ImportEdge> = {}): ImportEdge => ({ from, to, specifier: `./${to}`, names: ['x'], typeOnly: false, kind: 'import', line: 0, start: 0, end: 1, ...extra });
const graph = (edges: ImportEdge[]): ModuleGraph => {
  const files = new Set(edges.flatMap((e) => [e.from, e.to]));
  const map = new Map<string, ImportEdge[]>();
  for (const f of files) map.set(f, edges.filter((e) => e.from === f));
  return { files, edges: map };
};

test('bundle weight: each import with what it brings and what only it brings; types and import() left out', () => {
  // main → a → shared, main → b → shared → big; main type-imports t; b loads lazy with import().
  const g = graph([
    edge('main', 'a', { line: 1 }),
    edge('main', 'b', { line: 2 }),
    edge('a', 'shared'),
    edge('b', 'shared'),
    edge('shared', 'big'),
    edge('b', 'onlyB'),
    edge('main', 't', { typeOnly: true }),
    edge('b', 'lazy', { kind: 'dynamic' }),
  ]);
  const size: Record<string, number> = { main: 10, a: 100, b: 200, shared: 300, big: 1000, onlyB: 50, t: 999, lazy: 400 };
  const w = bundleWeight(g, 'main', (f) => size[f]);
  assert.deepEqual(w.modules.map((m) => m.file), ['big', 'shared', 'b', 'a', 'onlyB']);
  assert.equal(w.total, 1650);
  const b = w.direct.find((d) => d.edge.to === 'b')!;
  assert.equal(b.total, 1550);
  assert.equal(b.exclusive, 250, 'shared and big stay through a');
  assert.equal(w.direct[0].edge.to, 'b', 'the import that saves most first');
  assert.deepEqual(w.lazy.map((l) => [l.edge.to, l.total]), [['lazy', 400]]);
  assert.equal(w.typeOnly.length, 1);
  assert.deepEqual(w.modules.find((m) => m.file === 'big')!.via, ['main', 'a', 'shared', 'big']);
});

test('package names and sizes in words', () => {
  assert.equal(packageName('lodash/get'), 'lodash');
  assert.equal(packageName('@scope/pkg/deep'), '@scope/pkg');
  assert.equal(packageName('./local'), undefined);
  assert.equal(packageName('node:fs'), 'fs');
  assert.equal(formatSize(980), '980 B');
  assert.equal(formatSize(12700), '12.4 KB');
});

test('bundle weight report of the demo: imports heaviest first, type-only imports free', () => {
  const main = path.resolve(__dirname, '../../docs/demo/src/main.ts');
  const report = bundleWeightReport(new ProjectService().createVirtualProject(main).program(), main);
  assert.equal(report.kind, 'bundleWeight');
  assert.match(report.description!, /11 modules, [\d.]+ KB of project code/);
  const imports = report.roots.find((r) => r.label === 'Its imports, heaviest first')!;
  assert.equal(imports.children![0].label, "'./orders'");
  assert.equal(imports.children![0].location!.line, 1);
  assert.ok(report.roots.some((r) => /^Type-only imports/.test(r.label)));
});
