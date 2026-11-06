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

test('Exception flow: new WebSocket and new Worker', () => {
  assert.deepEqual(raised('function f(u: string) { return new WebSocket(u); }'), ['new WebSocket(): SyntaxError on an invalid URL']);
});

test('Exception flow: buffers with invalid sizes', () => {
  assert.deepEqual(raised('function f(n: number) { return new ArrayBuffer(n); }'), ['new ArrayBuffer(): RangeError on an invalid length']);
});

test('Exception flow: require and process.chdir', () => {
  assert.deepEqual(raised('declare function require(id: string): unknown; function f() { return require("x"); }'), ["require(): Error when the module can't be found"]);
});

test('Exception flow: Node\'s assert', () => {
  assert.deepEqual(raised('declare function assert(v: unknown): void; function f(v: unknown) { assert(v); }'), ['assert(): AssertionError when the check fails']);
});

test('Exception flow: YAML and TOML parsers', () => {
  assert.deepEqual(raised('declare const YAML: { parse(s: string): unknown }; function f(s: string) { return YAML.parse(s); }'), ['YAML.parse(): YAMLParseError on invalid YAML']);
});

test('Exception flow: methods that throw, starting with reduce on an empty array', () => {
  assert.deepEqual(raised('function f(xs: number[]) { return xs.reduce((a, b) => a + b); }'), ['xs.reduce(): TypeError on an empty array without an initial value']);
  assert.deepEqual(raised('function f(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }'), []);
});

test('Exception flow: toISOString on an invalid date', () => {
  assert.deepEqual(raised('function f(d: Date) { return d.toISOString(); }'), ['d.toISOString(): RangeError on an invalid date']);
});

test('Exception flow: number formatting out of range', () => {
  assert.deepEqual(raised('function f(n: number, d: number) { return n.toFixed(d); }'), ['n.toFixed(): RangeError when the digits are out of range']);
});

test('Exception flow: string repeat and normalize', () => {
  assert.deepEqual(raised('function f(s: string, n: number) { return s.repeat(n); }'), ['s.repeat(): RangeError on a negative or infinite count']);
});

test('Exception flow: invalid CSS selectors', () => {
  assert.deepEqual(raised('function f(s: string) { return document.querySelector(s); }'), ['document.querySelector(): SyntaxError on an invalid selector']);
});

test('Exception flow: full browser storage', () => {
  assert.deepEqual(raised('function f() { localStorage.setItem("k", "v"); }'), ['localStorage.setItem(): QuotaExceededError when storage is full']);
});
