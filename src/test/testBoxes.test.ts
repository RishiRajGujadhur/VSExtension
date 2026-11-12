import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTestRow, reportDiagram } from '../structure/diagram';
import { Report } from '../structure/report';

const at = (file: string) => ({ file, line: 3, character: 0, endLine: 3, endCharacter: 1 });

test('rows in test files are test boxes: by location, by a test file name, or marked as tests', () => {
  assert.equal(isTestRow({ label: 'renders', location: at('/p/src/Cart.spec.tsx') }), true);
  assert.equal(isTestRow({ label: 'total', location: at('/p/src/cart.ts') }), false);
  assert.equal(isTestRow({ label: 'pricing.test.ts', description: '1' }), true);
  assert.equal(isTestRow({ label: 'placeOrder', description: 'orders.spec.ts · 1 write' }), true);
  assert.equal(isTestRow({ label: 'cart.ts', description: 'test · 1' }), true);
  assert.equal(isTestRow({ label: 'contest.ts', description: 'src' }), false);
});

test('a data flow chart gives test boxes a test tube', () => {
  const report: Report = {
    kind: 'dataFlow', title: 'Data flow of total', description: 'x', warnings: [], fileHashes: {},
    roots: [
      { label: 'Flows in', children: [] },
      { label: 'Flows out', children: [
        { label: 'used in render()', description: 'Cart · Cart.spec.tsx', location: at('/p/src/Cart.spec.tsx') },
        { label: 'used in checkout()', description: 'cart.ts', location: at('/p/src/cart.ts') },
      ] },
    ],
  };
  const diagram = reportDiagram(report)!;
  const boxes: { label: string; test?: boolean; icon?: string }[] = [];
  const walk = (nodes: typeof diagram.right) => nodes.forEach((n) => { boxes.push(n); walk(n.children); });
  walk([...diagram.left, ...diagram.right]);
  const spec = boxes.find((b) => b.label === 'used in render()')!;
  assert.equal(spec.test, true);
  assert.equal(spec.icon, 'beaker');
  assert.equal(boxes.find((b) => b.label === 'used in checkout()')!.test, undefined);
});
