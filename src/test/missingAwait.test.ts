import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { runInspections } from '../inspect/inspection';
import { missingAwait } from '../inspect/missingAwait';
import { applyTextEdits } from '../intentions/intentions';
import { fixtures, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/async.ts');

function inspect(text?: string) {
  const project = virtualProject('inspect', 'src/async.ts');
  if (text !== undefined) {
    project.setText(file, text);
  }
  const program = project.program();
  const sourceFile = program.getSourceFile(file)!;
  return { sourceFile, findings: runInspections([missingAwait], { sourceFile, program, checker: program.getTypeChecker() }) };
}

test('dropped promises are found directly, through wrappers and through helpers', () => {
  const { sourceFile, findings } = inspect();
  const found = findings.map((f) => `${sourceFile.text.slice(f.start, f.end)} | ${f.message.split(/[,.] /)[0]}`);
  assert.deepEqual(found, [
    "loadUser('a') | The promise returned by loadUser() (from fetchUser()) is not awaited",
    "fetchUser('e') | fetchUser('e') is a promise",
    "fetchUser('g') | fetchUser('g') is a promise",
    "fetchUser('h') | fetchUser('h') is a promise and is converted to the text \"[object Promise]\"",
    'forEach | forEach ignores the promises returned by an async callback',
    "loadUser('i') | This promise is returned without await inside try",
    "fetchUser('j') | The promise returned by fetchUser() is neither awaited nor returned",
  ]);
  const helper = findings[1];
  assert.match(helper.message, /relay\(value\) → logLater\(value\) never awaits it/);
  assert.equal(helper.related?.length, 2);
});

test('the add-await fix produces an awaited call, and suppression comments hide findings', () => {
  const { sourceFile, findings } = inspect();
  const fix = findings[0].fixes!.find((f) => f.title === 'Add await')!;
  assert.match(applyTextEdits(sourceFile.text, fix.edits), /\n {2}await loadUser\('a'\);/);

  const suppressed = sourceFile.text.replace("  loadUser('a');", "  // ts-structure-ignore-next-line missingAwait\n  loadUser('a');");
  assert.equal(inspect(suppressed).findings.length, findings.length - 1);
  assert.equal(inspect(`// ts-structure-ignore-file\n${sourceFile.text}`).findings.length, 0);
});
