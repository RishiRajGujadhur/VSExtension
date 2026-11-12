import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, virtualProject } from './helpers';
import { normalizePath } from '../analysis/paths';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { assertionAuditReport } from '../inspect/assertionAudit';
import { duplicatesReport } from '../inspect/duplicates';
import { mutationReport } from '../inspect/effects';

const file = (name: string) => normalizePath(path.join(fixtures, 'inspect', name));
const shaped = (kind: string, roots: ReportNode[]): Report => ({ kind, title: kind, description: 'summary', roots, warnings: [], fileHashes: {} });
const find = (report: Report, test: (n: ReportNode) => boolean) => {
  let found: ReportNode | undefined;
  forEachReportNode(report.roots, (n) => { if (!found && test(n)) found = n; });
  return found;
};

test('type assertions: where to start, assertions to one type, as any explained, unnecessary ones safe to delete', () => {
  const program = virtualProject('inspect', 'src/assertions.ts').program();
  const r = polishReport(assertionAuditReport(program, [program.getSourceFile(file('src/assertions.ts'))!]));
  assert.match(r.roots[0].label, /^Start with: /);
  assert.ok(r.warnings.some((w) => /3 assertions to Circle/.test(w)));
  assert.ok(find(r, (n) => /as any/.test(n.label) && /turns off type checking/.test(n.description ?? '')));
  assert.ok(find(r, (n) => /safe to delete/.test(n.description ?? '')));
});

test('déjà vu: what the extracted function needs, and the lines that could go', () => {
  const program = virtualProject('inspect', 'src/duplicates.ts').program();
  const r = polishReport(duplicatesReport([program.getSourceFile(file('src/duplicates.ts'))!], { minStatements: 2, minTokens: 10 }));
  assert.match(r.roots[0].description!, /extract a function with 4 parameters/);
  assert.match(r.description!, /about 5 lines could go/);
});

test('ghost exports: whole files, local-only exports, tests as entry points', () => {
  const r = polishReport(shaped('deadExports', [
    { label: 'Unreachable modules', children: [{ label: 'orphan.ts', children: [{ label: 'orphan', description: 'unused' }] }] },
    { label: 'Exported but only used locally', children: [{ label: 'lib.ts', children: [{ label: 'localOnly', description: 'used only inside this module' }] }] },
    { label: 'Entry points', description: '2, including test files', children: [{ label: 'index.ts' }] },
  ]));
  assert.ok(find(r, (n) => n.label === 'orphan.ts' && /whole file may be unused/.test(n.description ?? '')));
  assert.ok(find(r, (n) => n.label === 'localOnly' && /drop the export keyword/.test(n.description ?? '')));
  assert.match(r.roots[2].description!, /anything a test imports counts as used/);
});

test('pattern spotting: what each pattern is, risks marked; none said plainly', () => {
  const r = polishReport(shaped('patterns', [{ label: 'Shared module state', children: [{ label: 'x' }] }, { label: 'Strategy', children: [{ label: 'y' }] }]));
  assert.equal(r.roots[0].tone, 'warning');
  assert.match(r.roots[1].description!, /interchangeable implementations/);
  assert.equal(polishReport(shaped('patterns', [])).roots[0].label, 'No patterns found');
});

test('shared state changes: calls away, an object’s own state, shared variables counted', () => {
  const demo = path.resolve(__dirname, '../../docs/demo/src');
  const { ProjectService } = require('../analysis/project');
  const program = new ProjectService().createVirtualProject(path.join(demo, 'orders.ts')).program();
  const files = program.getSourceFiles().filter((f: { fileName: string }) => f.fileName.includes('/docs/demo/src/'));
  const r = polishReport(mutationReport(program, normalizePath(path.join(demo, 'cart.ts')), undefined, files));
  assert.ok(find(r, (n) => /4 calls away/.test(n.description ?? '')));
  assert.ok(find(r, (n) => /^this\b/.test(n.label) && n.tone === 'info'));
  assert.match(r.description!, /3 shared variables/);
});

test('inspect code: severities and the busiest file in the summary; none said plainly', () => {
  const r = polishReport(shaped('inspectCode', [
    { label: 'Missing await', children: [
      { label: 'a.ts', children: [{ label: 'x', tone: 'warning' }, { label: 'y', tone: 'warning' }] },
      { label: 'b.ts', children: [{ label: 'z', tone: 'error' }] },
    ] },
  ]));
  assert.match(r.description!, /1 error, 2 warnings/);
  assert.match(r.description!, /busiest file: a\.ts \(2\)/);
  assert.equal(polishReport(shaped('inspectCode', [])).roots[0].label, 'No problems found');
});
