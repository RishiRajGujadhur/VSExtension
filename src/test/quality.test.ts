import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { test } from 'node:test';
import { qualityInspections } from '../inspect/quality';
import { applyTextEdits } from '../intentions/intentions';

const libs = new Map<string, ts.SourceFile | undefined>();
const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, noEmit: true };

/** The findings of one inspection on a snippet, type-checked with the standard library. */
function inspect(code: string, id: string) {
  const fileName = '/test.tsx';
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => {
    if (name === fileName) return ts.createSourceFile(name, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    if (!libs.has(name)) libs.set(name, read(name, version));
    return libs.get(name);
  };
  const exists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || exists(name);
  const program = ts.createProgram([fileName], options, host);
  const inspection = qualityInspections.find((i) => i.id === id)!;
  return inspection.run({ sourceFile: program.getSourceFile(fileName)!, program, checker: program.getTypeChecker() });
}

const messages = (code: string, id: string) => inspect(code, id).map((f) => f.message);
const fixed = (code: string, id: string) => {
  const fix = inspect(code, id)[0]?.fixes?.[0];
  return fix && applyTextEdits(code, fix.edits);
};

test('Self-assignment', () => {
  assert.deepEqual(messages('let a = 1; a = a;', 'selfAssignment'), ['a is assigned to itself, which does nothing.']);
  assert.equal(fixed('let a = 1;\na = a;\n', 'selfAssignment'), 'let a = 1;\n');
  assert.deepEqual(messages('let a = 1, b = 2; a = b;', 'selfAssignment'), []);
});

test('Comparison with NaN', () => {
  assert.deepEqual(messages('declare const x: number; if (x === NaN) {}', 'nanComparison'), ['Comparing with NaN is always false; use Number.isNaN().']);
  assert.equal(fixed('declare const x: number; const b = x !== NaN;', 'nanComparison'), 'declare const x: number; const b = !Number.isNaN(x);');
});

test('Async Promise executor', () => {
  assert.equal(messages('const p = new Promise(async (resolve) => { resolve(await f()); }); declare function f(): Promise<number>;', 'asyncPromiseExecutor').length, 1);
  assert.equal(messages('const p = new Promise((resolve) => resolve(1));', 'asyncPromiseExecutor').length, 0);
});

test('Empty catch block', () => {
  assert.equal(messages('try { f(); } catch {} declare function f(): void;', 'emptyCatch').length, 1);
  assert.equal(messages('try { f(); } catch { /* ignored */ } declare function f(): void;', 'emptyCatch').length, 0);
});

test('Assignment in a condition', () => {
  assert.equal(fixed('let x = 0; if (x = 1) {}', 'assignmentInCondition'), 'let x = 0; if (x === 1) {}');
  assert.equal(messages('let m: unknown; while ((m = next())) {} declare function next(): unknown;', 'assignmentInCondition').length, 0);
});

test('Repeated condition in an if chain', () => {
  assert.deepEqual(messages('declare const a: boolean; if (a) {} else if (!a) {} else if (a) {}', 'duplicateCondition'), ['Same condition as line 1: this branch never runs.']);
});

test('Identical branches', () => {
  assert.equal(messages('declare const a: boolean; if (a) { f(); } else { f(); } declare function f(): void;', 'identicalBranches').length, 1);
  assert.equal(fixed('declare const a: boolean; const x = a ? 1 : 1;', 'identicalBranches'), 'declare const a: boolean; const x = 1;');
});

test('Constant condition', () => {
  assert.deepEqual(messages('if (false) {} while (true) { break; }', 'constantCondition'), ['The condition is always false.']);
});

test('Comparison with itself', () => {
  assert.deepEqual(messages('declare const a: number; if (a === a) {}', 'selfComparison'), ['a is compared with itself.']);
  assert.equal(fixed('declare const a: number; const n = a !== a;', 'selfComparison'), 'declare const a: number; const n = Number.isNaN(a);');
});

test('Misspelled typeof result', () => {
  assert.deepEqual(messages("declare const x: unknown; if (typeof x === 'strng') {}", 'typeofTypo'), ["typeof never returns 'strng'; did you mean 'string'?"]);
  assert.deepEqual(messages("declare const x: unknown; if (typeof x === 'string') {}", 'typeofTypo'), []);
});

test('return in finally', () => {
  assert.equal(messages('function f() { try { return 1; } finally { return 2; } }', 'returnInFinally').length, 1);
});

test('Throwing a non-Error', () => {
  assert.equal(fixed("function f() { throw 'failed'; }", 'throwLiteral'), "function f() { throw new Error('failed'); }");
});

test('Expression with no effect', () => {
  assert.equal(messages('declare let a: number, b: number; a === b;', 'noEffectExpression').length, 1);
  assert.equal(messages("'use strict'; declare let a: number; a++;", 'noEffectExpression').length, 0);
});

test('debugger statement', () => {
  assert.equal(fixed('f();\ndebugger;\nf();\ndeclare function f(): void;', 'debuggerStatement'), 'f();\nf();\ndeclare function f(): void;');
});

test('console.log left in code', () => {
  assert.equal(fixed('const a = 1;\nconsole.log(a);\n', 'consoleLog'), 'const a = 1;\n');
});

test('parseInt without a radix', () => {
  assert.equal(fixed("const n = parseInt('12');", 'parseIntRadix'), "const n = parseInt('12', 10);");
});

test('Array index as React key', () => {
  assert.equal(messages('declare const items: string[]; const l = items.map((item, i) => <li key={i}>{item}</li>);', 'arrayIndexKey').length, 1);
  assert.equal(messages('declare const items: { id: string }[]; const l = items.map((item) => <li key={item.id} />);', 'arrayIndexKey').length, 0);
});

test('for…in over an array', () => {
  assert.equal(messages('declare const xs: number[]; for (const i in xs) {}', 'forInArray').length, 1);
  assert.equal(messages('declare const o: Record<string, number>; for (const k in o) {}', 'forInArray').length, 0);
});

test('Hole in an array literal', () => {
  assert.equal(messages('const a = [1, , 2];', 'sparseArray').length, 1);
  assert.equal(messages('let x, y; [x, , y] = [1, 2, 3];', 'sparseArray').length, 0);
});

test('instanceof Array', () => {
  assert.equal(fixed('declare const v: unknown; const a = v instanceof Array;', 'instanceofArray'), 'declare const v: unknown; const a = Array.isArray(v);');
});

test('eval or new Function', () => {
  assert.equal(messages("eval('1'); const f = new Function('return 1');", 'evalUse').length, 2);
});

test('String passed to a timer', () => {
  assert.equal(messages("setTimeout('tick()', 10);", 'timerString').length, 1);
});

test('new String, Number or Boolean', () => {
  assert.equal(fixed('const s = new String(1);', 'primitiveWrapper'), 'const s = String(1);');
});

test('Promise.resolve or reject in an async function', () => {
  assert.equal(fixed('async function f() { return Promise.resolve(1); }', 'promiseResolveInAsync'), 'async function f() { return 1; }');
  assert.equal(fixed('async function f(e: Error) { return Promise.reject(e); }', 'promiseResolveInAsync'), 'async function f(e: Error) { throw e; }');
});
