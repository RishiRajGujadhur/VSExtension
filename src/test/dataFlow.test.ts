import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { dataFlowReport, dataFlowSteps } from '../inspect/dataFlow';
import { fixtures, offsetIn, virtualProject } from './helpers';

const flow = path.join(fixtures, 'inspect/src/flow.ts');

test('data flow lists definitions, updates, checks, mutations and hand-offs in order', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const { steps } = dataFlowSteps(project, flow, offsetIn(flow, 'let to|tal'));
  assert.deepEqual(
    steps.map((s) => `${s.kind} ${s.label}`),
    [
      'declaration = 0',
      'update += item',
      'condition checked: if (total > 100)',
      'write = total * 0.9',
      'read read: total * 0.9',
      'argument → items.push(…)',
      'argument → applyTax(…) as amount',
    ],
  );
  assert.equal(steps[0].type, 'number');
});

test('data flow of a parameter shows the values call sites pass in', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'applyTax(am|ount'));
  const incoming = report.roots.find((r) => r.label === 'Incoming values from call sites');
  assert.ok(incoming);
  assert.deepEqual(incoming.children?.map((c) => c.label), ['total', '5']);
  assert.ok(report.fileHashes[incoming.children![0].location!.file]);
});

test('data flow steps show their line and type', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const checkout = report.roots.find((r) => r.label.startsWith('checkout'));
  assert.equal(checkout?.description, 'flow.ts · 3 writes, 1 check, 2 hand-offs, 1 read');
  assert.equal(checkout?.children?.[0].description, 'line 6 · number · at cursor');
  // Later steps have the declared type, so it is not repeated.
  assert.equal(checkout?.children?.[1].description, 'line 8');
});

test('hand-offs can be followed into the called function', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const handOff = report.roots.flatMap((r) => r.children ?? []).find((c) => c.label === '→ applyTax(…) as amount');
  const action = handOff?.action as { kind: string; command: string; file: string; offset: number };
  assert.equal(action.kind, 'follow');
  assert.equal(action.command, 'tsStructure.dataFlow');
  assert.equal(action.offset, offsetIn(flow, 'applyTax(|amount'));
});

test('data flow marks the step at the cursor', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'total = to|tal * 0.9'));
  const focused = report.roots.flatMap((r) => r.children ?? []).filter((c) => c.focus);
  assert.deepEqual(
    focused.map((c) => `${c.label} (${c.description})`),
    ['read: total * 0.9 (line 11 · at cursor)'],
  );
});

test('data flow shows types where narrowing changes them', () => {
  const nullable = path.join(fixtures, 'inspect/src/nullable.ts');
  const project = virtualProject('inspect', 'src/nullable.ts');
  const report = dataFlowReport(project, nullable, offsetIn(nullable, 'const us|er = findUser'));
  const descriptions = report.roots.flatMap((r) => r.children ?? []).map((c) => c.description);
  assert.equal(descriptions[0], 'line 28 · User | undefined · at cursor');
  assert.ok(descriptions.some((d) => d?.endsWith(' · User')), descriptions.join(', '));
});

test('data flow rejects symbols that are not values', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  assert.throws(() => dataFlowSteps(project, flow, offsetIn(flow, 'export function check|out')), /not a variable/);
});
