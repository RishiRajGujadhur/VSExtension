import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { EffectAnalyzer, mutationReport, sideEffectReport } from '../inspect/effects';
import { functionAtOffset } from '../structure/util';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/effects.ts');

function effectsAt(marker: string) {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const checker = program.getTypeChecker();
  const fn = functionAtOffset(program.getSourceFile(file)!, offsetIn(file, marker), checker);
  return new EffectAnalyzer(checker).effectsOf(fn).map((e) => `${e.kind} ${e.target}${e.via ? ' via' : ''}`);
}

test('direct mutations are classified by where the state lives', () => {
  assert.deepEqual(effectsAt('function add|Item'), ['mutates-parameter items']);
  assert.deepEqual(effectsAt('function remem|ber'), ['mutates-module cache', 'mutates-module counter']);
  assert.deepEqual(effectsAt('function regis|ter'), ['mutates-import registry.names']);
  assert.deepEqual(effectsAt('function pu|re'), []);
});

test('callee effects map onto the caller, including argument mutations', () => {
  assert.deepEqual(effectsAt('function col|lect'), []);
  assert.deepEqual(effectsAt('function tra|ck').sort(), [
    'io console.log',
    'mutates-module cache via',
    'mutates-module counter via',
    'mutates-parameter list via',
    'nondeterministic Date.now',
  ]);
});

test('instance mutations count for methods but not constructors', () => {
  assert.deepEqual(effectsAt('incr|ement(): void'), ['mutates-this this.count']);
  // One per call site.
  assert.deepEqual(effectsAt('incrementTw|ice'), ['mutates-this this.count via', 'mutates-this this.count via']);
  assert.deepEqual(effectsAt('constr|uctor'), []);
});

test('side-effect report says when a function is pure', () => {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const report = sideEffectReport(program, file, offsetIn(file, 'function pu|re'));
  assert.equal(report.description, 'pure');
  const track = sideEffectReport(program, file, offsetIn(file, 'function tra|ck'));
  assert.deepEqual(track.roots.map((r) => r.label), ['Mutates arguments', 'Mutates module state', 'Input/output', 'Nondeterministic']);
});

test('mutation report groups writes by shared state', () => {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const report = mutationReport(program, file);
  const state = report.roots.find((r) => r.label === 'Shared state and who changes it');
  assert.deepEqual(state?.children?.map((c) => `${c.label} ${c.children?.length}`).sort(), ['cache 2', 'counter 2', 'registry 1', 'this 3'].sort());
  // Most-written first, and imported state names the file it lives in.
  assert.equal(state?.children?.[0].label, 'this');
  assert.equal(state?.children?.find((c) => c.label === 'registry')?.description, 'imported state · 1 write · state.ts');
});

test('mutation report says what kinds of state each function changes', () => {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const functions = mutationReport(program, file).roots[0].children!;
  const description = (name: string) => functions.find((f) => f.label.startsWith(name))?.description;
  assert.equal(description('track'), '3 mutations: arguments, module state');
  assert.equal(description('register'), '1 mutation: imported state');
  // Each function row opens its full side-effect analysis.
  const action = functions.find((f) => f.label.startsWith('track'))?.action;
  assert.deepEqual(action, { kind: 'showSideEffects', command: 'tsStructure.sideEffects', file: action?.file, offset: offsetIn(file, 'function |track') });
});

test('mutation report can cover the whole project', () => {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const files = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && sf.fileName.includes('test-fixtures'));
  const report = mutationReport(program, file, undefined, files);
  assert.equal(report.title, 'Mutations in the project');
  const functions = report.roots[0].children!;
  // Functions from other files are included and name their file.
  assert.ok(functions.some((f) => /^[a-z]+\.ts · /.test(f.description ?? '') && !f.description!.startsWith('effects.ts')), functions.map((f) => f.description).join(', '));
  assert.ok(functions.length > mutationReport(program, file).roots[0].children!.length);
});

test('mutation report selects the state at the cursor', () => {
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const focusedAt = (marker: string) =>
    mutationReport(program, file, offsetIn(file, marker))
      .roots.flatMap((r) => r.children ?? [])
      .filter((c) => c.focus)
      .map((c) => c.label);
  assert.deepEqual(focusedAt('const cac|he'), ['cache']);
  assert.deepEqual(focusedAt('registry.na|mes.push'), ['registry']);
  assert.deepEqual(focusedAt('function pu|re'), []);
});
