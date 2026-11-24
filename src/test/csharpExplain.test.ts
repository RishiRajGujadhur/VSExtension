import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { explainCode } from '../explain/explainCode';
import { explanationReel } from '../explain/explainReel';
import { csharpDeclarationOf, csharpHighlight } from '../csharp/explainTarget';
import { callPhrase, conditionWords } from '../reel/words';
import { csharpDataFlow } from '../csharp/charts';

const file = 'c:/shop/OrderService.cs';
const code = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
const explainAt = (needle: string, length = needle.length, from = 0) => {
  const at = code.indexOf(needle, from);
  return explainCode(file, code, at, at + length);
};

test('C# Explain: a method name, declared or called, explains the whole method with its facts', async () => {
  const placed = await explainAt('PlaceOrderAsync');
  assert.equal(placed.subject, 'the method PlaceOrderAsync()');
  assert.equal(placed.summary, 'PlaceOrderAsync is an async method that takes the customer and the coupon and returns a decimal, once it finishes.');
  assert.equal(placed.purpose?.text, 'Places the order');
  assert.deepEqual(placed.facts!.inputs.map((i) => `${i.name}: ${i.type}`), ['customer: string', 'coupon: string?']);
  assert.deepEqual(placed.facts!.output, { type: 'decimal', later: true, values: ['amount'], nothing: false });
  assert.deepEqual(placed.facts!.effects, ['changes attempts (++)', 'calls SaveAsync() and Log() for what they do, which may change things']);
  assert.equal(placed.walk!.signature, 'public async Task<decimal> PlaceOrderAsync(string customer, string? coupon)');
  assert.deepEqual(placed.steps.slice(0, 3), ['If the customer is empty or blank, it fails with "A customer is needed".', 'It gets the price of the cart.', 'It checks whether the coupon is given and the coupon starts with "SAVE".']);

  // Called: that method. An interface member: its implementation in the file.
  assert.equal((await explainAt('SaveAsync(customer', 'SaveAsync'.length)).subject, 'the method SaveAsync()');
  const price = await explainAt('Price();', 'Price'.length);
  assert.equal(price.subject, 'the method Price()');
  assert.ok(price.steps.length > 2, price.steps.join(' | '));
  // A collection the class owns, changed: said with its method.
  assert.deepEqual((await explainAt('Add(LineItem', 3)).facts!.effects, ['changes items (Add)']);
  // A parameter in the header: the whole method; a variable in the body: those lines.
  assert.equal((await explainAt('decimal amount)', 'decimal amount'.length)).subject, 'the method Grade()');
  assert.equal((await explainAt('coupon.StartsWith', 'coupon'.length)).subject, 'the highlighted lines in PlaceOrderAsync()');
});

test('C# Explain: a name declared in another file is looked up, and the video is built', async () => {
  const caller = 'class Checkout { void Pay(OrderService s) { s.Refund(10); } }';
  const hit = await csharpHighlight(caller, caller.indexOf('Refund'), caller.indexOf('Refund') + 6);
  assert.deepEqual(hit, { elsewhere: 'Refund' });
  const other = 'class OrderService { public void Refund(decimal amount) { Console.WriteLine(amount); } }';
  assert.equal(await csharpDeclarationOf(other, 'Refund'), other.indexOf('Refund'));
  assert.equal(await csharpDeclarationOf(other, 'Missing'), undefined);

  const placed = await explainAt('PlaceOrderAsync');
  const plan = explanationReel(placed, 'OrderService.cs')!;
  assert.equal(plan.meta.title, 'What PlaceOrderAsync() does');
  assert.ok(plan.scenes.filter((s) => s.kind === 'flow').length >= 3);
});

test('C# words: string checks, collection checks, .NET calls, number suffixes and Async names', () => {
  assert.equal(conditionWords('string.IsNullOrWhiteSpace(customer)'), 'the customer is empty or blank');
  assert.equal(conditionWords('!string.IsNullOrEmpty(name)'), 'the name is not empty');
  assert.equal(conditionWords('coupon.StartsWith("SAVE")'), 'the coupon starts with "SAVE"');
  assert.equal(conditionWords('items.Any()'), 'there are items');
  assert.equal(conditionWords('total > 0.5m'), conditionWords('total > 0.5'));
  assert.equal(callPhrase('Console.WriteLine(x)'), 'prints a message');
  assert.equal(callPhrase('await _db.SaveChangesAsync()'), 'saves the changes to the database');
  assert.equal(callPhrase('File.WriteAllText(p, s)'), 'writes a file');
  assert.equal(callPhrase('client.GetAsync(url)'), 'makes a request');
  assert.equal(callPhrase('cart.Price()'), 'gets the price of the cart');
  assert.match(callPhrase('RefreshAsync()') ?? '', /^refreshes/);
});

test('C# Data flow: the name twice in one place is one place the value goes', async () => {
  const report = await csharpDataFlow([{ file, text: code }], file, code.indexOf('attempts++'));
  const out = report.roots[1].children!.map((c) => `${c.label} | ${c.description?.split(' · ')[0]}`);
  assert.equal(out.filter((o) => o === 'attempts == attempts | decides a branch').length, 1, out.join('\n'));
});
