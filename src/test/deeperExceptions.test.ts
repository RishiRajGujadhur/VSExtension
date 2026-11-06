import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThrowAnalyzer } from '../inspect/exceptionFlow';
import { compile, functionNamed } from './inMemory';

/** What function f can throw. */
function raised(code: string): string[] {
  const { sourceFile, checker } = compile(code);
  return new ThrowAnalyzer(checker).raised(functionNamed(sourceFile, 'f')).map((p) => p.description);
}

test('Exception flow: more Intl constructors', () => {
  assert.deepEqual(raised('function f() { return new Intl.PluralRules("en"); }'), ['new Intl.PluralRules(): RangeError on an invalid locale or option']);
});

test('Exception flow: new Function and eval', () => {
  assert.deepEqual(raised('function f(s: string) { return new Function(s); }'), ['new Function(): SyntaxError on invalid code']);
});
