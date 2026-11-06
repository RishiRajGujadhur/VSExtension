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
