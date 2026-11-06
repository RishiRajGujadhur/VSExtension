import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { applyTextEdits, intentionsAt } from '../intentions/intentions';

/** Applies the intention `id` at the `¦` in `code`, or undefined when it is not offered there. */
function apply(code: string, id: string): string | undefined {
  const position = code.indexOf('¦');
  const text = code.replace('¦', '');
  const action = intentionsAt(ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true), position).find((a) => a.id === id);
  return action && applyTextEdits(text, action.edits);
}

const lines = (...l: string[]) => l.join('\n');

test('Replace \'?:\' with \'??\'', () => {
  assert.equal(apply('const v = a != null ¦? a : 0;', 'ternaryToNullish'), 'const v = a ?? 0;');
  assert.equal(apply("const v = a.b == null ¦? 'x' : a.b;", 'ternaryToNullish'), "const v = a.b ?? 'x';");
  assert.equal(apply('const v = a != null ¦? b : 0;', 'ternaryToNullish'), undefined);
  assert.equal(apply('const v = f() != null ¦? f() : 0;', 'ternaryToNullish'), undefined);
});

test('Replace \'&&\' check with \'?.\'', () => {
  assert.equal(apply('if (user ¦&& user.name) go();', 'optionalChain'), 'if (user?.name) go();');
  assert.equal(apply('while (node ¦&& node.next()) step();', 'optionalChain'), 'while (node?.next()) step();');
  assert.equal(apply('const n = user ¦&& user.name;', 'optionalChain'), undefined);
  assert.equal(apply('if (user ¦&& user.age > 1) go();', 'optionalChain'), undefined);
});

test('Replace \'indexOf\' check with \'includes\'', () => {
  assert.equal(apply('if (list.indexOf(x) ¦!== -1) {}', 'indexOfToIncludes'), 'if (list.includes(x)) {}');
  assert.equal(apply('const missing = list.indexOf(x) ¦=== -1;', 'indexOfToIncludes'), 'const missing = !list.includes(x);');
  assert.equal(apply('if (s.indexOf("a") ¦>= 0) {}', 'indexOfToIncludes'), 'if (s.includes("a")) {}');
  assert.equal(apply('if (list.indexOf(x) ¦> 0) {}', 'indexOfToIncludes'), undefined);
});

test('Remove \'else\' after \'return\'', () => {
  assert.equal(
    apply(lines('function f(a) {', '  i¦f (a) {', '    return 1;', '  } else {', '    go();', '    return 2;', '  }', '}'), 'removeElseAfterReturn'),
    lines('function f(a) {', '  if (a) {', '    return 1;', '  }', '  go();', '  return 2;', '}'),
  );
  assert.equal(apply(lines('function f(a) {', '  i¦f (a) {', '    go();', '  } else {', '    stop();', '  }', '}'), 'removeElseAfterReturn'), undefined);
});

test('Replace \'let\' with \'const\'', () => {
  assert.equal(apply('l¦et total = 1; use(total);', 'letToConst'), 'const total = 1; use(total);');
  assert.equal(apply('l¦et n = 1; n++;', 'letToConst'), undefined);
  assert.equal(apply('l¦et n = 1; [n] = [2];', 'letToConst'), undefined);
  assert.equal(apply('for (l¦et x of xs) use(x);', 'letToConst'), 'for (const x of xs) use(x);');
});

test('Replace \'var\' with \'let\'', () => {
  assert.equal(apply('function f() { v¦ar a = 1; return a; }', 'varToLet'), 'function f() { let a = 1; return a; }');
  assert.equal(apply('function f(x) { if (x) { v¦ar a = 1; } return a; }', 'varToLet'), undefined);
  assert.equal(apply('function f() { use(a); v¦ar a = 1; }', 'varToLet'), undefined);
});

test('Convert arrow function to function declaration', () => {
  assert.equal(apply('c¦onst add = (a: number, b: number) => a + b;', 'arrowToFunction'), lines('function add(a: number, b: number) {', '  return a + b;', '}'));
  assert.equal(apply('export c¦onst load = async (): Promise<void> => { await go(); };', 'arrowToFunction'), 'export async function load(): Promise<void> { await go(); }');
  assert.equal(apply('c¦onst f = () => this.x;', 'arrowToFunction'), undefined);
  assert.equal(apply('c¦onst f: Handler = () => 1;', 'arrowToFunction'), undefined);
});
