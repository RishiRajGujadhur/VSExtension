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
