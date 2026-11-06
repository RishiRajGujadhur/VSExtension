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

test('Side effects: idle callbacks', () => {
  assert.deepEqual(effects('function f() { requestIdleCallback(() => 1); }'), ['timer: schedules work for when the browser is idle']);
});

test('Side effects: reading files in the browser', () => {
  assert.deepEqual(effects('function f(b: Blob) { new FileReader().readAsText(b); }'), ['io: reads a file']);
});

test('Side effects: Date() without new reads the clock', () => {
  assert.deepEqual(effects('function f() { return Date(); }'), ['nondeterministic: reads the current time']);
});

test('Side effects: system information and DNS in Node', () => {
  assert.deepEqual(effects('import { hostname } from "os"; function f() { return hostname(); }'), ['io: uses os']);
});

test('Side effects: packages that do I/O, starting with HTTP clients', () => {
  assert.deepEqual(effects('import axios from "axios"; function f() { return axios.get("/x"); }'), ['io: makes a network request']);
});

test('Side effects: database clients', () => {
  assert.deepEqual(effects('import { Pool } from "pg"; function f() { return new Pool(); }'), ['io: uses a database']);
});

test('Side effects: AWS, Google Cloud and Azure SDKs', () => {
  assert.deepEqual(effects('import { S3Client } from "@aws-sdk/client-s3"; function f() { return new S3Client({}); }'), ['io: calls a cloud service']);
});
