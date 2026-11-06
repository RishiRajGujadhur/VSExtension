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
