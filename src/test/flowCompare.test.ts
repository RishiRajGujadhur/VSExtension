import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compareCharts, findSameFunction, shortName } from '../inspect/flowCompare';
import { standaloneCharts } from '../inspect/controlFlowChart';
import { csharpFlowChart } from '../csharp/flow';
import { tsqlFlowChart } from '../tsql/flow';

const before = `import { tax } from './tax';
export function total(items: number[], code?: string) {
  let sum = 0;
  for (const i of items) sum += i;
  if (code === 'SAVE10') {
    sum = sum * 0.9;
  }
  return sum;
}`;
// A helper above it moves it down; the discount changed, a new early return and a throw came in, the log line went.
const after = `const helper = () => 1;
export function total(items: number[], code?: string) {
  if (!items.length) return 0;
  let sum = 0;
  for (const i of items) sum += i;
  if (code === 'SAVE10') {
    sum = sum * 0.8;
  }
  if (sum < 0) throw new Error('negative');
  return sum;
}`;

const tsCharts = (file: string) => {
  const parsed = new Map<string, ReturnType<typeof standaloneCharts>>();
  return async (text: string, offset: number) => {
    let charts = parsed.get(text);
    if (!charts) parsed.set(text, (charts = standaloneCharts(file, text)));
    return charts(offset);
  };
};

test('Flowchart vs last commit: finds the same function after it moved, and marks new, changed and gone', async () => {
  const chartAt = tsCharts('c:/demo/total.ts');
  const now = await chartAt(after, after.indexOf('total'));
  const found = await findSameFunction({ text: after, chart: now }, before, chartAt);
  assert.ok(found.chart, 'found in the old text');
  assert.equal(found.chart.name, now.name);
  const diff = compareCharts(found.chart, now);
  const code = (id: number) => now.nodes[id].text;
  assert.deepEqual(diff.added.map(code).sort(), ['!items.length', 'return 0;', 'sum < 0', "throw new Error('negative');"].sort());
  assert.deepEqual(diff.changed.map((c) => [code(c.id), c.before]), [['sum = sum * 0.8;', 'sum = sum * 0.9;']]);
  assert.deepEqual(diff.removed, []);
  // Every path now goes through the new decision, so all are new; the old ones are all gone.
  assert.equal(diff.newPaths.length, now.paths.length);
  assert.equal(diff.gonePaths.length, found.chart.paths.length);
  assert.ok(diff.unchanged >= 3, `unchanged ${diff.unchanged}`);
});

test('Flowchart vs last commit: the same code is no change at all, and a removed box is listed with its line', async () => {
  const chartAt = tsCharts('c:/demo/total.ts');
  const now = await chartAt(before, before.indexOf('total'));
  const same = compareCharts(await chartAt(before, before.indexOf('total')), now);
  assert.deepEqual([same.added, same.changed, same.removed, same.newPaths, same.gonePaths], [[], [], [], [], []]);
  const without = before.replace("  if (code === 'SAVE10') {\n    sum = sum * 0.9;\n  }\n", '');
  const shorter = await chartAt(without, without.indexOf('total'));
  const gone = compareCharts(now, shorter);
  assert.deepEqual(gone.removed.map((r) => [r.kind, r.text, r.line]), [['decision', "code === 'SAVE10'", 5], ['statement', 'sum = sum * 0.9;', 6]]);
  // Each old path went through the removed decision (twice two, with the loop): all four are gone, the two left are new.
  assert.equal(gone.gonePaths.length, 4);
  assert.equal(gone.newPaths.length, 2);
});

test('Flowchart vs last commit: a function that is not in the old text is new, every box added', async () => {
  const chartAt = tsCharts('c:/demo/total.ts');
  const text = `${before}\nexport function fresh(a: number) { if (a) return 1; return 2; }`;
  const now = await chartAt(text, text.indexOf('fresh'));
  const found = await findSameFunction({ text, chart: now }, before, chartAt);
  assert.equal(found.chart, undefined);
  const diff = compareCharts(found.chart, now);
  assert.ok(diff.isNew);
  assert.equal(diff.added.length, 3);
});

test('Flowchart vs last commit: methods with the same name are told apart by their order', async () => {
  const chartAt = tsCharts('c:/demo/shapes.ts');
  const old = 'class A { area() { return 1; } }\nclass B { area() { return 2; } }';
  const text = 'class A { area() { return 1; } }\nclass B { area() { if (this) return 3; return 2; } }';
  const now = await chartAt(text, text.lastIndexOf('area'));
  const found = await findSameFunction({ text, chart: now }, old, chartAt);
  assert.match(found.chart!.nodes.map((n) => n.text).join(' '), /return 2/);
  assert.deepEqual(compareCharts(found.chart, now).added.map((id) => now.nodes[id].text).sort(), ['return 3;', 'this']);
});

test('Flowchart vs last commit: C# and T-SQL, through their own flowcharts', async () => {
  const cs = (text: string, offset: number) => csharpFlowChart(text, 'c:/demo/Grade.cs', offset);
  const oldCs = 'class G { int Grade(int s) { if (s > 90) return 1; return 2; } }';
  const newCs = 'class G {\n  int Other() => 0;\n  int Grade(int s) { if (s > 90) return 1; if (s > 50) return 3; return 2; } }';
  const nowCs = await cs(newCs, newCs.indexOf('Grade'));
  const foundCs = await findSameFunction({ text: newCs, chart: nowCs }, oldCs, cs);
  assert.deepEqual(compareCharts(foundCs.chart, nowCs).added.map((id) => nowCs.nodes[id].text).sort(), ['return 3;', 's > 50']);

  const sql = async (text: string, offset: number) => tsqlFlowChart(text, 'c:/demo/grade.sql', offset);
  const oldSql = 'CREATE PROCEDURE dbo.usp_Grade @s INT AS\nBEGIN\n  IF @s > 90 RETURN 1;\n  RETURN 2;\nEND';
  const newSql = 'CREATE PROCEDURE dbo.usp_Grade @s INT AS\nBEGIN\n  IF @s > 95 RETURN 1;\n  RETURN 2;\nEND';
  const nowSql = await sql(newSql, newSql.indexOf('usp_Grade'));
  const foundSql = await findSameFunction({ text: newSql, chart: nowSql }, oldSql, sql);
  const diff = compareCharts(foundSql.chart, nowSql);
  assert.equal(diff.changed.length, 1);
  assert.match(diff.changed[0].before, /@s > 90/);
});

test('Flowchart vs last commit: the name written in code', () => {
  assert.equal(shortName('Cart.Price'), 'Price');
  assert.equal(shortName('[dbo].[usp_Grade]'), 'usp_Grade');
  assert.equal(shortName('total()'), 'total');
  assert.equal(shortName('(anonymous)'), undefined);
});

test('Flowchart vs last commit: a changed box is paired with the old box most like it, not just the next of its kind', async () => {
  const chartAt = tsCharts('c:/demo/pricing.ts');
  const old = 'function applyCoupon(amount: number, off?: number) {\n  if (!off) {\n    return amount;\n  }\n  return amount * (1 - off / 100);\n}';
  const text = 'function applyCoupon(amount: number, off?: number) {\n  if (amount <= 0) {\n    return 0;\n  }\n  if (!off) {\n    return amount;\n  }\n  return Math.round(amount * (100 - off)) / 100;\n}';
  const now = await chartAt(text, text.indexOf('applyCoupon'));
  const diff = compareCharts(await chartAt(old, old.indexOf('applyCoupon')), now);
  assert.deepEqual(diff.added.map((id) => now.nodes[id].text).sort(), ['amount <= 0', 'return 0;']);
  assert.deepEqual(diff.changed.map((c) => [now.nodes[c.id].text, c.before]), [['return Math.round(amount * (100 - off)) / 100;', 'return amount * (1 - off / 100);']]);
  assert.deepEqual(diff.removed, []);
});
