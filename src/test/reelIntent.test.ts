import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { intentLabel, intentsOf, mainIntent, nameIntent } from '../reel/intent';
import { dedent, keyChange, lineWeight } from '../reel/keyChange';
import type { DiffLine } from '../reel/plan';

test('Intent model: a name says what code is for, after "handle" and "on"', () => {
  assert.deepEqual(nameIntent('addToCart'), { kind: 'add', object: undefined, target: 'cart' });
  assert.deepEqual(nameIntent('handleRemoveItemClick'), { kind: 'remove', object: 'item', target: undefined });
  assert.deepEqual(nameIntent('CartItemsList', 'src/CartItemsList.tsx'), { kind: 'show', object: 'cart items' });
  assert.equal(nameIntent('CartItemsList', 'src/cart.ts'), undefined);
  assert.equal(nameIntent('signIn')?.kind, 'auth');
});

test('Intent model: tells adding to the cart from showing the cart, removing and updating', () => {
  const add = mainIntent({ name: 'addToCart', file: 'cart.ts', added: ['setItems((prev) => [...prev, item]);'] })!;
  assert.equal(add.kind, 'add');
  assert.equal(add.phrase, 'adds an item to the cart');
  assert.equal(intentLabel(add), 'Adds item to cart');

  const show = mainIntent({ name: 'CartItems', file: 'CartItems.tsx', added: ['      {items.map((item) => <li key={item.id}>{item.name}</li>)}'] })!;
  assert.equal(show.kind, 'show');
  assert.equal(show.phrase, 'shows the cart items');

  const remove = mainIntent({ name: 'removeFromCart', added: ['setItems(items.filter((i) => i.id !== id));'] })!;
  assert.equal(remove.phrase, 'removes an item from the cart');

  const update = mainIntent({ name: 'changeQuantity', added: ['setItems(items.map((i) => i.id === id ? { ...i, quantity } : i));'] })!;
  assert.equal(update.kind, 'update');
  assert.equal(update.phrase, 'updates the quantity');

  const load = mainIntent({ name: 'loadOrders', added: ["const res = await fetch('/api/orders');"] })!;
  assert.equal(load.phrase, 'loads the orders');
});

test('Intent model: the code alone, when the name says nothing', () => {
  assert.equal(intentsOf({ added: ['cart.items.push(product);'] })[0].phrase, 'adds a product to the cart items');
  assert.equal(intentsOf({ added: ["INSERT INTO dbo.Orders (Id) VALUES (@id)"] })[0].phrase, 'adds an item to the orders');
  assert.equal(intentsOf({ added: ['if (!user) return;'] })[0].kind, 'guard');
  assert.equal(intentsOf({ added: ["localStorage.setItem('cart', JSON.stringify(items));"] })[0].kind, 'save');
  assert.equal(intentsOf({ added: ['router.push("/checkout");'] })[0].kind, 'navigate');
  assert.equal(mainIntent({ added: ['const x = 1;'] }), undefined);
});

const diff = (spec: string): DiffLine[] =>
  spec.split('\n').map((row, i) => ({ kind: row[0] === '+' ? 'add' : row[0] === '-' ? 'del' : row[0] === '~' ? 'gap' : 'ctx', text: row.slice(1), line: i + 1 }));

test('Key change: the early exit, not the import, the log line or the braces', () => {
  const lines = diff([
    "+import { log } from './log';",
    ' ',
    ' export function addToCart(item: Item) {',
    "+  log('adding');",
    '+  if (!item.inStock) return;',
    '   items.push(item);',
    ' }',
  ].join('\n'));
  assert.equal(lineWeight(lines[0]), 0.3);
  assert.ok(lineWeight(lines[4]) > lineWeight(lines[3]));
  const key = keyChange(lines);
  assert.equal(key.lines[key.focus].text.trim(), 'if (!item.inStock) return;');
  assert.ok(!key.lines.some((l) => l.text.startsWith('import')));
  assert.ok(key.kinds.includes('guard'));
});

test('Key change: at most a few changed lines, from one hunk, with a line of context', () => {
  const lines = diff([
    ' function a() {',
    ...Array.from({ length: 12 }, (_, i) => `+  total += price${i};`),
    ' }',
    '~⋯',
    ' function b() {',
    '+  if (!user) throw new Error("Sign in first");',
    ' }',
  ].join('\n'));
  const key = keyChange(lines);
  assert.ok(key.lines.filter((l) => l.kind === 'add').length <= 6);
  assert.ok(key.lines.length <= 12);
  assert.ok(!key.lines.some((l) => l.kind === 'gap'));
});

test('Key change: lines moved left by their shared indent, spans moved with them', () => {
  const out = dedent([
    { kind: 'ctx', text: '    if (a) {' },
    { kind: 'add', text: '      go(b);', span: [9, 10] },
  ]);
  assert.deepEqual(out.map((l) => l.text), ['if (a) {', '  go(b);']);
  assert.deepEqual(out[1].span, [5, 6]);
});
