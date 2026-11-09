import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { callGraphReport } from '../navigate/callGraph';
import { reactStateReport } from '../inspect/reactState';
import { reportDiagram } from '../structure/diagram';
import { ReportNode } from '../structure/report';
import { virtualProject } from './helpers';

const demo = path.resolve(__dirname, '../../docs/demo/src/orders.ts');
const react = path.resolve(__dirname, '../../test-fixtures/navigate/src/react.tsx');
const at = (file: string, marker: string) => fs.readFileSync(file, 'utf8').indexOf(marker) + 2;
const find = (nodes: readonly ReportNode[] | undefined, label: string): ReportNode | undefined => {
  for (const n of nodes ?? []) {
    if (n.label === label) return n;
    const inner = find(n.children, label);
    if (inner) return inner;
  }
  return undefined;
};
const labels = (n: ReportNode | undefined) => (n?.children ?? []).map((c) => c.label);

test('call graph: callers on one side, callees on the other, several levels deep', () => {
  const { ProjectService } = require('../analysis/project') as typeof import('../analysis/project');
  const report = callGraphReport(new ProjectService().createVirtualProject(demo), demo, at(demo, 'function placeOrder'));
  assert.equal(report.kind, 'callGraph');
  const [calledBy, calls] = report.roots;
  assert.deepEqual(labels(calledBy).sort(), ['main.ts (module scope)', 'quickReorder', 'submitSafely']);
  // A caller's own callers: onCheckoutClick calls submitSafely inside a callback.
  assert.match(find(calledBy.children, 'onCheckoutClick')!.description!, /in a callback/);
  assert.ok(labels(calls).includes('checkoutTotal'));
  assert.ok(labels(find(calls.children, 'checkoutTotal')).includes('applyCoupon'));
  // Calls that can't be followed are counted.
  assert.ok(labels(calls).some((l) => /other call/.test(l)));
  // Drawn with callers left and callees right of the function.
  const diagram = reportDiagram(report);
  assert.equal(diagram.leftCaption, 'Called by');
  assert.ok(diagram.left.some((n) => n.label === 'submitSafely'));
  assert.ok(diagram.right.some((n) => n.label === 'checkoutTotal'));
});

test('React state graph: props, state and hooks, with where each is set, read and depended on', () => {
  const report = reactStateReport(virtualProject('navigate', 'src/react.tsx'), react, at(react, 'function CartPage'));
  assert.equal(report.kind, 'reactState');
  assert.deepEqual(report.roots.map((r) => r.label), ['Props', 'Context', 'State', 'Refs', 'Memoized', 'Custom hooks', 'Effects']);
  assert.deepEqual(labels(find(report.roots, 'Props')), ['userId', 'discount']);
  const query = find(report.roots, 'query')!;
  assert.match(query.description!, /useState · set with setQuery/);
  assert.ok(labels(query).some((l) => /^set in handleSearch/.test(l)));
  assert.ok(labels(query).some((l) => /^triggers useMemo visible/.test(l)));
  assert.ok(labels(query).some((l) => /^read in rendered/.test(l)));
  // useMemo says what it waits for; an effect says when it runs and what it sets.
  assert.ok(labels(find(report.roots, 'visible')).includes('recomputed when items, query change'));
  assert.ok(labels(find(report.roots, 'next')).includes('created once'));
  assert.ok(labels(query).some((l) => /^read in useMemo visible/.test(l)));
  const effects = find(report.roots, 'Effects')!.children!;
  assert.match(effects[0].description!, /when userId changes/);
  assert.ok(labels(effects[0]).includes('sets page'));
  // The second effect reads query without listing it, and cleans up.
  assert.ok(labels(effects[1]).some((l) => /query, missing from the dependencies/.test(l)));
  assert.ok(labels(effects[1]).includes('cleans up when the component unmounts'));
  // Inputs left, the rest right.
  const diagram = reportDiagram(report);
  assert.deepEqual(diagram.left.map((n) => n.label), ['Props', 'Context']);
  assert.ok(diagram.right.some((n) => n.label === 'Effects'));
});

test('React state graph: a function that is not a component says so', () => {
  const { AnalysisError } = require('../analysis/types') as typeof import('../analysis/types');
  const file = path.resolve(__dirname, '../../test-fixtures/navigate/src/state.tsx');
  assert.throws(() => reactStateReport(virtualProject('navigate', 'src/state.tsx'), file, at(file, 'function format')), AnalysisError);
});
