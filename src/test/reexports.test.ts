import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import * as fs from 'fs';
import { reexportChainReport } from '../navigate/reexports';
import { applyTextEdits } from '../intentions/intentions';
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
    'Box (renamed from Square) | src/index.ts · re-export · no importers',
    'Box (renamed from Square) | src/public.ts · re-export · 1 importer',
    'Square | src/models.ts · declaration · no importers',
  ]);
  assert.deepEqual(imported.children?.map((c) => c.label), ["'./public'"]);
  const importer = imported.children?.[0].children?.[0];
  assert.equal(importer?.description, 'line 1 · as Box');
  assert.match(importer?.tooltip ?? '', /^```tsx\nimport \{ Box \} from '\.\/public';/);
});

test('names forwarded by export * show the star re-export as a hop', () => {
  const [chain] = report('formatAr|ea(box)').roots;
  assert.deepEqual(chain.children?.map((c) => c.label), [
    "import { formatArea } from './index';",
    "export * from './utils';",
    'declared: export function formatArea(shape: Shape, digits = 2): string {',
  ]);
});

test('each module that exports the name points at its export, not the top of the file', () => {
  const [, exported] = report('formatAr|ea(box)').roots;
  const line = (file: string) => exported.children?.find((c) => c.description?.startsWith(file))?.location?.line;
  // index.ts forwards it with `export * from './utils'` on its second line; utils.ts declares it further down.
  assert.equal(line('src/index.ts'), 1);
  assert.ok((line('src/utils.ts') ?? 0) > 0);
});

test('importing one symbol through several paths is pointed out', () => {
  const mixed = report('formatAr|ea(box)');
  assert.match(mixed.warnings[0], /^formatArea is imported through 2 different paths \('\.\/index', '\.\/utils'\)|^formatArea is imported through 2 different paths \('\.\/utils', '\.\/index'\)/);
  assert.deepEqual(report('new Bo|x(2)').warnings, []);
});

test('an import through a barrel can be repointed at the declaring module', () => {
  const demo = path.join(fixtures, '..', 'docs', 'demo');
  const main = path.join(demo, 'src/main.ts');
  const project = virtualProject('../docs/demo', 'src/main.ts');
  const result = reexportChainReport(project, main, offsetIn(main, 'subto|tal }'), demo);
  const imported = result.roots.find((r) => r.label === 'Imported through');
  const viaIndex = imported?.children?.find((c) => c.label === "'./index'")?.children?.[0];
  const action = viaIndex?.action as { kind: string; edits: { start: number; end: number; text: string }[]; title: string };
  assert.equal(action.kind, 'applyFix');
  assert.equal(action.title, 'Import calculateSubtotal directly from pricing.ts');
  const text = fs.readFileSync(main, 'utf8');
  const fixed = applyTextEdits(text, action.edits);
  assert.match(fixed, /^import \{ addToCart, cartFor, CardPayment, formatPrice \} from '\.\/index';\nimport \{ calculateSubtotal as subtotal \} from '\.\/pricing';\n/);
  // A direct import has nothing to repoint.
  const pricing = imported?.children?.find((c) => c.label === "'./pricing'")?.children?.[0];
  assert.equal(pricing?.action, undefined);
});
