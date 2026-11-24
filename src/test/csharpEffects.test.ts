import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { csharpSideEffects } from '../csharp/effects';
import { Report } from '../structure/report';

const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const orders = 'c:/demo/OrderService.cs';
const sources = [{ file: orders, text }];
const at = (s: string, from = 0) => text.indexOf(s, from);
const shape = (r: Report) => r.roots.map((g) => [g.label, (g.children ?? []).map((c) => c.label)]);

test('C# Side effects: own changes, and what the methods it calls do, followed by name', async () => {
  const r = await csharpSideEffects(sources, orders, at('var amount'));
  assert.equal(r.kind, 'sideEffects');
  assert.equal(r.title, 'Side effects of OrderService.PlaceOrderAsync');
  assert.deepEqual(shape(r), [
    ['Not pure: mutates the instance, input/output, waits', []],
    ['Mutates the instance', ['changes cart.total', 'changes attempts (++)']],
    ['Input/output', ['writes to the console', 'writes to the console', 'writes to the console']],
    ['Waits', ['waits']],
    ['By call', ['Log()', 'Price()', 'SaveAsync()']],
  ]);
  const total = r.roots[1].children![0];
  assert.match(total.description!, /^via Price\(\)/);
  assert.equal(total.children![0].label, 'total = 0');
  const attempts = r.roots[1].children![1];
  assert.match(attempts.description!, /in a loop/);
  const log = r.roots[2].children![0];
  assert.match(log.description!, /via Log\(\)/);
  assert.match(log.description!, /after await/);
  assert.equal(r.roots[4].children![0].description, 'input/output · called 3 times');
});

test('C# Side effects: an argument changed, and a method with none', async () => {
  const add = await csharpSideEffects(sources, orders, at('items.Add(item)'));
  assert.deepEqual(shape(add)[1], ['Mutates the instance', ['changes items (Add)']]);
  const grade = await csharpSideEffects(sources, orders, at('case 0'));
  assert.deepEqual(shape(grade), [['OrderService.Grade has no detected side effects', []]]);
  const changer = 'class A { int n; void Bump(Counter c) { c.Value++; Reset(c); } void Reset(Counter d) { d.Value = 0; } }';
  const bumped = await csharpSideEffects([{ file: 'c:/a.cs', text: changer }], 'c:/a.cs', changer.indexOf('c.Value++'));
  assert.deepEqual(shape(bumped)[1], ['Mutates arguments', ['changes c.Value (++)', 'changes c.Value (an argument)']]);
});

test('C# Side effects: a call to nothing in the workspace, made for what it does, is listed as not followed', async () => {
  const code = 'class B { void Go(IBus bus) { bus.Publish(1); var x = Compute(); } }';
  const r = await csharpSideEffects([{ file: 'c:/b.cs', text: code }], 'c:/b.cs', code.indexOf('bus.Publish'));
  assert.deepEqual(shape(r), [['Calls it could not follow', ['bus.Publish() may change things']]]);
  assert.match(r.description!, /1 call not followed/);
});
