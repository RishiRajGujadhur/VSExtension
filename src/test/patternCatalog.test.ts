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
