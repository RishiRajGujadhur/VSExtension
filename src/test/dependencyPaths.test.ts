import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { dependencyPathReport, distancesFrom, shortestPaths } from '../navigate/dependencyPaths';
import { normalizePath } from '../analysis/paths';
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

test('distances from a module rank what it depends on', () => {
  const graph = programGraph(virtualProject('navigate', 'src/app.tsx').program());
  const distance = distancesFrom(graph, path.join(src, 'app.tsx'));
  assert.equal(distance.get(normalizePath(path.join(src, 'public.ts'))), 1);
  assert.equal(distance.get(normalizePath(path.join(src, 'utils.ts'))), 2);
  assert.equal(distance.has(normalizePath(path.join(src, 'app.tsx'))), false);
});

test('modules that depend on each other are reported as a cycle', () => {
  const project = virtualProject('navigate', 'src/app.tsx');
  const utils = path.join(src, 'utils.ts');
  project.setText(utils, `import { App } from './app';\nexport const app = App;\n${fs.readFileSync(utils, 'utf8')}`);
  const report = dependencyPathReport(project.program(), path.join(src, 'app.tsx'), utils);
  assert.match(report.warnings[0], /^Circular dependency: utils\.ts also depends on app\.tsx/);
  assert.ok(report.roots.some((r) => r.label === 'Circular: utils.ts depends back on app.tsx' && r.tone === 'error'));
  const plain = dependencyPathReport(virtualProject('navigate', 'src/app.tsx').program(), path.join(src, 'app.tsx'), utils);
  assert.deepEqual(plain.warnings, []);
});

test('each import hop shows its code and finds the usages of what it imports', () => {
  const report = dependencyPathReport(virtualProject('navigate', 'src/app.tsx').program(), path.join(src, 'app.tsx'), path.join(src, 'models.ts'));
  const hop = report.roots.find((r) => r.label === 'Longer runtime path')?.children?.[0].children?.[0];
  assert.equal(hop?.tooltip, "```tsx\nimport { formatArea } from './index';\n```");
  assert.equal(hop?.action?.command, 'tsStructure.semanticUsages');
  assert.equal(hop?.action?.offset, fs.readFileSync(path.join(src, 'app.tsx'), 'utf8').indexOf('formatArea'));
});
