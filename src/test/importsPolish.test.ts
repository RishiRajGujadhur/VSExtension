import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, virtualProject } from './helpers';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { cyclesReport, dependentsReport } from '../navigate/moduleUsers';
import { dependencyPathReport } from '../navigate/dependencyPaths';

const src = path.join(fixtures, 'navigate', 'src');
const shaped = (kind: string, roots: ReportNode[], warnings: string[] = []): Report => ({ kind, title: kind, description: 'summary', roots, warnings, fileHashes: {} });
const find = (report: Report, test: (n: ReportNode) => boolean) => {
  let found: ReportNode | undefined;
  forEachReportNode(report.roots, (n) => { if (!found && test(n)) found = n; });
  return found;
};

test('who imports this: tests last and counted, barrels named; nothing imports it said plainly', () => {
  const program = virtualProject('navigate', 'src/app.tsx').program();
  const r = polishReport(dependentsReport(program, path.join(src, 'models.ts'), path.join(fixtures, 'navigate')));
  const direct = r.roots.find((g) => /^Import it directly/.test(g.label))!.children!;
  assert.equal(direct[direct.length - 1].label, 'shapes.test.ts');
  assert.match(r.description!, /1 test among them/);
  assert.ok(find(r, (n) => n.label === 'index.ts' && /barrel/.test(n.description ?? '')));
  assert.equal(polishReport(shaped('dependents', [])).roots[0].label, 'Nothing imports it');
});

test('import loops: none said plainly; shortest loops first, modules counted', () => {
  const program = virtualProject('navigate', 'src/app.tsx').program();
  const calm = polishReport(cyclesReport(program, path.join(fixtures, 'navigate')));
  assert.equal(calm.roots[0].label, 'No import loops');
  assert.deepEqual(calm.warnings, []);
  const loops = polishReport(shaped('cycles', [{ label: 'a.ts ⇄ b.ts ⇄ c.ts', children: [] }, { label: 'd.ts ⇄ e.ts', children: [] }]));
  assert.equal(loops.roots[0].label, 'd.ts ⇄ e.ts');
  assert.match(loops.roots[0].description!, /easiest kind to break/);
  assert.match(loops.description!, /5 modules involved/);
});

test('why this import: type-only paths counted, the import to change to break the runtime path', () => {
  const program = virtualProject('navigate', 'src/app.tsx').program();
  const r = polishReport(dependencyPathReport(program, path.join(src, 'app.tsx'), path.join(src, 'models.ts'), path.join(fixtures, 'navigate')));
  assert.match(r.description!, /1 type-only/);
  assert.ok(find(r, (n) => /remove or move this import/.test(n.description ?? '')));
});

test('import changes since: the net change, tests imported by code, type-only imports', () => {
  const r = polishReport(shaped('graphDiff', [
    { label: 'Added imports', children: [{ label: 'src/a.ts', children: [{ label: '→ src/a.test.ts', description: 'helper' }, { label: '→ src/types.ts', description: 'type Shape' }] }] },
    { label: 'Removed imports', children: [{ label: 'src/b.ts', children: [{ label: '→ src/c.ts', description: 'x' }] }] },
  ]));
  assert.match(r.description!, /net \+1 imports/);
  assert.ok(find(r, (n) => /code imports a test file/.test(n.description ?? '') && n.tone === 'warning'));
  assert.ok(find(r, (n) => /type only: no run-time cost/.test(n.description ?? '')));
});
