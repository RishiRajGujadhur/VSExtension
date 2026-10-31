import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { semanticUsagesReport } from '../navigate/usages';
import { fixtures, offsetIn, virtualProject } from './helpers';

const utils = path.join(fixtures, 'navigate/src/utils.ts');
const app = path.join(fixtures, 'navigate/src/app.tsx');
const models = path.join(fixtures, 'navigate/src/models.ts');

function groups(file: string, marker: string) {
  const report = semanticUsagesReport(virtualProject('navigate', 'src/utils.ts'), file, offsetIn(file, marker));
  return report.roots.map((r) => `${r.label} ${r.description}`);
}

test('usages are grouped into definitions, calls, imports, writes and reads', () => {
  assert.deepEqual(groups(utils, 'function format|Area'), ['Definitions 1', 'Calls 3 (1 in tests)', 'Imports 2 (1 in tests)']);
  assert.deepEqual(groups(utils, 'let coun|ter'), ['Definitions 1', 'Writes 1', 'Reads 1']);
});

test('JSX, type references, inheritance and type imports are told apart', () => {
  assert.deepEqual(groups(app, 'function La|bel'), ['Definitions 1', 'JSX usages 1']);
  assert.deepEqual(groups(models, 'interface Sh|ape'), ['Definitions 1', 'Extended or implemented 1', 'Type references 2', 'Imports 2']);
});
