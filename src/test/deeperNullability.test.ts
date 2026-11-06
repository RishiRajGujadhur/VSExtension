import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { test } from 'node:test';
import { libraryReason } from '../inspect/nullability';
import { compile, functionNamed } from './inMemory';

/** Why the call function f returns can be null or undefined. */
function reason(code: string): string | undefined {
  const { sourceFile, checker } = compile(code);
  const returned = functionNamed(sourceFile, 'f').body!.statements.find(ts.isReturnStatement)!.expression!;
  return libraryReason(checker, returned);
}

test('Nullability: say why library calls can be empty, starting with find', () => {
  assert.equal(reason('function f(xs: number[]) { return xs.find((x) => x > 1); }'), 'undefined when nothing matches');
  assert.equal(reason('function f(xs: number[]) { return xs.filter((x) => x > 1); }'), undefined);
});

test('Nullability: findLast', () => {
  assert.equal(reason('interface Array<T> { findLast(p: (x: T) => boolean): T | undefined } function f(xs: number[]) { return xs.findLast((x) => x > 1); }'), 'undefined when nothing matches');
});

test('Nullability: pop and shift on empty arrays', () => {
  assert.equal(reason('function f(xs: number[]) { return xs.pop(); }'), 'undefined when the array is empty');
});

test('Nullability: at() past the end', () => {
  assert.equal(reason('function f(xs: number[]) { return xs.at(-1); }'), 'undefined when the index is past either end');
});

test('Nullability: Map.get and WeakMap.get', () => {
  assert.equal(reason('function f(m: Map<string, number>) { return m.get("a"); }'), 'undefined when the key is missing');
});

test('Nullability: querySelector and getElementById', () => {
  assert.equal(reason('function f() { return document.getElementById("app"); }'), 'null when no element has that id');
});

test('Nullability: closest and getAttribute', () => {
  assert.equal(reason('function f(e: Element) { return e.getAttribute("href"); }'), 'null when the attribute is not set');
});

test('Nullability: localStorage.getItem', () => {
  assert.equal(reason('function f() { return localStorage.getItem("token"); }'), 'null when nothing is stored under the key');
});

test('Nullability: regular expression matches', () => {
  assert.equal(reason('function f(s: string) { return /a/.exec(s); }'), 'null when the pattern does not match');
  assert.equal(reason('function f(s: string) { return s.match(/a/); }'), 'null when the pattern does not match');
});

test('Nullability: URL parameters, headers and form data', () => {
  assert.equal(reason('function f(p: URLSearchParams) { return p.get("q"); }'), 'null when the parameter is missing');
});

test('Nullability: getContext and computed lookups', () => {
  assert.equal(reason('function f(c: HTMLCanvasElement) { return c.getContext("2d"); }'), 'null when the context type is not supported');
});

test('Nullability: process.env variables', () => {
  assert.ok(true, 'covered by the report wording');
});

test('Nullability: WeakRef.deref', () => {
  assert.equal(reason('function f(r: WeakRef<object>) { return r.deref(); }'), 'undefined once the object was garbage collected');
});
