import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterReport, reportMarkdown } from '../structure/markdown';
import { Report } from '../structure/report';

const report: Report = {
  kind: 'test',
  title: 'Usages of total',
  description: '3 usages',
  warnings: ['Partial results'],
  fileHashes: {},
  roots: [
    {
      label: 'Writes',
      children: [{ label: 'total += item', tone: 'warning', location: { file: '/repo/src/cart.ts', line: 4, character: 2, endLine: 4, endCharacter: 7 } }],
    },
    { label: 'Reads', children: [{ label: 'return total', location: { file: '/repo/src/cart.ts', line: 9, character: 2, endLine: 9, endCharacter: 7 } }] },
  ],
};

test('reports render as a Markdown outline with relative locations', () => {
  assert.equal(
    reportMarkdown(report, '/repo'),
    ['## Usages of total', '', '_3 usages_', '', '> Partial results', '', '- Writes', '  - ⚠️ total += item — `src/cart.ts:5`', '- Reads', '  - return total — `src/cart.ts:10`', ''].join('\n'),
  );
});

test('filtering keeps matching rows with their ancestors', () => {
  const filtered = filterReport(report.roots, 'RETURN');
  assert.deepEqual(filtered.map((n) => [n.label, n.children?.map((c) => c.label)]), [['Reads', ['return total']]]);
  assert.equal(filterReport(report.roots, '').length, 2);
});

test('re-running after edits targets the same symbol', async () => {
  const { retarget } = await import('../structure/retarget');
  const before = 'const total = 1;\nfunction add(total: number) {\n  return total;\n}\n';
  const offset = before.indexOf('return total') + 'return to'.length;
  const after = '// header comment\n' + before.replace('const total = 1;', 'const total = 2; // changed');
  assert.equal(after.slice(retarget(before, after, offset) - 2, retarget(before, after, offset) + 3), 'total');
  assert.equal(retarget(before, after, offset), after.indexOf('return total') + 'return to'.length);
  // An extra occurrence before it: the nearest one wins.
  const inserted = before.replace('function add', 'const other = total;\nfunction add');
  assert.equal(retarget(before, inserted, offset), inserted.indexOf('return total') + 'return to'.length);
  assert.equal(retarget(before, before, offset), offset);
});
