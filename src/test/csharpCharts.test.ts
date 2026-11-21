import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as charts from '../csharp/charts';
import { Report } from '../structure/report';

const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const checkout = `using Bookshop.Orders;
namespace Bookshop.Web {
  public class GiftCart : Cart {
    public new decimal Price() => base.Price() * 0;
  }
  public class Checkout {
    public async Task Run(OrderService s) {
      var g = s.Grade(120m);
      s.Grade(5);
      _ = s.PlaceOrderAsync("ann", null);
      await s.PlaceOrderAsync("bob", "SAVE10");
    }
  }
}`;
const orders = 'c:/demo/OrderService.cs';
const web = 'c:/demo/Checkout.cs';
const sources = [{ file: orders, text }, { file: web, text: checkout }];
const at = (s: string, from = 0) => text.indexOf(s, from);
/** Each group with its rows' labels. */
const shape = (r: Report) => r.roots.map((g) => [g.label, (g.children ?? []).map((c) => c.label)]);

test('C# Data flow: a local, from its declaration and updates to the call it is passed to and the return', async () => {
  const r = await charts.csharpDataFlow(sources, orders, at('amount = cart.Price'));
  assert.equal(r.kind, 'dataFlow');
  assert.deepEqual(shape(r), [['Flows in', ['= cart.Price()', '*= 0.9m']], ['Flows out', ['SaveAsync(… amount …)', 'return amount']]]);
});

test('C# Changes to this variable: every write of a field, by method', async () => {
  const r = await charts.csharpVariableChanges(sources, orders, at('attempts++'));
  assert.equal(r.kind, 'variableMutations');
  assert.deepEqual(r.roots.map((g) => g.label), ['class level', 'OrderService.PlaceOrderAsync', 'OrderService.Refresh']);
});

test('C# Error paths: throws, where each goes, and the catch clauses', async () => {
  const r = await charts.csharpErrorPaths(sources, orders, at('var amount'));
  assert.equal(r.kind, 'exceptions');
  assert.deepEqual(shape(r), [
    ['Thrown here', ['throw ArgumentException', 'throw ex']],
    ['Caught here', ['catch (IOException e) when (attempts < 3)', 'catch (Exception ex)']],
  ]);
  assert.match(r.roots[1].children![1].description!, /handles, then throws again/);
});

test('C# Promise rejections: awaited tasks, and a task left running whose errors are lost', async () => {
  const r = await charts.csharpTaskErrors(sources, web, checkout.indexOf('var g'));
  assert.deepEqual(shape(r), [['Rejection sources', ['await s.PlaceOrderAsync("bob", "SAVE10")']], ['Unhandled', ['s.PlaceOrderAsync("ann", null)']]]);
  const refresh = await charts.csharpTaskErrors(sources, orders, at('Task.Delay(10)'));
  assert.equal(refresh.roots.find((g) => g.label === 'Unhandled')?.children?.[0].label, 'async void OrderService.Refresh');
});

test('C# Arguments passed in: the values each call passes to a parameter, across files', async () => {
  const r = await charts.csharpArguments(sources, orders, at('amount)', at('Grade(decimal')));
  assert.deepEqual(shape(r), [['Values that can arrive', ['120m', '5']], ['Call sites', ['120m', '5']]]);
});

test('C# Family tree and Override reach by name: interface above, subclass below, callers', async () => {
  const family = await charts.csharpFamilyTree(sources, orders, at('class Cart') + 7);
  assert.deepEqual(shape(family).slice(1, 3), [['Supertypes', ['IPriced']], ['Subtypes and implementations', ['GiftCart']]]);
  const reach = await charts.csharpOverrideReach(sources, orders, at('Price()', at('class Cart')));
  assert.deepEqual(shape(reach), [['Declared above', ['IPriced.Price']], ['Overrides in subtypes', ['GiftCart.Price']], ['Call sites', ['cart.Price()', 'base.Price()']]]);
  assert.match(reach.roots[1].children![0].description!, /hides it \(new\)/);
});

test('C# Who imports this: files that use the namespace and name its types', async () => {
  const r = await charts.csharpWhoImports(sources, orders);
  assert.equal(r.kind, 'dependents');
  assert.deepEqual(shape(r), [['Used by', ['Checkout.cs']]]);
});

test('C# Callers and calls by name: the caller in another file, the class method over the interface', async () => {
  const r = await charts.csharpCallGraphByName(sources, orders, at('var amount'), { depth: 1, direction: 'both' });
  assert.deepEqual(r.roots[0].children?.map((c) => c.label), ['Checkout.Run']);
  const calls = r.roots[1].children!.map((c) => c.label);
  assert.ok(calls.includes('Cart.Price') && !calls.includes('IPriced.Price') && !calls.some((c) => c.startsWith('nameof')), calls.join(', '));
});
