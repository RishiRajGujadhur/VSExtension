import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { dataFlowReport } from '../inspect/dataFlow';
import { reportDiagram } from '../structure/diagram';
import { Report } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const flow = path.join(fixtures, 'inspect/src/flow.ts');

test('a data flow diagram has the variable in the middle, Flows in on the left and Flows out on the right', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  for (const byDirection of [true, false]) {
    const diagram = reportDiagram(dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'), { byDirection }));
    assert.equal(diagram.center.label, 'total');
    assert.equal(diagram.leftCaption, 'Flows in');
    // The assignments, with what each is computed from, point into the variable.
    assert.ok(diagram.left.some((n) => n.label === '= 0'));
    assert.ok(diagram.right.some((n) => n.label === '→ applyTax(…) as amount'));
    // Next only suggests other analyses, so it is not drawn.
    assert.ok(![...diagram.left, ...diagram.right].some((n) => n.label === 'Next'));
    // The groups that only fold the results view are not drawn; their functions are.
    assert.ok(![...diagram.left, ...diagram.right].some((n) => n.label.startsWith('Where it is')));
    assert.ok(diagram.right.some((n) => n.label.startsWith('checkout')));
  }
});

test('by function, a function that only writes the value is drawn on the incoming side', () => {
  const at = (line: number) => ({ file: '/a.ts', line, character: 0, endLine: line, endCharacter: 1 });
  const report: Report = {
    kind: 'dataFlow',
    title: 'Data flow of count',
    roots: [
      { label: 'Flows in', children: [] },
      { label: 'Flows out', children: [] },
      { label: 'reset()', icon: 'symbol-function', expanded: true, children: [{ label: '= 0', role: 'write', location: at(1) }] },
      { label: 'show()', icon: 'symbol-function', children: [{ label: 'read: count', role: 'read', location: at(2) }] },
      { label: 'Next', children: [{ label: 'Find Usages' }] },
    ],
    warnings: [],
    fileHashes: {},
  };
  const diagram = reportDiagram(report);
  assert.deepEqual(diagram.left.map((n) => n.label), ['reset()']);
  assert.deepEqual(diagram.right.map((n) => n.label), ['show()']);
  // Folding follows the results view: show() was collapsed there.
  assert.equal(diagram.left[0].collapsed, false);
  assert.equal(diagram.right[0].collapsed, true);
});

test('other analyses hang every row to the right of their subject', () => {
  const report: Report = { kind: 'usages', title: 'Usages of cart', description: '3 usages', roots: [{ label: 'Reads', expanded: true, children: [{ label: 'cart.total' }] }, { label: 'How to fix', children: [] }], warnings: [], fileHashes: {} };
  const diagram = reportDiagram(report);
  assert.equal(diagram.center.label, 'cart');
  assert.equal(diagram.center.description, '3 usages');
  assert.deepEqual(diagram.left, []);
  assert.deepEqual(diagram.right.map((n) => n.label), ['Reads']);
  assert.deepEqual(diagram.right[0].children.map((n) => n.label), ['cart.total']);
});
