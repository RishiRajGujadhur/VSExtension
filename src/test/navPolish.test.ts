import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { ProjectService } from '../analysis/project';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { semanticUsagesReport } from '../navigate/usages';
import { callGraphReport } from '../navigate/callGraph';
import { argumentFlowReport } from '../navigate/argumentFlow';
import { hierarchyReport, overrideImpactReport } from '../navigate/hierarchy';
import { reexportChainReport } from '../navigate/reexports';

const demo = path.resolve(__dirname, '../../docs/demo/src');
const nav = (name: string) => path.join(fixtures, 'navigate', name);
const find = (report: Report, test: (n: ReportNode) => boolean) => {
  let found: ReportNode | undefined;
  forEachReportNode(report.roots, (n) => { if (!found && test(n)) found = n; });
  return found;
};

test('find usages: no leading dot, repeated rows once, renames and load-time calls, files outside tests', () => {
  const pricing = path.join(demo, 'pricing.ts');
  const r = polishReport(semanticUsagesReport(new ProjectService().createVirtualProject(pricing), pricing, offsetIn(pricing, 'calculateSub|total(items')));
  forEachReportNode(r.roots, (n) => assert.doesNotMatch(n.description ?? '', /^\s*·/));
  const exportsGroup = r.roots.find((g) => /^Exports/.test(g.label))!;
  assert.equal(exportsGroup.children![0].children!.length, 1);
  assert.ok(find(r, (n) => /renamed to subtotal/.test(n.description ?? '')));
  assert.ok(find(r, (n) => /runs when the module loads/.test(n.description ?? '')));
  assert.match(r.description!, /used in 2 files outside tests/);
});

test('callers and calls: entry points counted once, async calls, implementations', () => {
  const orders = path.join(demo, 'orders.ts');
  const r = polishReport(callGraphReport(new ProjectService().createVirtualProject(orders), orders, offsetIn(orders, 'function place|Order')));
  assert.match(r.description!, /reached from 2 entry points/);
  assert.match(r.roots.find((g) => g.label === 'Calls')!.description!, /6 async/);
  assert.ok(find(r, (n) => /one of 3: which runs depends on the object/.test(n.description ?? '')));
});

test('arguments passed in: how deep, computed values; a union type for a few string literals', () => {
  const flow = nav('src/flow.tsx');
  const r = polishReport(argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), flow, offsetIn(flow, 'page(na|me: string)')));
  assert.match(r.roots.find((g) => g.label === 'Where the value goes')!.description!, /calls deep/);
  assert.ok(find(r, (n) => n.label === 'user.name' && /computed at the call/.test(n.description ?? '')));
  const shaped = polishReport({ kind: 'argumentFlow', title: 'Propagation of mode', description: 'x', warnings: [], fileHashes: {}, roots: [{ label: 'Values that can arrive', children: [{ label: "'read'" }, { label: "'write'" }] }, { label: 'Where the value goes', children: [] }] });
  assert.ok(shaped.roots.some((n) => /Always one of 'read', 'write'/.test(n.label) && /'read' \| 'write'/.test(n.description ?? '')));
  assert.ok(find(shaped, (n) => n.label === 'Not used inside the function'));
});

test('family tree and override reach: depth, super calls, members not overridden, signature changes', () => {
  const models = nav('src/models.ts');
  const tree = polishReport(hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ba|se')));
  assert.match(tree.description!, /2 levels deep/);
  assert.match(tree.roots.find((g) => g.label === 'Members')!.description!, /2 overrides call super/);
  assert.ok(find(tree, (n) => n.label === 'name' && /not overridden/.test(n.description ?? '')));
  const reach = polishReport(overrideImpactReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'abstract ar|ea')));
  assert.ok(find(reach, (n) => /a change to the signature reaches it/.test(n.description ?? '')));
  assert.match(reach.description!, /in \d+ files/);
});

test('re-export trail: renames named, re-exports nobody imports', () => {
  const app = nav('src/app.tsx');
  const text = require('fs').readFileSync(app, 'utf8') as string;
  const r = polishReport(reexportChainReport(virtualProject('navigate', 'src/app.tsx'), app, text.indexOf('import') + 10));
  assert.ok(find(r, (n) => /renamed from Square/.test(n.description ?? '') && /^3\./.test(n.label)));
  assert.ok(find(r, (n) => /this re-export could go/.test(n.description ?? '')));
});
