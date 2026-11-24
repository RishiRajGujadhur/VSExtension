import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { csharpExplainValue, csharpSlice, csharpValueTimeline } from '../csharp/values';
import { csharpFlowChart } from '../csharp/flow';
import { Report } from '../structure/report';

const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const file = 'c:/demo/OrderService.cs';
const at = (s: string, from = 0) => text.indexOf(s, from);
const shape = (r: Report) => r.roots.map((g) => [g.label, (g.children ?? []).map((c) => c.label)]);

test('C# Why this value: each value amount can have at the return, with the conditions that give it', async () => {
  const r = await csharpExplainValue(text, file, at('return amount') + 7);
  assert.equal(r.kind, 'explainValue');
  assert.equal(r.title, 'Value path of amount');
  assert.equal(r.description, '2 possible values at line 111');
  assert.deepEqual(r.roots.map((g) => g.label), ['= (cart.Price()) * 0.9m', '= cart.Price()']);
  const discounted = r.roots[0].children![0];
  assert.match(discounted.label, /coupon != null && coupon\.StartsWith\("SAVE"\)/);
  assert.match(r.roots[1].children![0].label, /not \(coupon != null && coupon\.StartsWith\("SAVE"\)\)/);
  // Each condition points at its decision.
  assert.equal(discounted.children![0].location?.line, text.slice(0, at('string.IsNullOrWhiteSpace')).split('\n').length - 1);
});

test('C# Why this value: a parameter is what callers pass, a loop variable each item', async () => {
  const customer = await csharpExplainValue(text, file, at('SaveAsync(customer') + 'SaveAsync('.length);
  assert.deepEqual(customer.roots.map((g) => g.label), ['the argument callers pass']);
  const item = await csharpExplainValue(text, file, at('item.Free'));
  assert.deepEqual(item.roots.map((g) => g.label), ['each item of items']);
});

test('C# Value timeline: changes in phases around a loop, with the step a counter takes', async () => {
  const amount = await csharpValueTimeline(text, file, at('var amount') + 4);
  assert.equal(amount.kind, 'valueTimeline');
  assert.deepEqual(shape(amount), [
    ['At the start', ['starts as cart.Price()', '*= 0.9m']],
    ['Every pass of while (attempts < 3)', ['Only read in the loop: the same value on every pass', 'read in await SaveAsync(customer, amount);']],
    ['After the loop', ['returned: amount']],
  ]);
  assert.match(amount.roots[0].children![1].description!, /when coupon != null && coupon\.StartsWith\("SAVE"\)/);
  const attempts = await csharpValueTimeline(text, file, at('attempts++'));
  assert.equal(attempts.roots[1].children![0].label, 'Pass by pass: its value from outside the method, then its value from outside the method + 1, its value from outside the method + 2, … one step of +1 each pass');
  const total = await csharpValueTimeline(text, file, at('total = 0'));
  assert.equal(total.description, '3 changes in and around 1 loop, 1 read');
});

test('C# What feeds this value and What this value feeds: slices on the flowchart boxes', async () => {
  const chart = await csharpFlowChart(text, file, at('var amount'));
  const lines = (ids: number[]) => ids.map((id) => chart.nodes.find((n) => n.id === id)?.lines[0] ?? `#${id}`);
  const back = await csharpSlice(text, file, at('return amount') + 7, 'backward');
  assert.equal(back.name, 'amount');
  assert.equal(back.line, 111);
  assert.ok(lines(back.nodes).includes('var amount = cart.Price()'), lines(back.nodes).join(' | '));
  assert.ok(lines(back.nodes).includes('amount *= 0.9m'), lines(back.nodes).join(' | '));
  assert.ok(!lines(back.nodes).some((l) => l.startsWith('Log(')), lines(back.nodes).join(' | '));
  const forward = await csharpSlice(text, file, at('var amount') + 4, 'forward');
  assert.ok(lines(forward.nodes).includes('await SaveAsync(customer, amount)'), lines(forward.nodes).join(' | '));
  assert.ok(lines(forward.nodes).includes('return amount'), lines(forward.nodes).join(' | '));
});
