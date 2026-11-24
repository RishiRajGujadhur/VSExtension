import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { csharpFlowChart } from '../csharp/flow';

const file = 'c:/shop/Cart.cs';
const chartAt = (code: string, at: string, options = {}) => csharpFlowChart(code, file, code.indexOf(at), options);
const edgeList = (chart: Awaited<ReturnType<typeof chartAt>>) =>
  chart.edges.map((e) => `${chart.nodes[e.from].lines[0]} → ${chart.nodes[e.to].lines[0]}${e.label ? ` [${e.label}]` : ''}`);

const cart = `
namespace Shop {
  public class Cart {
    private decimal total;
    public decimal Price(IEnumerable<Item> items, string? coupon) {
      total = 0;
      foreach (var item in items) {
        if (item.Free) continue;
        total += item.Price;
      }
      if (coupon == null) {
        return total;
      } else if (coupon.Length > 10) {
        throw new ArgumentException("bad coupon");
      }
      return total * 0.9m;
    }
  }
}`;

test('C# flowchart: statements, a foreach with continue, if/else if, return and throw', async () => {
  const chart = await chartAt(cart, 'total = 0');
  assert.equal(chart.name, 'Cart.Price');
  assert.deepEqual(chart.nodes.map((n) => `${n.kind}: ${n.lines.join(' | ')}`), [
    'start: Cart.Price',
    'end: end',
    'statement: total = 0',
    'loop: foreach (var item in items)',
    'decision: item.Free',
    'statement: total += item.Price',
    'decision: coupon == null',
    'return: return total',
    'decision: coupon.Length > 10',
    'throw: throw new ArgumentException("bad coupon")',
    'return: return total * 0.9m',
  ]);
  const edges = edgeList(chart);
  assert.ok(edges.includes('foreach (var item in items) → item.Free [each item]'));
  assert.ok(edges.includes('item.Free → foreach (var item in items) [yes]'), 'continue goes back to the loop');
  assert.ok(edges.includes('foreach (var item in items) → coupon == null [done]'));
  assert.ok(edges.includes('throw new ArgumentException("bad coupon") → end [throws]'));
  assert.deepEqual(chart.paths.map((p) => p.ending).sort(), ['reaches the end', 'reaches the end', 'reaches the end', 'returns total', 'returns total', 'returns total', 'returns total * 0.9m', 'returns total * 0.9m', 'returns total * 0.9m', 'throws new ArgumentException("bad coupon")', 'throws new ArgumentException("bad coupon")', 'throws new ArgumentException("bad coupon")'].filter((e) => chart.paths.some((p) => p.ending === e)).sort());
  // Each box knows where it is, for opening it and following the cursor.
  const totalBox = chart.nodes.find((n) => n.lines[0] === 'total = 0')!;
  assert.deepEqual(totalBox.location && [totalBox.location.file, totalBox.location.line], [file, 5]);
  // Dependences: total is set in the first box and read by the returns; coupon comes from the parameters.
  const data = chart.dependences.data.map((d) => `${chart.nodes[d.from].lines[0]} → ${chart.nodes[d.to].lines[0]} (${d.name})`);
  assert.ok(data.includes('total = 0 → return total (total)'), data.join('\n'));
  assert.ok(data.includes('Cart.Price → coupon == null (coupon)'), data.join('\n'));
});

test('C# flowchart: switch sections with patterns and fall-through labels, break and default', async () => {
  const code = `class A { string Grade(int score) {
    switch (score) {
      case 100: case 99: return "top";
      case > 80 when score % 2 == 0: return "even high";
      default: break;
    }
    return "other";
  } }`;
  const chart = await chartAt(code, 'switch');
  const edges = edgeList(chart);
  assert.ok(edges.includes('switch (score) → return "top" [case 99]'), edges.join('\n'));
  assert.ok(edges.includes('switch (score) → return "top" [case 100]'), edges.join('\n'));
  assert.ok(edges.includes('switch (score) → return "even high" [case > 80 when score % 2 == 0]'), edges.join('\n'));
  assert.ok(edges.includes('switch (score) → return "other" [default]'), edges.join('\n'));
  assert.equal(chart.paths.length, 4);
});

test('C# flowchart: try/catch/finally, using, while, do-while and an impossible path', async () => {
  const code = `class A { void Save(Doc doc, bool ok) {
    using (var file = Open(doc)) {
      try {
        if (!ok) throw new IOException();
        file.Write(doc);
      } catch (IOException e) when (e.HResult == 1) {
        Log(e);
      } finally {
        file.Flush();
      }
    }
    while (doc.Dirty) doc.Retry();
    do { doc.Tick(); } while (doc.Busy);
    if (ok) Done();
    if (!ok) Fail();
  } }`;
  const chart = await chartAt(code, 'using');
  const kinds = chart.nodes.map((n) => n.kind);
  assert.ok(kinds.includes('catch') && kinds.includes('finally') && kinds.filter((k) => k === 'loop').length === 2);
  const edges = edgeList(chart);
  assert.ok(edges.includes('throw new IOException() → catch (IOException e) when (e.HResult == 1) [throws]'), edges.join('\n'));
  assert.ok(edges.some((e) => e.startsWith('using (var file = Open(doc)) →')));
  assert.ok(edges.includes('do … while (doc.Busy) → doc.Tick() [yes]'), edges.join('\n'));
  // ok is never assigned: taking "if (ok)" yes and then "if (!ok)" yes cannot happen.
  assert.ok(chart.paths.some((p) => !p.feasible && /ok cannot be both true and false/.test(p.reason ?? '')), 'an impossible path is flagged');
});

test('C# flowchart: expression-bodied members, accessors, constructors and lambdas', async () => {
  const code = `class Shop {
    int Count => items.Count;
    public decimal Total { get { if (empty) return 0; return sum; } set => sum = value; }
    public Shop(int size) : base(size) { items = new(); }
    void Run() { Func<int, int> twice = x => { if (x > 0) return x * 2; return 0; }; }
  }`;
  const expression = await chartAt(code, 'items.Count');
  assert.equal(expression.nodes.find((n) => n.kind === 'return')?.lines[0], 'return items.Count');
  const getter = await chartAt(code, 'if (empty)');
  assert.equal(getter.name, 'get Total');
  assert.ok(getter.nodes.some((n) => n.kind === 'decision' && n.lines[0] === 'empty'));
  const setter = await chartAt(code, 'sum = value');
  assert.equal(setter.name, 'set Total');
  assert.ok(setter.dependences.data.some((d) => d.name === 'value' && d.parameter), 'value is the setter parameter');
  const constructor = await chartAt(code, 'items = new()');
  assert.equal(constructor.name, 'new Shop');
  const lambda = await chartAt(code, 'x > 0');
  assert.equal(lambda.name, 'lambda');
  assert.ok(lambda.nodes.some((n) => n.lines[0] === 'x > 0'));
});

test('C# flowchart: outside any method, it says where to put the cursor', async () => {
  await assert.rejects(chartAt('class A { int x; }', 'int x'), /Put the cursor inside a C# method/);
});

test('C# Find usages by name (no language server): declaration, writes and reads, with where each is', async () => {
  const { csharpUsagesByName } = await import('../csharp/nameSearch');
  const fs = await import('fs');
  const path = await import('path');
  const text = fs.readFileSync(path.resolve(__dirname, '../../docs/demo/csharp/OrderService.cs'), 'utf8');
  const file = 'c:/demo/OrderService.cs';
  const usages = await csharpUsagesByName([{ file, text }, { file: 'c:/demo/Other.cs', text: 'class Other { int attempts; void Go() { attempts--; } }' }], 'attempts', { file, offset: text.indexOf('attempts++') });
  const shown = usages.map((u) => `${u.kind} ${u.where} ${u.location.line + 1}${u.atCursor ? ' cursor' : ''}`);
  assert.deepEqual(shown, [
    'definition OrderService 53',
    'read OrderService.PlaceOrderAsync 89',
    'write OrderService.PlaceOrderAsync 91 cursor',
    'read OrderService.PlaceOrderAsync 97',
    'read OrderService.PlaceOrderAsync 99',
    'write OrderService.Refresh 128',
    'read OrderService.Refresh 128',
    'read OrderService.Refresh 129',
    'read OrderService.Refresh 129',
    'definition Other 1',
    'write Other.Go 1',
  ]);
});

test('C# flowchart: yield break ends the method, yield return is a step', async () => {
  const code = 'class A { IEnumerable<int> F(int[] xs) { foreach (var x in xs) { if (x < 0) yield break; yield return x; } } }';
  const chart = await chartAt(code, 'foreach');
  assert.deepEqual(chart.nodes.filter((n) => n.kind === 'return').map((n) => n.lines[0]), ['yield break']);
  assert.ok(chart.nodes.some((n) => n.kind === 'statement' && n.lines[0] === 'yield return x'));
});

test('C# flowchart facts: this.x = … and this.items.Add(…) set x and items (this is a keyword token in the grammar)', async () => {
  const { parseCSharp } = await import('../csharp/parser');
  const { buildCSharpFlow, csharpFunctionAt } = await import('../csharp/flow');
  const code = 'class Order { int total; List<int> items; void Reset(int start) { this.total = start; this.items.Add(start); if (this.total > 0) Log(other.total); } }';
  const tree = await parseCSharp(code);
  try {
    const graph = buildCSharpFlow(csharpFunctionAt(tree.rootNode, code.indexOf('this.total'))!, file);
    const facts = graph.nodes.find((n) => n.facts?.source.some((l) => l.startsWith('this.total = start')))!.facts!;
    assert.ok(facts.defines.has('total') && facts.replaces.has('total'), [...facts.defines].join(','));
    assert.ok(facts.defines.has('items') && !facts.replaces.has('items'), 'Add changes items without replacing it');
    assert.ok(!facts.reads.has('total'), 'this.total on the left of = is not a read');
    const decision = graph.nodes.find((n) => n.facts?.source[0]?.startsWith('this.total > 0'))!.facts!;
    assert.ok(decision.reads.has('total'), 'this.total in a condition reads total');
    const call = graph.nodes.find((n) => n.facts?.source[0]?.startsWith('Log('))!.facts!;
    assert.ok(!call.reads.has('total'), 'other.total is not this variable');
  } finally {
    tree.delete();
  }
});
