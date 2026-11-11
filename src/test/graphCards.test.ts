import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { peekLines } from '../structure/peekLines';
import { wrapLine } from '../inspect/controlFlowChart';
import { ActiveFeature } from '../ui/activeFeature';

test('peek: the trimmed line for the bar and up to 12 dedented lines for the hover card', () => {
  const file = ['function f() {', '    if (a) {', '      b();', '    }', '}'];
  const at = (i: number) => file[i];
  assert.deepEqual(peekLines(at, file.length, 1, 3), { code: 'if (a) {', block: 'if (a) {\n  b();\n}' });
  assert.deepEqual(peekLines(at, file.length, 9), { code: '', block: '' });
  const long = Array.from({ length: 30 }, (_, i) => `  line${i}`);
  const peek = peekLines((i) => long[i], long.length, 0, 29);
  assert.equal(peek.block.split('\n').length, 13);
  assert.match(peek.block, /… 18 more lines$/);
  assert.ok(peek.block.startsWith('line0\nline1'));
});

test('long lines wrap at a space, comma or bracket, continued lines indented', () => {
  assert.deepEqual(wrapLine('short'), ['short']);
  const parts = wrapLine('const total = items.map((item) => item.price * item.quantity).reduce((sum, value) => sum + value, 0);', 40);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 40), parts.join('|'));
  assert.ok(parts.slice(1).every((p) => p.startsWith('  ')));
  assert.equal(parts.join(' ').replace(/\s+/g, ''), 'const total = items.map((item) => item.price * item.quantity).reduce((sum, value) => sum + value, 0);'.replace(/\s+/g, ''));
  // A word longer than the width is cut.
  assert.ok(wrapLine('x'.repeat(100), 30).every((p) => p.length <= 30));
});

test('the active feature: the command run before a report, the previous one is the last run', () => {
  let now = 0;
  const active = new ActiveFeature(() => now);
  let changes = 0;
  active.onDidChange(() => changes++);
  active.noteInvoked('tsStructure.findUsages');
  active.reportShown();
  assert.equal(active.active, 'tsStructure.findUsages');
  active.set('tsStructure.controlFlow');
  assert.equal(active.last, 'tsStructure.findUsages');
  active.closed('tsStructure.controlFlow');
  assert.equal(active.active, undefined);
  assert.equal(active.last, 'tsStructure.controlFlow');
  // A report long after the command is not its result.
  active.noteInvoked('tsStructure.dataFlow');
  now = 200_000;
  active.reportShown();
  assert.equal(active.active, undefined);
  assert.equal(changes, 3);
});
