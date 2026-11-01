import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterReport, reportMarkdown } from '../structure/markdown';
import { Report, titleParts } from '../structure/report';

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

test('exclude globs match relative paths', async () => {
  const { globToRegExp } = await import('../structure/glob');
  assert.ok(globToRegExp('**/generated/**', false).test('src/generated/api.ts'));
  assert.ok(globToRegExp('**/generated/**', false).test('generated/api.ts'));
  assert.ok(globToRegExp('src/*.ts', false).test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts', false).test('src/nested/a.ts'));
  assert.ok(globToRegExp('**/*.{spec,test}.ts', false).test('a/b.test.ts'));
});

test('fix-all takes one fix per finding and skips overlaps; file suppression extends an existing comment', async () => {
  const ts = await import('typescript');
  const { fixAllEdits, fileSuppressionEdit } = await import('../inspect/inspection');
  const finding = (start: number, end: number) => ({ inspection: 'x', message: '', start, end, severity: 'warning' as const, fixes: [{ title: 'a', edits: [{ start, end, text: '' }] }] });
  assert.equal(fixAllEdits([finding(0, 5), finding(3, 8), finding(10, 12)]).length, 2);
  const plain = ts.createSourceFile('a.ts', 'const a = 1;\n', ts.ScriptTarget.Latest, true);
  assert.deepEqual(fileSuppressionEdit(plain, 'missingAwait'), { start: 0, end: 0, text: '// ts-structure-ignore-file missingAwait\n' });
  const existing = ts.createSourceFile('a.ts', '// ts-structure-ignore-file typeAssertion\nconst a = 1;\n', ts.ScriptTarget.Latest, true);
  const edit = fileSuppressionEdit(existing, 'missingAwait');
  assert.equal(existing.text.slice(0, edit.start) + edit.text + existing.text.slice(edit.end), '// ts-structure-ignore-file typeAssertion, missingAwait\nconst a = 1;\n');
});

test('report titles split into the analysis and its subject', () => {
  const parts = (kind: string, title: string) => titleParts({ ...report, kind, title });
  assert.deepEqual(parts('mutations', 'Mutations in cart.ts'), { heading: 'Mutations', subject: 'cart.ts' });
  assert.deepEqual(parts('overrideImpact', 'Impact of changing Base.area'), { heading: 'Override impact', subject: 'Base.area' });
  assert.deepEqual(parts('graphDiff', 'Dependency changes since HEAD'), { heading: 'Dependency changes', subject: 'since HEAD' });
  assert.deepEqual(parts('dependencyPath', 'main.ts → analytics.ts'), { heading: 'Dependency path', subject: 'main.ts → analytics.ts' });
  assert.deepEqual(parts('deadExports', 'Dead exports'), { heading: 'Dead exports' });
  assert.deepEqual(titleParts(undefined), { heading: 'Analysis' });
});
