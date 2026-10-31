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

test('data flow rejects symbols that are not values', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  assert.throws(() => dataFlowSteps(project, flow, offsetIn(flow, 'export function check|out')), /not a variable/);
});
