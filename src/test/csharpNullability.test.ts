import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { assertsNotNull, assertsNull, csharpNullChecks } from '../csharp/nullability';
import { Report } from '../structure/report';

const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const orders = 'c:/demo/OrderService.cs';
const checkout = 'namespace Web { class Checkout { async Task Run(OrderService s) { await s.PlaceOrderAsync("ann", null); await s.PlaceOrderAsync("bob", "SAVE10"); } } }';
const sources = [{ file: orders, text }, { file: 'c:/demo/Checkout.cs', text: checkout }];
const at = (s: string, from = 0) => text.indexOf(s, from);
const labels = (r: Report) => r.roots.map((g) => g.label);
const group = (r: Report, label: string) => r.roots.find((g) => g.label === label);

test('C# Null checks: a string? parameter, checked before it is used, with the caller that passes null', async () => {
  const r = await csharpNullChecks(sources, orders, at('coupon.StartsWith'));
  assert.equal(r.kind, 'nullability');
  assert.equal(r.title, 'Nullability of coupon');
  assert.equal(r.roots[0].label, 'coupon: string?');
  assert.equal(r.roots[0].description, 'never null here');
  assert.deepEqual(labels(r), ['coupon: string?', 'Declared', 'Possible null sources before the checks', 'Ruled out by', 'Uses']);
  assert.deepEqual(group(r, 'Possible null sources before the checks')!.children!.map((c) => c.label), ['declared string?', 's.PlaceOrderAsync("ann", null)']);
  assert.equal(group(r, 'Ruled out by')!.children![0].label, 'coupon != null');
  assert.deepEqual(group(r, 'Uses')!.children!.map((c) => c.description), ['line 85 · check', 'line 85 · safe']);
  assert.equal(group(r, 'Uses')!.description, '1 safe, 1 check, 0 may be null');
});

test('C# Null checks: a value type and a plain reference are never null', async () => {
  const amount = await csharpNullChecks(sources, orders, at('amount *= 0.9m'));
  assert.equal(amount.roots[0].description, 'not marked nullable (?), and nothing here sets it to null');
  const total = await csharpNullChecks(sources, orders, at('total = 0'));
  assert.equal(total.roots[0].label, 'total: decimal');
  assert.equal(total.roots[0].description, 'a value type: never null');
});

test('C# Null checks: null from ?., FirstOrDefault and a method declared to return T?, an unsafe use, and ! asserts', async () => {
  const code = [
    '#nullable enable',
    'class Shop {',
    '  List<User> users = new();',
    '  User? Find(string id) { if (id == "") return null; return users.FirstOrDefault(u => u.Id == id); }',
    '  string Name(string id) {',
    '    var user = Find(id);',
    '    var length = user?.Name.Length;',
    '    Console.WriteLine(user.Name);',
    '    if (user is null) return "nobody";',
    '    return user.Name + user!.Id;',
    '  }',
    '}',
  ].join('\n');
  const file = 'c:/shop.cs';
  const src = [{ file, text: code }];
  const use = await csharpNullChecks(src, file, code.indexOf('user.Name);'));
  assert.equal(use.roots[0].description, 'may be null here');
  assert.deepEqual(group(use, 'Paths that produce null')!.children!.map((c) => c.description!.replace(/ · .*$/, '')), ['Find() is declared to return User?']);
  assert.equal(group(use, 'Asserted non-null with ! (1)')!.description, 'it can still be null: a check is safer than !');
  assert.deepEqual(group(use, 'Uses')!.children!.map((c) => c.description!.replace(/^line \d+ · /, '')), ['check', 'may be null', 'check', 'safe']);
  assert.ok(group(use, 'How to fix'));

  // After the guard that returns: ruled out.
  const after = await csharpNullChecks(src, file, code.indexOf('user.Name +'));
  assert.equal(after.roots[0].description, 'never null here');
  assert.equal(group(after, 'Ruled out by')!.children![0].label, 'if (user is null) return "nobody";');

  // The method: its returns that give null.
  const find = await csharpNullChecks(src, file, code.indexOf('Find(string'));
  assert.equal(find.title, 'Nullability of Shop.Find()');
  assert.equal(find.roots[0].label, 'Shop.Find() returns User?');
  assert.deepEqual(group(find, 'Returns that produce null')!.children!.map((c) => c.label), ['return null', 'return users.FirstOrDefault(u => u.Id == id)']);
});

test('C# Null checks: conditions read as checks, including the grammar grouping of "is not null &&"', () => {
  assert.ok(assertsNotNull('x != null && x.Length > 0', 'x'));
  assert.ok(assertsNotNull('(x is not null)', 'x'));
  assert.ok(assertsNotNull('x is { Length: > 0 }', 'x'));
  assert.ok(assertsNotNull('x is string s', 'x'));
  assert.ok(assertsNotNull('!string.IsNullOrEmpty(x)', 'x'));
  assert.ok(!assertsNotNull('x != null || y', 'x'));
  assert.ok(assertsNull('x == null || x.Length == 0', 'x'));
  assert.ok(assertsNull('string.IsNullOrWhiteSpace(x)', 'x'));
  assert.ok(assertsNull('!(x != null)', 'x'));
  assert.ok(!assertsNull('x == null && y', 'x'));
});
