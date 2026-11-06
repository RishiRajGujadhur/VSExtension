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
