import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { editActionsAt } from '../structure/editActions';
import { ActiveFeature } from '../ui/activeFeature';

const code = [
  'export async function placeOrder(id: string, items: string[]) {', // 0
  '  const total = items.length * 2;', // 1
  '  await save(id, total);', // 2
  '  if (total > 10) return notify(id);', // 3
  '}', // 4
  'class Cart {', // 5
  '  add(item: string) { return item; }', // 6
  '}', // 7
  'const handler = (e: Event) => e;', // 8
].join('\n');
const labels = (line: number, character = 0) => editActionsAt('/p/orders.ts', code, line, character).map((a) => a.label);

test('edit actions: a function box offers rename, safe delete, change signature and move, with the cursor on its name', () => {
  assert.deepEqual(labels(0), ['Rename', 'Delete safely', 'Change signature', 'Move to a file']);
  const rename = editActionsAt('/p/orders.ts', code, 0, 0)[0];
  assert.equal(rename.character, code.indexOf('placeOrder'));
  // An arrow function in a variable is a function too.
  assert.ok(labels(8).includes('Change signature'));
  assert.ok(!labels(8).includes('Inline'));
});

test('edit actions: a variable can be inlined; a method is not moved to another file; a class is', () => {
  assert.deepEqual(labels(1, 8), ['Rename', 'Delete safely', 'Inline']);
  assert.deepEqual(labels(6, 2), ['Rename', 'Delete safely', 'Change signature']);
  assert.ok(labels(5).includes('Move to a file'));
});

test('edit actions: code that declares nothing can be extracted, with its expression selected', () => {
  const extract = editActionsAt('/p/orders.ts', code, 2, 2).find((a) => a.label === 'Extract…');
  assert.ok(extract);
  assert.deepEqual([extract.line, extract.character, extract.endLine, extract.endCharacter], [2, 2, 2, 23]);
  assert.ok(labels(3, 2).includes('More edits…'));
  assert.deepEqual(editActionsAt('/p/types.d.ts', code, 0, 0), []);
  assert.deepEqual(editActionsAt('/p/orders.ts', code, 99, 0), []);
});

test('active feature: closing a chart clears the button of the analysis it came from, and only that one', () => {
  const active = new ActiveFeature(() => 0);
  const report = {};
  active.noteInvoked('tsStructure.dataFlow');
  active.reportShown(report);
  assert.equal(active.active, 'tsStructure.dataFlow');
  assert.equal(active.originOf(report), 'tsStructure.dataFlow');
  active.closed(active.originOf(report)!);
  assert.equal(active.active, undefined);
  assert.equal(active.last, 'tsStructure.dataFlow');
  active.set('tsStructure.controlFlow');
  active.clearedAll('tsStructure.controlFlow');
  assert.equal(active.active, 'tsStructure.controlFlow');
});

test('edit actions: a box on a reference renames what it refers to, not the declaration on its line', () => {
  const got = labels(1, code.indexOf('items.length') - code.split('\n').slice(0, 1).join('\n').length - 1);
  assert.ok(got.includes('Rename ‘items’'));
  assert.ok(!got.includes('Delete safely'));
});

test('symbol order: by line either way, by complexity (decisions), by size and by name', async () => {
  const ts = await import('typescript');
  const { fileSymbols, measureSymbols, sortSymbols } = await import('../structure/symbols');
  const text = [
    'function simple() { return 1; }',
    'const branchy = (a: number, b?: string) => {',
    '  if (a > 1 && b) return b ?? "x";',
    '  for (const c of [a]) { if (c) continue; }',
    '  return a ? "y" : "z";',
    '};',
    'function alpha(x: number) {',
    '  return x;',
    '}',
  ].join('\n');
  const file = ts.createSourceFile('/p/a.ts', text, ts.ScriptTarget.Latest, true);
  const symbols = fileSymbols(file).filter((s) => s.kind !== 'parameter' && !s.container);
  const measures = measureSymbols(file, symbols);
  const names = (order: Parameters<typeof sortSymbols>[1]) => sortSymbols(symbols, order, measures).map((s) => s.name);
  assert.deepEqual(names('lineUp'), ['simple', 'branchy', 'alpha']);
  assert.deepEqual(names('lineDown'), ['alpha', 'branchy', 'simple']);
  assert.equal(names('complexity')[0], 'branchy');
  // if, &&, ??, for, if, ?: — six decisions.
  assert.equal(measures.get(symbols.find((s) => s.name === 'branchy')!)?.complexity, 7);
  assert.deepEqual(names('size'), ['branchy', 'alpha', 'simple']);
  assert.deepEqual(names('name'), ['alpha', 'branchy', 'simple']);
});

test('result card: counts warnings and problems at every level, and finds where the subject is', async () => {
  const { resultCard } = await import('../structure/resultCard');
  const at = { file: '/p/a.ts', line: 3, character: 4, endLine: 3, endCharacter: 8 };
  const card = resultCard({
    kind: 'nullability', title: 'Nullability of user', description: '1 source', roots: [
      { label: 'user: User | undefined', tone: 'warning' },
      { label: 'Uses', children: [{ label: 'user.name', tone: 'ok', location: at }, { label: 'user.age', tone: 'error' }] },
    ], warnings: [], fileHashes: {}, durationMs: 5, ranAt: Date.now(),
  } as unknown as Parameters<typeof resultCard>[0]);
  assert.equal(card.issues, 2);
  assert.deepEqual(card.subjectAt, at);
});
