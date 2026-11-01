import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { cycles, diffGraphs, graphDiffReport, filesAtRef, gitRoot, graphOf, workingTreeFiles } from '../navigate/graphDiff';
import { fixtures } from './helpers';

const options = { module: 99, moduleResolution: 100, jsx: 1, allowJs: true };

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-graph-'));
  fs.cpSync(path.join(fixtures, 'navigate'), dir, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '-A');
  run('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base');
  return dir;
}

test('a Git revision and the working tree are compared module by module', () => {
  const dir = repo();
  try {
    // A new cycle, a removed import and a new module.
    fs.appendFileSync(path.join(dir, 'src/models.ts'), "\nimport { counter } from './utils';\nexport const seen = counter;\n");
    fs.writeFileSync(path.join(dir, 'src/public.ts'), 'export const nothing = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/extra.ts'), "import { bump } from './utils';\nbump();\n");

    const root = gitRoot(dir);
    const before = graphOf(filesAtRef(root, 'HEAD', root), options);
    const afterFiles = workingTreeFiles(root, () => undefined);
    const diff = diffGraphs(before, graphOf(afterFiles, options), root);

    assert.deepEqual(diff.addedModules, ['src/extra.ts']);
    assert.deepEqual(diff.removedModules, []);
    assert.deepEqual(diff.addedEdges.map((e) => `${e.from} → ${e.to}`).sort(), ['src/extra.ts → src/utils.ts', 'src/models.ts → src/utils.ts']);
    assert.deepEqual(diff.removedEdges.map((e) => `${e.from} → ${e.to}`), ['src/public.ts → src/index.ts']);
    assert.deepEqual(diff.newCycles, [['src/models.ts', 'src/utils.ts']]);
    assert.deepEqual(diff.newCycleEdges[0].map((e) => `${e.from} → ${e.to}`).sort(), ['src/models.ts → src/utils.ts', 'src/utils.ts → src/models.ts']);
    // utils.ts imports models.ts only as a type, so this cycle disappears at runtime.
    assert.deepEqual(diff.newCycleAtRuntime, [false]);
    const report = graphDiffReport(diff, afterFiles, root, 'HEAD', { repo: root, ref: 'HEAD' });
    const added = report.roots.find((r) => r.label === 'Added imports')?.children?.[0];
    assert.equal(added?.action?.kind, 'compareRevision');
    assert.equal(added?.action?.ref, 'HEAD');
    const cycle = report.roots[0].children?.[0];
    assert.ok(cycle?.children?.every((c) => c.location), 'cycle edges open their import');
    const utilsFanIn = diff.fanIn.find((f) => f.module === 'src/utils.ts');
    assert.equal(utilsFanIn?.after, (utilsFanIn?.before ?? 0) + 2);
    assert.deepEqual(utilsFanIn?.added.sort(), ['src/extra.ts', 'src/models.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cycles are strongly connected modules, optionally ignoring type-only imports', () => {
  const dir = repo();
  try {
    fs.appendFileSync(path.join(dir, 'src/models.ts'), "\nimport { counter } from './utils';\nexport const seen = counter;\n");
    const graph = graphOf(workingTreeFiles(dir, () => undefined), options);
    assert.equal(cycles(graph).length, 1);
    // utils.ts imports models.ts only for types, so there is no runtime cycle.
    assert.equal(cycles(graph, true).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
