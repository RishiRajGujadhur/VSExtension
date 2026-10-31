import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { dependencyPathReport, shortestPaths } from '../navigate/dependencyPaths';
import { programGraph } from '../navigate/moduleGraph';
import { fixtures, virtualProject } from './helpers';

const src = path.join(fixtures, 'navigate/src');

test('shortest import paths follow imports and re-exports', () => {
  const graph = programGraph(virtualProject('navigate', 'src/app.tsx').program());
  const paths = shortestPaths(graph, path.join(src, 'app.tsx'), path.join(src, 'models.ts'));
  assert.deepEqual(
    paths.map((p) => p.map((e) => `${path.basename(e.from)}→${path.basename(e.to)}${e.typeOnly ? ' (type)' : ''}`)),
    [['app.tsx→models.ts (type)']],
  );
  const runtime = shortestPaths(graph, path.join(src, 'app.tsx'), path.join(src, 'models.ts'), { runtimeOnly: true });
  // The type-only import is erased; at runtime app.tsx reaches models.ts through the index barrel.
  assert.deepEqual(
    runtime.map((p) => p.map((e) => path.basename(e.to))),
    [['index.ts', 'models.ts']],
  );
});

test('the report explains type-only shortest paths and the longer runtime path', () => {
  const report = dependencyPathReport(virtualProject('navigate', 'src/app.tsx').program(), path.join(src, 'app.tsx'), path.join(src, 'models.ts'), path.join(fixtures, 'navigate'));
  assert.deepEqual(report.roots.map((r) => r.label), [
    'src/app.tsx depends on src/models.ts',
    'Longer runtime path',
    'Shortest paths',
    'Modules on these paths that import models.ts directly',
  ]);
  assert.equal(report.roots[1].children?.[0].label, 'Path 1: app.tsx → index.ts → models.ts');
  assert.equal(report.roots[1].children?.[0].children?.[0].label, "src/app.tsx: import { formatArea } from './index'");

  const none = dependencyPathReport(virtualProject('navigate', 'src/app.tsx').program(), path.join(src, 'models.ts'), path.join(src, 'app.tsx'));
  assert.deepEqual(none.roots.map((r) => r.label).slice(0, 2), ['models.ts does not depend on app.tsx', 'But app.tsx depends on models.ts']);
});
