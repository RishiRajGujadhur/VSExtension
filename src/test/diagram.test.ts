import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { dataFlowReport } from '../inspect/dataFlow';
import { DiagramNode, diagramMermaid, foldToFit, reportDiagram } from '../structure/diagram';
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

test('design patterns are drawn as patterns, not as places the value goes', () => {
  const report: Report = {
    kind: 'dataFlow',
    title: 'Data flow of payment',
    roots: [
      { label: 'Flows in', children: [] },
      { label: 'Flows out', children: [{ label: '→ receipt' }] },
      { label: 'Design patterns', expanded: true, children: [{ label: 'Strategy', action: { kind: 'explainPattern', name: 'Strategy' }, children: [{ label: 'CardPayment' }] }] },
    ],
    warnings: [],
    fileHashes: {},
  };
  const diagram = reportDiagram(report);
  const patterns = diagram.right.find((n) => n.label === 'Design patterns')!;
  assert.equal(diagram.right[0].kind, undefined);
  assert.equal(patterns.kind, 'pattern');
  assert.equal(patterns.children[0].kind, 'pattern');
  assert.equal(patterns.children[0].children[0].kind, 'pattern');
  const mermaid = diagramMermaid({ ...diagram, right: [{ ...patterns, collapsed: true }] });
  assert.match(mermaid, /n1\{\{"Design patterns<br\/>1 more folded"\}\}/);
  assert.match(mermaid, /n0 -\.- n1/);
  assert.match(mermaid, /class n1 pattern/);
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

test('the chart copies as a Mermaid flowchart with arrows in the direction of the flow', () => {
  const leaf = (label: string, extra = {}) => ({ label, collapsed: false, children: [], ...extra });
  const text = diagramMermaid({
    title: 'Data flow of total',
    center: leaf('total', { description: '2 definitions' }),
    left: [leaf('= price * 2')],
    right: [leaf('→ <Cart> "items"', { tone: 'warning' as const }), leaf('show()', { collapsed: true, children: [leaf('read'), leaf('read again')] })],
  });
  assert.deepEqual(text.split('\n'), [
    'flowchart LR',
    '  n0["total<br/>2 definitions"]',
    '  n1["= price * 2"]',
    '  n1 --> n0',
    '  n2["→ #lt;Cart#gt; #quot;items#quot;"]',
    '  n0 --> n2',
    '  n3["show()<br/>2 more folded"]',
    '  n0 --> n3',
    '  style n0 stroke-width:3px',
    '  classDef warning stroke:#d29922,stroke-width:2px',
    '  class n2 warning',
  ]);
});

test('a chart that would open with too many boxes folds its deepest levels first', () => {
  const leaf = (label: string): DiagramNode => ({ label, collapsed: false, children: [] });
  const group = (label: string, children: DiagramNode[]): DiagramNode => ({ label, collapsed: false, children });
  // 3 groups of 4 subgroups of 20 leaves: 3 + 12 + 240 boxes.
  const right = [0, 1, 2].map((i) => group(`g${i}`, [0, 1, 2, 3].map((j) => group(`g${i}.${j}`, Array.from({ length: 20 }, (_, k) => leaf(`leaf ${k}`))))));
  const diagram = foldToFit({ title: 't', center: leaf('c'), left: [], right }, 50);
  // The groups stay open and their subgroups show; the subgroups fold their leaves away.
  assert.equal(diagram.right[0].collapsed, false);
  assert.equal(diagram.right[0].children[0].collapsed, true);
  // A chart that fits is left as it is.
  const small = foldToFit({ title: 't', center: leaf('c'), left: [], right: [group('g', [leaf('a')])] }, 50);
  assert.equal(small.right[0].collapsed, false);
});
