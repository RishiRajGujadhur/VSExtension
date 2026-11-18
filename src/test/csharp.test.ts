import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyCSharpUsage } from '../csharp/usageKind';

/** The usage of `name` on the line, as Find usages files it for C#. */
const kind = (line: string, name = 'total') => {
  const at = line.indexOf(name);
  return classifyCSharpUsage(line, at, at + name.length);
};

test('C# usages: calls, object creation, writes and reads are told apart from the code around them', () => {
  assert.equal(kind('var t = total(items);'), 'call');
  assert.equal(kind('var t = total<int>(items);'), 'call');
  assert.equal(kind('var c = new Cart(items);', 'Cart'), 'call');
  assert.equal(kind('total = 0;'), 'write');
  assert.equal(kind('total += item.Price;'), 'write');
  assert.equal(kind('total ??= 0;'), 'write');
  assert.equal(kind('total++;'), 'write');
  assert.equal(kind('--total;'), 'write');
  assert.equal(kind('Parse(text, out total);'), 'write');
  assert.equal(kind('if (total == 0) return;'), 'read');
  assert.equal(kind('Func<int> f = () => total;'), 'read');
  assert.equal(kind('var x = total => 1;'), 'read');
  assert.equal(kind('Console.WriteLine(total);'), 'read');
});
