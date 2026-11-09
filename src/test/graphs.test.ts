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
  // A call through an interface leads to each implementation; callees are in call order.
  assert.deepEqual(labels(calls).filter((l) => l.endsWith('.charge')), ['CardPayment.charge', 'GiftCardPayment.charge', 'StoreCredit.charge']);
  assert.match(find(calls.children, 'CardPayment.charge')!.description!, /implementation · async/);
  assert.equal(labels(calls)[0], 'checkoutTotal');
  // A function reached twice is drawn once; the top of a chain is an entry point.
  assert.ok(JSON.stringify(calls).includes('shown above'));
  assert.match(find(calledBy.children, 'onCheckoutClick')!.description!, /entry point \(exported\)/);
  assert.match(calledBy.description!, /3 callers in 2 files/);
  // The chart can change its levels and direction.
  assert.deepEqual(report.controls!.map((c) => c.id), ['levels', 'direction']);
  const callersOnly = callGraphReport(new ProjectService().createVirtualProject(demo), demo, at(demo, 'function placeOrder'), { direction: 'callers', depth: 1 });
  assert.deepEqual(callersOnly.roots.map((r) => r.label), ['Called by']);
  assert.ok(callersOnly.roots[0].children!.every((c) => !c.children?.length));
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

test('React state graph: findings, dispatched actions and child components, levels deep', () => {
  const file = path.resolve(__dirname, '../../test-fixtures/navigate/src/react-more.tsx');
  const report = reactStateReport(virtualProject('navigate', 'src/react-more.tsx'), file, at(file, 'function Settings'), { levels: 2 });
  const all = JSON.stringify(report.roots);
  const rows = (label: string) => labels(find(report.roots, label));
  // useReducer: which actions are dispatched, and from where.
  assert.ok(rows('count').some((l) => /^dispatches 'add' in inline handler/.test(l)));
  assert.ok(rows('count').some((l) => /^dispatches 'clear'/.test(l)));
  // Never updated, computed on every render, set during render.
  assert.ok(rows('settings').some((l) => /^never updated/.test(l)));
  assert.ok(rows('settings').some((l) => /useState\(\(\) => loadSettings\(\)\) computes it once/.test(l)));
  assert.ok(rows('mode').some((l) => /^set during render/.test(l)));
  // Effects: derived state, a function dependency, an unread dependency, a new object every render.
  const effects = find(report.roots, 'Effects')!.children!;
  assert.ok(labels(effects[0]).some((l) => /only sets state from other values/.test(l)));
  assert.ok(labels(effects[0]).some((l) => /format is a new function on every render/.test(l)));
  assert.ok(labels(effects[0]).some((l) => /lists mode but doesn't read it/.test(l)));
  assert.ok(labels(effects[1]).some((l) => /\{ name \} is new on every render/.test(l)));
  // A ref read while rendering, a value passed down as a prop.
  assert.ok(rows('renders').some((l) => /renders\.current read during render/.test(l)));
  assert.ok(rows('label').some((l) => /^passed to <Panel title>/.test(l)));
  // Renders: Panel and, a level further, the Badge it renders.
  const renders = find(report.roots, 'Renders')!;
  assert.deepEqual(labels(renders), ['<Panel>']);
  assert.ok(all.includes('<Badge>'));
  assert.ok(labels(renders.children![0]).includes('title ← label'));
  assert.match(report.description!, /warning/);
  // Level 0: no Renders.
  const flat = reactStateReport(virtualProject('navigate', 'src/react-more.tsx'), file, at(file, 'function Settings'), { levels: 0 });
  assert.ok(!flat.roots.some((r) => r.label === 'Renders'));
  assert.equal(flat.controls![0].value, 0);
});
