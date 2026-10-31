import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { applyTextEdits, intentionsAt } from '../intentions/intentions';

/** Applies the intention `id` at the `¦` in `code` and returns the result, or undefined when it is not offered. */
function apply(code: string, id: string, fileName = 'test.ts'): string | undefined {
  const position = code.indexOf('¦');
  const text = code.replace('¦', '');
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const action = intentionsAt(sourceFile, position).find((a) => a.id === id);
  return action && applyTextEdits(text, action.edits);
}

const lines = (...l: string[]) => l.join('\n');

test('invert if swaps branches and negates the condition smartly', () => {
  assert.equal(apply('i¦f (a === b) { x(); } else { y(); }', 'invertIf'), 'if (a !== b) { y(); } else { x(); }');
  assert.equal(apply('i¦f (!ready) go(); else wait();', 'invertIf'), 'if (ready) wait(); else go();');
  assert.equal(apply('i¦f (a && b > 1) x(); else y();', 'invertIf'), 'if (!a || b <= 1) y(); else x();');
  assert.equal(apply('i¦f (a || b && c) x(); else y();', 'invertIf'), 'if (!a && (!b || !c)) y(); else x();');
  assert.equal(apply('i¦f (a) x();', 'invertIf'), undefined);
});

test('ternary and if/else convert both ways', () => {
  assert.equal(
    apply(lines('function f() {', '  return a ¦? b : c;', '}'), 'ternaryToIf'),
    lines('function f() {', '  if (a) {', '    return b;', '  } else {', '    return c;', '  }', '}'),
  );
  assert.equal(apply('const x = a ¦? 1 : 2;', 'ternaryToIf'), lines('let x;', 'if (a) {', '  x = 1;', '} else {', '  x = 2;', '}'));
  assert.equal(apply('i¦f (a) { return b; } else { return c; }', 'ifToTernary'), 'return a ? b : c;');
  assert.equal(apply(lines('i¦f (ok) {', '  value = 1;', '} else {', '  value = 2;', '}'), 'ifToTernary'), 'value = ok ? 1 : 2;');
  assert.equal(apply(lines('i¦f (a) return 1;', 'return 2;'), 'ifToTernary'), 'return a ? 1 : 2;');
  assert.equal(apply('i¦f (a) { x = 1; } else { y = 2; }', 'ifToTernary'), undefined);
  assert.equal(apply('a ¦? b : c', 'flipTernary'), '!a ? c : b');
  assert.equal(apply('x > 1 ¦? b : c', 'flipTernary'), 'x <= 1 ? c : b');
});

test('nested ifs merge and && splits', () => {
  assert.equal(
    apply(lines('i¦f (a) {', '  if (b || c) {', '    run();', '  }', '}'), 'mergeNestedIfs'),
    lines('if (a && (b || c)) {', '  run();', '}'),
  );
  assert.equal(apply(lines('i¦f (a) {', '  // keep me', '  if (b) run();', '}'), 'mergeNestedIfs'), undefined);
  assert.equal(
    apply(lines('i¦f (a && b) {', '  run();', '}'), 'splitAndCondition'),
    lines('if (a) {', '  if (b) {', '    run();', '  }', '}'),
  );
});

test('if chains become switch statements with breaks', () => {
  const input = lines(
    'i¦f (kind === "a") {',
    '  one();',
    '} else if (kind === "b" || kind === "c") {',
    '  return two();',
    '} else {',
    '  const z = 1;',
    '  three(z);',
    '}',
  );
  assert.equal(
    apply(input, 'ifChainToSwitch'),
    lines(
      'switch (kind) {',
      '  case "a":',
      '    one();',
      '    break;',
      '  case "b":',
      '  case "c":',
      '    return two();',
      '  default: {',
      '    const z = 1;',
      '    three(z);',
      '    break;',
      '  }',
      '}',
    ),
  );
  assert.equal(apply('i¦f (a === 1) x(); else if (b === 2) y();', 'ifChainToSwitch'), undefined);
  assert.equal(apply(lines('for (;;) {', '  i¦f (a === 1) { break; } else if (a === 2) { y(); }', '}'), 'ifChainToSwitch'), undefined);
});

test("De Morgan's law in both directions", () => {
  assert.equal(apply('const v = a &¦& b;', 'deMorgan'), 'const v = !(!a || !b);');
  assert.equal(apply('const v = !(a &¦& !b);', 'deMorgan'), 'const v = !a || b;');
  assert.equal(apply('const v = x && !(a ¦&& b);', 'deMorgan'), 'const v = x && (!a || !b);');
  assert.equal(apply('const v = !(a ¦|| b);', 'deMorgan'), 'const v = !a && !b;');
});

test('comparisons flip', () => {
  assert.equal(apply('a ¦< b', 'flipComparison'), 'b > a');
  assert.equal(apply('count ¦=== 0', 'flipComparison'), '0 === count');
});

test('string concatenation becomes a template literal', () => {
  assert.equal(apply("const s = 'Hello, ' ¦+ name + '!';", 'concatToTemplate'), 'const s = `Hello, ${name}!`;');
  assert.equal(apply("const s = a + b ¦+ ' total';", 'concatToTemplate'), 'const s = `${a + b} total`;');
  assert.equal(apply("const s = 'a`b' ¦+ x + \"${y}\\n\";", 'concatToTemplate'), 'const s = `a\\`b${x}\\${y}\\n`;');
  assert.equal(apply('const n = a ¦+ b;', 'concatToTemplate'), undefined);
});

test('loops convert to for...of', () => {
  assert.equal(
    apply(lines('f¦or (let i = 0; i < items.length; i++) {', '  total += items[i].price;', '}'), 'forIndexToForOf'),
    lines('for (const item of items) {', '  total += item.price;', '}'),
  );
  assert.equal(apply(lines('f¦or (let i = 0; i < items.length; i++) {', '  log(i, items[i]);', '}'), 'forIndexToForOf'), undefined);
  assert.equal(apply(lines('f¦or (let i = 0; i < items.length; i++) {', '  items[i] = 0;', '}'), 'forIndexToForOf'), undefined);
  assert.equal(
    apply(lines('users.for¦Each((user) => {', '  if (!user.active) return;', '  send(user);', '});'), 'forEachToForOf'),
    lines('for (const user of users) {', '  if (!user.active) continue;', '  send(user);', '}'),
  );
  assert.equal(apply('list.for¦Each((x, i) => log(i, x));', 'forEachToForOf'), lines('for (const [i, x] of list.entries()) {', '  log(i, x);', '}'));
  assert.equal(apply('list.for¦Each((x) => { return x * 2; });', 'forEachToForOf'), undefined);
  assert.equal(apply('list.for¦Each(async (x) => { await save(x); });', 'forEachToForOf'), undefined);
});

test('arrow bodies and function expressions convert', () => {
  assert.equal(apply('const f = (x) =¦> x * 2;', 'arrowToBlockBody'), lines('const f = (x) => {', '  return x * 2;', '};'));
  assert.equal(apply('const f = () =¦> ({ a: 1 });', 'arrowToBlockBody'), lines('const f = () => {', '  return { a: 1 };', '};'));
  assert.equal(apply('const f = () =¦> { return { a: 1 }; };', 'arrowToExpressionBody'), 'const f = () => ({ a: 1 });');
  assert.equal(apply('const f = async function ¦(a: number): Promise<number> { return a; };', 'functionToArrow'), 'const f = async (a: number): Promise<number> => { return a; };');
  assert.equal(apply('const f = function ¦() { return this.x; };', 'functionToArrow'), undefined);
  assert.equal(apply('const f = function ¦() { return () => arguments.length; };', 'functionToArrow'), undefined);
  assert.equal(apply('const f = function ¦() { return function () { return this; }; };', 'functionToArrow'), 'const f = () => { return function () { return this; }; };');
});

test('braces are added and removed safely', () => {
  assert.equal(apply(lines('i¦f (a) run();', 'else stop();'), 'addBraces'), lines('if (a) {', '  run();', '} else {', '  stop();', '}'));
  assert.equal(apply('wh¦ile (x) step();', 'addBraces'), lines('while (x) {', '  step();', '}'));
  assert.equal(apply(lines('i¦f (a) {', '  run();', '}'), 'removeBraces'), 'if (a) run();');
  assert.equal(apply(lines('i¦f (a) {', '  run();', '} else {', '  stop();', '}'), 'removeBraces'), lines('if (a) run();', 'else stop();'));
  assert.equal(apply(lines('i¦f (a) {', '  if (b) run();', '} else {', '  stop();', '}'), 'removeBraces'), lines('if (a) {', '  if (b) run();', '} else stop();'));
  assert.equal(apply(lines('i¦f (a) {', '  const x = 1;', '}'), 'removeBraces'), undefined);
});

test('declarations split', () => {
  assert.equal(apply('export const ¦a = 1, b = 2;', 'splitDeclarations'), lines('export const a = 1;', 'export const b = 2;'));
  assert.equal(apply('const ¦total: number = compute();', 'splitInitializer'), lines('let total: number;', 'total = compute();'));
});

test('only intentions that apply are offered', () => {
  const sourceFile = ts.createSourceFile('t.ts', 'const x = 1;', ts.ScriptTarget.Latest, true);
  const ids = intentionsAt(sourceFile, 6).map((a) => a.id);
  assert.deepEqual(ids, ['splitInitializer']);
});
