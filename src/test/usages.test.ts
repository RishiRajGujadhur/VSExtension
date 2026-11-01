import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { semanticUsagesReport } from '../navigate/usages';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { forEachReportNode } from '../structure/report';

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

test('destructuring a property reads it', () => {
  const project = virtualProject('navigate', 'src/utils.ts');
  const text = fs.readFileSync(utils, 'utf8');
  project.setText(utils, `${text}\nexport function nameOf(shape: Shape): string {\n  const { name } = shape;\n  return name;\n}\n`);
  const report = semanticUsagesReport(project, models, offsetIn(models, '  na|me: string;'));
  const labels = report.roots.map((r) => `${r.label}: ${r.children?.flatMap((f) => f.children ?? []).map((c) => c.label).join(' | ')}`);
  assert.ok(labels.some((l) => l.startsWith('Reads:') && l.includes('const { name } = shape;')), labels.join('\n'));
  assert.ok(!labels.some((l) => l.startsWith('Definitions:') && l.includes('const { name }')), labels.join('\n'));
});

test('the usage at the cursor is selected', () => {
  const report = semanticUsagesReport(virtualProject('navigate', 'src/utils.ts'), app, offsetIn(app, 'const label = format|Area(box)'));
  const focused: string[] = [];
  forEachReportNode(report.roots, (node) => node.focus && focused.push(`${node.label} (${node.description})`));
  assert.deepEqual(focused, ['const label = formatArea(box); (App · line 15 · at cursor)']);
});
