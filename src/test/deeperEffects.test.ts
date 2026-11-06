import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { EffectAnalyzer } from '../inspect/effects';
import { compile, functionNamed } from './inMemory';

/** The effects of function f, as "kind: description". */
function effects(code: string): string[] {
  const { sourceFile, checker } = compile(code);
  return new EffectAnalyzer(checker).effectsOf(functionNamed(sourceFile, 'f')).map((e) => `${e.kind}: ${e.description}`);
}

test('Side effects: cross-window and cross-tab messaging', () => {
  assert.deepEqual(effects('function f() { new BroadcastChannel("c").postMessage(1); }'), ['io: sends messages to other tabs']);
});

test('Side effects: notifications', () => {
  assert.deepEqual(effects('function f() { new Notification("Saved"); }'), ['io: shows a system notification']);
});

test('Side effects: Cache Storage and cookies', () => {
  assert.deepEqual(effects('async function f() { await caches.open("v1"); }'), ['io: uses the Cache Storage']);
});

test('Side effects: web workers', () => {
  assert.deepEqual(effects('function f() { return new Worker("w.js"); }'), ['io: starts a background worker']);
});
