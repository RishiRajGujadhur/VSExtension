import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { countResults, limitReport, locationFilter, scopeFilter } from '../structure/scope';
import { ReportLocation, ReportNode } from '../structure/report';

const at = (file: string, line: number, endLine = line): ReportLocation => ({ file, line, character: 0, endLine, endCharacter: 1 });

test('a scope of folders and files contains what is below the folders and the files named', () => {
  const inside = scopeFilter({ folders: ['/repo/src/cart'], files: ['/repo/src/app.ts'] });
  assert.equal(inside('/repo/src/cart/total.ts'), true);
  assert.equal(inside('/repo/src/cart/deep/tax.ts'), true);
  assert.equal(inside('/repo/src/app.ts'), true);
  assert.equal(inside('/repo/src/cartography.ts'), false, 'a folder name is not a prefix match on file names');
  assert.equal(inside('/repo/src/other.ts'), false);
  assert.equal(scopeFilter({})('/anything.ts'), true, 'an empty scope is the whole project');
});

test('a line scope keeps locations that overlap the lines', () => {
  const inside = locationFilter({ lines: { file: '/repo/a.ts', start: 10, end: 20 } });
  assert.equal(inside(at('/repo/a.ts', 15)), true);
  assert.equal(inside(at('/repo/a.ts', 5, 12)), true, 'a span that starts before the lines and ends inside overlaps them');
  assert.equal(inside(at('/repo/a.ts', 21)), false);
  assert.equal(inside(at('/repo/b.ts', 15)), false);
});

test('limiting a report keeps matching rows, their groups and their details', () => {
  const roots: ReportNode[] = [
    {
      label: 'Writes',
      children: [
        { label: 'in cart', location: at('/repo/src/cart/a.ts', 1), children: [{ label: 'detail', location: at('/repo/src/lib/x.ts', 3) }] },
        { label: 'in lib', location: at('/repo/src/lib/b.ts', 1) },
      ],
    },
    { label: 'Reads', children: [{ label: 'in lib', location: at('/repo/src/lib/c.ts', 2) }] },
  ];
  const limited = limitReport(roots, locationFilter({ folders: ['/repo/src/cart'] }));
  assert.deepEqual(
    limited.map((n) => [n.label, n.children?.map((c) => [c.label, c.children?.map((d) => d.label)])]),
    [['Writes', [['in cart', ['detail']]]]],
  );
  assert.equal(limited[0].description, '1 of 2', 'a group with rows left out counts what is shown');
  assert.equal(limited[0].children![0].description, undefined, 'a row with all its details keeps its own description');
  assert.equal(countResults(roots), 3, 'results are the rows at the ends of the tree');
  assert.equal(countResults(limited), 1);
});
