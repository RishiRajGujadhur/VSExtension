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

test('Side effects: sending email', () => {
  assert.deepEqual(effects('import nodemailer from "nodemailer"; function f() { return nodemailer.createTransport({}); }'), ['io: sends email']);
});

test('Side effects: file system packages', () => {
  assert.deepEqual(effects('import fse from "fs-extra"; function f() { return fse.readJson("a.json"); }'), ['io: uses the file system']);
});

test('Side effects: running processes', () => {
  assert.deepEqual(effects('import { execa } from "execa"; function f() { return execa("ls"); }'), ['io: runs another program']);
});

test('Side effects: random IDs from uuid and nanoid', () => {
  assert.deepEqual(effects('import { v4 } from "uuid"; function f() { return v4(); }'), ['nondeterministic: produces random ids']);
});

test('Side effects: Node\'s crypto random functions', () => {
  assert.deepEqual(effects('import { randomBytes, createHash } from "crypto"; function f() { createHash("sha256"); return randomBytes(8); }'), ['nondeterministic: produces random values']);
});

test('Mutation tracking: Date setters', () => {
  assert.ok(effects('function f(d: Date) { d.setFullYear(2020); }').some((e) => e.startsWith('mutates-parameter')));
  assert.deepEqual(effects('function f(d: Date) { return d.getFullYear(); }'), []);
});

test('Mutation tracking: URLSearchParams, Headers and FormData', () => {
  assert.ok(effects('function f(p: URLSearchParams) { p.set("q", "1"); }').some((e) => e.startsWith('mutates-parameter')));
});

test('Mutation tracking: classList changes', () => {
  assert.ok(effects('function f(e: Element) { e.classList.add("on"); }').some((e) => e.startsWith('mutates-parameter')));
});

test('Mutation tracking: DOM tree and attribute changes, through element subtypes', () => {
  assert.ok(effects('function f(e: HTMLDivElement) { e.setAttribute("x", "1"); }').some((e) => e.startsWith('mutates-parameter')));
});

test('Mutation tracking: typed arrays', () => {
  assert.ok(effects('function f(b: Uint8Array) { b.fill(0); }').some((e) => e.startsWith('mutates-parameter')));
});

test('Mutation tracking: Object.freeze, seal and Reflect writes', () => {
  assert.ok(effects('function f(o: object) { Object.freeze(o); }').some((e) => e.startsWith('mutates-parameter')));
  assert.ok(effects('function f(o: object) { Reflect.set(o, "a", 1); }').some((e) => e.startsWith('mutates-parameter')));
});

test('Side effects: opening windows and printing', () => {
  assert.deepEqual(effects('function f() { print(); }'), ['io: opens the print dialog']);
});

test('Side effects: performance marks read the clock', () => {
  assert.deepEqual(effects('function f() { performance.mark("a"); }'), ['nondeterministic: reads the current time']);
});

test('Side effects: logging libraries', () => {
  assert.deepEqual(effects('import pino from "pino"; function f() { return pino(); }'), ['io: writes logs']);
});

test('Side effects: error reporting and analytics SDKs', () => {
  assert.deepEqual(effects('import * as Sentry from "@sentry/node"; function f(e: Error) { Sentry.captureException(e); }'), ['io: sends telemetry']);
});
