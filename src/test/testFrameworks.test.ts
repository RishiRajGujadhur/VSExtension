import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { test } from 'node:test';
import { detectFramework, testCommand } from '../analysis/testCommand';
import { discoverTests } from '../analysis/testDiscovery';

/** A throwaway package folder with the given files. */
function pkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impact-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const discover = (code: string, file = 'a.test.ts') => discoverTests(ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true));
const line = (c: { command: string; args: string[] }) => [c.command, ...c.args].join(' ');

test('Test impact: run tests with pnpm, yarn or bun when the project uses them', () => {
  assert.equal(line(testCommand('vitest', ['a.test.ts'], 'adds', pkg({ 'pnpm-lock.yaml': '' }))), 'pnpm exec vitest run a.test.ts -t adds');
  assert.equal(line(testCommand('jest', ['a.test.ts'], undefined, pkg({ 'yarn.lock': '' }))), 'yarn jest --runTestsByPath a.test.ts');
  assert.equal(line(testCommand('mocha', ['a.test.ts'], undefined, pkg({ 'package-lock.json': '' }))), 'npx mocha a.test.ts');
});

test('Test impact: detect the framework from its config file', () => {
  assert.equal(detectFramework(pkg({ 'package.json': '{}', 'vitest.config.ts': '' })), 'vitest');
  assert.equal(detectFramework(pkg({ 'package.json': '{}', '.mocharc.json': '{}' })), 'mocha');
  assert.equal(detectFramework(pkg({ 'package.json': '{}' })), undefined);
});

test('Test impact: Bun test', () => {
  const found = discover("import { test, expect } from 'bun:test';\ntest('adds', () => expect(1).toBe(1));");
  assert.deepEqual(found.cases.map((c) => `${c.framework} ${c.title}`), ['bun adds']);
  assert.equal(line(testCommand('bun', ['a.test.ts'], 'adds', pkg({}))), 'bun test a.test.ts -t adds');
});

test('Test impact: AVA', () => {
  const found = discover("import t from 'ava';\nt('adds', (x) => x.pass());");
  assert.deepEqual(found.cases.map((c) => `${c.framework} ${c.title}`), ['ava adds']);
  assert.equal(line(testCommand('ava', ['a.test.ts'], 'adds', pkg({ 'package-lock.json': '' }))), 'npx ava a.test.ts');
});

test('Test impact: tape and tap', () => {
  const found = discover("import test from 'tape';\ntest('adds', (t) => t.end());");
  assert.deepEqual(found.cases.map((c) => `${c.framework} ${c.title}`), ['tape adds']);
});

test('Test impact: Deno.test', () => {
  const found = discover("Deno.test('adds', () => {});");
  assert.deepEqual(found.cases.map((c) => `${c.framework} ${c.title}`), ['deno adds']);
  assert.equal(line(testCommand('deno', ['a.test.ts'], 'adds', pkg({}))), 'deno test --allow-all a.test.ts --filter /adds/');
});

test('Test impact: Cypress specs', () => {
  assert.equal(discover("describe('cart', () => { it('adds', () => {}); });", 'cypress/e2e/cart.cy.ts').isTestFile, true);
  assert.equal(detectFramework(pkg({ 'package.json': JSON.stringify({ devDependencies: { cypress: '13' } }) })), 'cypress');
  assert.equal(line(testCommand('cypress', ['a.cy.ts', 'b.cy.ts'], undefined, pkg({ 'package-lock.json': '' }))), 'npx cypress run --spec a.cy.ts,b.cy.ts');
});
