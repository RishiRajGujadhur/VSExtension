import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { test } from 'node:test';
import { detectPatterns } from '../inspect/patterns';

const names = (code: string) => detectPatterns(ts.createSourceFile('a.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).map((p) => p.name);
const has = (code: string, name: string) => assert.ok(names(code).includes(name), `${name} not in ${names(code).join(', ')}`);
const lacks = (code: string, name: string) => assert.ok(!names(code).includes(name), `${name} found`);

test('Adapter is recognized', () => {
  has('interface Logger { log(m: string): void; warn(m: string): void } class ConsoleAdapter implements Logger { constructor(private readonly out: Console) {} log(m: string) { this.out.info(m); } warn(m: string) { this.out.error(m); } }', 'Adapter');
});

test('Facade is recognized', () => {
  has('class Checkout { constructor(private cart: Cart, private payments: Payments, private mail: Mailer) {} placeOrder() { this.cart.lock(); this.payments.charge(); this.mail.send(); } }', 'Facade');
});

test('Proxy is recognized', () => {
  has('const settings = new Proxy({}, { get: (t, k) => 1 });', 'Proxy');
});

test('Decorator is recognized', () => {
  has('interface Store { get(k: string): string } class CachingStore implements Store { constructor(private inner: Store) {} get(k: string) { return this.inner.get(k); } }', 'Decorator');
  lacks('interface Store { get(k: string): string } class CachingStore implements Store { constructor(private inner: Store) {} get(k: string) { return this.inner.get(k); } }', 'Adapter');
});

test('Template method is recognized', () => {
  has('abstract class Report { abstract body(): string; render() { return "<h1>" + this.body(); } }', 'Template method');
});

test('State is recognized', () => {
  has('class Light { private state: LightState = new Off(); press() { this.state.press(this); } describe() { return this.state.name(); } }', 'State');
});
