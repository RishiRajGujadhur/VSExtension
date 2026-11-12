import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { exceptionFlowReport } from '../inspect/exceptionFlow';
import { rejectionReport } from '../inspect/rejections';
import { sideEffectReport } from '../inspect/effects';

const file = (name: string) => path.join(fixtures, 'inspect', name);
const find = (report: Report, test: (n: ReportNode) => boolean) => {
  let found: ReportNode | undefined;
  forEachReportNode(report.roots, (n) => { if (!found && test(n)) found = n; });
  return found;
};

test('error paths: same messages warned, how deep, plain Error only; nothing thrown said plainly', () => {
  const ex = file('src/exceptions.ts');
  const r = polishReport(exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), ex, offsetIn(ex, 'function check|Form')));
  assert.ok(r.warnings.some((w) => /2 errors have the same message 'empty'/.test(w)));
  assert.ok(find(r, (n) => /2 calls deep/.test(n.description ?? '')));
  assert.match(r.roots.find((n) => n.label === 'Error types')!.description!, /only plain Error/);
  const calm = polishReport(exceptionFlowReport(virtualProject('inspect', 'src/exceptions.ts'), ex, offsetIn(ex, 'function bo|ot')));
  assert.equal(calm.roots[0].label, 'No error can leave boot');
  assert.ok(!calm.roots.some((n) => n.label === 'How to fix'));
});

test('promise rejections: swallowed counted, causes kept, the fire-and-forget tip first; non-async said plainly', () => {
  const rj = file('src/rejections.ts');
  const r = polishReport(rejectionReport(virtualProject('inspect', 'src/rejections.ts'), rj, offsetIn(rj, 'async function sa|ve(')));
  assert.match(r.description!, /1 swallowed/);
  assert.ok(find(r, (n) => /keeps the original error as its cause/.test(n.description ?? '')));
  assert.match(r.roots.find((n) => n.label === 'How to fix')!.children![0].label, /fire and forget/);
  const plain = polishReport(rejectionReport(virtualProject('inspect', 'src/rejections.ts'), rj, offsetIn(rj, 'function fireAnd|Forget')));
  assert.equal(plain.roots.length, 1);
  assert.match(plain.roots[0].label, /not async/);
});

test('side effects: a fix for each kind, pure functions told what that allows', () => {
  const ef = file('src/effects.ts');
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const r = polishReport(sideEffectReport(program, ef, offsetIn(ef, 'function tra|ck')));
  assert.ok(find(r, (n) => /^How to fix: pass the clock/.test(n.label)));
  assert.ok(find(r, (n) => /^How to fix: callers see the change/.test(n.label)));
  const pure = polishReport(sideEffectReport(program, ef, offsetIn(ef, 'function pu|re')));
  assert.match(pure.roots[0].description!, /safe to cache/);
});
