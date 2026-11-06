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
