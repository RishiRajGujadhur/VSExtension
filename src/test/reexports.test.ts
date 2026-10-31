import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { reexportChainReport } from '../navigate/reexports';
import { fixtures, offsetIn, virtualProject } from './helpers';

const root = path.join(fixtures, 'navigate');
const app = path.join(root, 'src/app.tsx');

function report(marker: string) {
  return reexportChainReport(virtualProject('navigate', 'src/app.tsx'), app, offsetIn(app, marker), root);
}

test('a renamed import is followed through two barrels to its declaration', () => {
  const [chain, exported, imported] = report('new Bo|x(2)').roots;
  assert.deepEqual(
    chain.children?.map((c) => `${c.label} | ${c.description}`),
    [
      "import { Box } from './public'; | src/app.tsx · as Box",
      "export { Box } from './index'; | src/public.ts · as Box",
      "export { Square as Box, Circle } from './models'; | src/index.ts · as Box",
      'declared: export class Square extends Base { | src/models.ts',
    ],
  );
  assert.deepEqual(exported.children?.map((c) => `${c.label} | ${c.description}`).sort(), [
    'Box (renamed from Square) | src/index.ts · re-export',
    'Box (renamed from Square) | src/public.ts · re-export',
    'Square | src/models.ts · declaration',
  ]);
  assert.deepEqual(imported.children?.map((c) => c.label), ["'./public'"]);
});

test('names forwarded by export * show the star re-export as a hop', () => {
  const [chain] = report('formatAr|ea(box)').roots;
  assert.deepEqual(chain.children?.map((c) => c.label), [
    "import { formatArea } from './index';",
    "export * from './utils';",
    'declared: export function formatArea(shape: Shape, digits = 2): string {',
  ]);
});
