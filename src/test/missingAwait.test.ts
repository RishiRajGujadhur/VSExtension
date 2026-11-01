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

  // Outside async functions, the rejection can still be handled.
  const sync = findings.find((f) => sourceFile.text.slice(f.start, f.end) === "fetchUser('j')")!;
  assert.deepEqual(sync.fixes?.map((f) => f.title), ['Make sync async and await the call', 'Mark as intentionally not awaited (void)', 'Handle the rejection with .catch()']);
  assert.match(applyTextEdits(sourceFile.text, sync.fixes![0].edits), /export async function sync\(\): Promise<void> \{\n {2}await fetchUser\('j'\);/);
  assert.match(applyTextEdits(sourceFile.text, sync.fixes![2].edits), /fetchUser\('j'\)\.catch\(\(error\) => console\.error\(error\)\);/);

  // Without a declared return type, the last statement's promise can be returned instead.
  const unannotated = inspect(sourceFile.text.replace('export function sync(): void {', 'export function sync() {'));
  const last = unannotated.findings.find((f) => unannotated.sourceFile.text.slice(f.start, f.end) === "fetchUser('j')")!;
  const returnFix = last.fixes?.find((f) => f.title === 'Return the promise to the caller');
  assert.ok(returnFix, last.fixes?.map((f) => f.title).join(', '));
  assert.match(applyTextEdits(unannotated.sourceFile.text, returnFix.edits), /\n {2}return fetchUser\('j'\);/);

  // Fire-and-forget calls can be ignored by name, including through wrappers (loadUser comes from fetchUser).
  const ignoring = (names: string[]) => {
    const project = virtualProject('inspect', 'src/async.ts');
    const program = project.program();
    return runInspections([missingAwait], { sourceFile: program.getSourceFile(file)!, program, checker: program.getTypeChecker(), options: { missingAwaitIgnore: names } });
  };
  assert.equal(ignoring(['fetch*']).filter((f) => f.message.startsWith('The promise returned')).length, 0);
  assert.equal(ignoring(['load*']).filter((f) => f.message.startsWith('The promise returned')).length, 1);

  const suppressed = sourceFile.text.replace("  loadUser('a');", "  // ts-structure-ignore-next-line missingAwait\n  loadUser('a');");
  assert.equal(inspect(suppressed).findings.length, findings.length - 1);
  assert.equal(inspect(`// ts-structure-ignore-file\n${sourceFile.text}`).findings.length, 0);
});
