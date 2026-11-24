import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { csharpInspectionReport } from '../csharp/inspections';
import { csharpShapeReport, searchCSharpShape } from '../csharp/search';
import { csharpPatternsReport } from '../inspect/patterns';

const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const orders = 'c:/demo/OrderService.cs';
const sources = [{ file: orders, text }];

test('C# Inspect code: every inspection over the files, by inspection then file, with severities chosen', async () => {
  const r = await csharpInspectionReport(sources, {}, 'c:/demo');
  assert.equal(r.kind, 'inspectCode');
  assert.deepEqual(r.roots.map((g) => g.description!.split(' · ')[0]), ['csharpEmptyCatch', 'csharpThrowEx', 'csharpAsyncVoid', 'csharpSelfAssignment', 'csharpSelfComparison', 'csharpConstantCondition'].filter((id) => r.roots.some((g) => g.description!.startsWith(id))));
  assert.ok(r.roots.some((g) => g.description!.startsWith('csharpThrowEx')));
  assert.equal(r.roots.find((g) => g.description!.startsWith('csharpThrowEx'))!.children![0].children![0].description, 'line 104');
  assert.match(r.description!, /in 1 file \(1 C# file inspected\)/);
  const quiet = await csharpInspectionReport(sources, { csharpThrowEx: 'off' });
  assert.ok(!quiet.roots.some((g) => g.description!.startsWith('csharpThrowEx')));
});

test('C# Search by shape: placeholders stand for any code, the same one twice for the same code', async () => {
  const calls = await searchCSharpShape(sources, 'Log($message$)');
  assert.deepEqual(calls.map((m) => m.bindings.message), ['$"retry {attempts}: {e.Message}"', 'ex.Message', '"attempt done"', '"always"', '"refresh"']);
  assert.equal(calls[1].within, 'OrderService.PlaceOrderAsync');
  const self = await searchCSharpShape(sources, '$x$ = $x$');
  assert.deepEqual(self.map((m) => m.text), ['attempts = attempts']);
  const loops = await searchCSharpShape(sources, 'if ($cond$) { throw new ArgumentException($a$, $b$); }');
  assert.equal(loops.length, 2);
  const r = await csharpShapeReport(sources, '$a$ == $a$', 'c:/demo');
  assert.equal(r.kind, 'structuralSearch');
  assert.equal(r.description, '1 match in 1 file');
  await assert.rejects(searchCSharpShape(sources, 'if ('), /not C# the parser can read/);
});

test('C# Pattern spotting: shapes in classes, never names alone', async () => {
  const code = [
    'public interface IShipping { decimal Cost(decimal w); }',
    'public class Post : IShipping { public decimal Cost(decimal w) => w * 2; }',
    'public class Courier : IShipping { public decimal Cost(decimal w) => w * 5; }',
    'public sealed class Settings { private static readonly Settings instance = new Settings(); public static Settings Instance => instance; private Settings() { } }',
    'public class OrderBuilder { private int n; public OrderBuilder WithCount(int c) { n = c; return this; } public OrderBuilder Gift() { return this; } public Order Build() => new Order(n); }',
    'public class Checkout { private readonly IShipping shipping; public Checkout(IShipping shipping) { this.shipping = shipping; } public event EventHandler Paid; public void Pay() { Paid?.Invoke(this, EventArgs.Empty); } }',
    'public static class Orders { public static Order CreateOrder(int n) { return new Order(n); } }',
    'public class Prices { private readonly Dictionary<string, decimal> cache = new(); public decimal Of(string id) { if (cache.TryGetValue(id, out var p)) return p; p = Load(id); cache[id] = p; return p; } }',
  ].join('\n');
  const r = await csharpPatternsReport([{ file: 'c:/shop/Shop.cs', text: code }]);
  assert.equal(r.kind, 'patterns');
  const names = r.roots.map((g) => g.label).sort();
  assert.deepEqual(names, ['Builder', 'Dependency injection', 'Factory', 'Memoization', 'Observer', 'Singleton', 'Strategy']);
  const evidence = (name: string) => r.roots.find((g) => g.label === name)!.children!.map((c) => c.label);
  assert.deepEqual(evidence('Singleton'), ['Settings keeps its one instance in static instance and hides its constructor']);
  assert.deepEqual(evidence('Strategy'), ['Checkout uses an IShipping: Post, Courier are interchangeable']);
  assert.deepEqual(evidence('Observer'), ['Checkout raises its event Paid in Pay()']);
  const demo = await csharpPatternsReport(sources);
  assert.deepEqual(demo.roots.map((g) => g.label), ['Dependency injection']);
});
