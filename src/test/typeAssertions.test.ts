import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { runInspections } from '../inspect/inspection';
import { typeAssertions } from '../inspect/typeAssertions';
import { assertionAuditReport } from '../inspect/assertionAudit';
import { applyTextEdits } from '../intentions/intentions';
import { fixtures, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/assertions.ts');

test('assertions are classified as unsafe, unnecessary, widening or unchecked narrowing', () => {
  const program = virtualProject('inspect', 'src/assertions.ts').program();
  const sourceFile = program.getSourceFile(file)!;
  const findings = runInspections([typeAssertions], { sourceFile, program, checker: program.getTypeChecker() });
  const found = findings.map((f) => `${f.severity} ${sourceFile.text.slice(f.start, f.end)} | ${f.message.split(/: |\. /)[0]}`);
  assert.deepEqual(found, [
    'warning as Circle | Unchecked narrowing from Shape to Circle',
    'warning as string | Unchecked narrowing from string | number to string',
    'hint as string | Unnecessary assertion',
    'warning as Circle | Double assertion from unknown to Circle through unknown',
    "warning as any | 'as any' turns off type checking for shape and for everything it flows into.",
    "info as Circle | JSON.parse(json) is 'any', so nothing verifies at runtime that it is Circle",
    'info as Shape | Widening assertion',
    'hint ! | Non-null assertion on maybe, which is string | undefined',
    'hint ! | Unnecessary non-null assertion',
  ]);
  assert.match(findings[0].message, /assumes properties radius exist/);
  assert.match(findings[1].message, /assumes the value is never number/);

  const removed = applyTextEdits(sourceFile.text, findings[2].fixes![0].edits);
  assert.match(removed, /const c = json;/);
  const satisfies = applyTextEdits(sourceFile.text, findings[6].fixes![0].edits);
  assert.match(satisfies, /\{ kind: 'circle', radius: 1 \} satisfies Shape;/);
  // Explanations start from the asserted value, not the `as` keyword.
  assert.deepEqual(findings[0].explain, { title: 'Show where shape comes from…', command: 'tsStructure.dataFlow', offset: sourceFile.text.indexOf('shape as Circle') });
  assert.equal(findings[5].explain, undefined);
  assert.equal(findings[7].explain?.command, 'tsStructure.nullability');
  assert.equal(findings[7].explain?.offset, sourceFile.text.indexOf('maybe!'));
  const unknown = applyTextEdits(sourceFile.text, findings[4].fixes![0].edits);
  assert.match(unknown, /const e = shape as unknown;/);
  // Test files can be skipped; this file is not one, so the option changes nothing here.
  assert.equal(runInspections([typeAssertions], { sourceFile, program, checker: program.getTypeChecker(), options: { typeAssertionIgnoreTests: true } }).length, findings.length);
  const project = virtualProject('inspect', 'src/assertions.ts');
  const testFile = file.replace('assertions.ts', 'assertions.test.ts');
  project.setText(testFile, `import { test } from 'node:test';\n${sourceFile.text}`);
  const testProgram = project.program();
  const testSource = testProgram.getSourceFile(testFile)!;
  const inTest = (ignore: boolean) => runInspections([typeAssertions], { sourceFile: testSource, program: testProgram, checker: testProgram.getTypeChecker(), options: { typeAssertionIgnoreTests: ignore } }).length;
  assert.equal(inTest(false), findings.length);
  assert.equal(inTest(true), 0);
  const optional = applyTextEdits(sourceFile.text, findings[7].fixes![0].edits);
  assert.match(optional, /const h = maybe\?\.length;/);
});

test('the audit groups assertions from riskiest to harmless', () => {
  const program = virtualProject('inspect', 'src/assertions.ts').program();
  const report = assertionAuditReport(program, [program.getSourceFile(file)!]);
  assert.deepEqual(
    report.roots.map((r) => `${r.label} ${r.children?.length}`),
    ['Unsafe 2', 'Unchecked narrowing 2', 'Unverified 1', 'Non-null on a nullable value 1', 'Widening 1', 'Unnecessary 2', 'How to fix 4'],
  );
  assert.equal(report.description, '9 assertions, 5 unchecked or unsafe, in 1 file');
  assert.equal(report.roots[0].children?.[0].label, 'const d = raw as unknown as Circle;');
});

test('angle-bracket widening is rewritten to a parenthesized satisfies', () => {
  const project = virtualProject('inspect', 'src/assertions.ts');
  const original = project.program().getSourceFile(file)!.text;
  const text = `${original}export const s = (<Shape>{ kind: 'square' }).kind;\nexport const t = <Shape>{ kind: 'round' };\n`;
  project.setText(file, text);
  const program = project.program();
  const added = runInspections([typeAssertions], { sourceFile: program.getSourceFile(file)!, program, checker: program.getTypeChecker() }).filter((f) => f.start >= original.length);
  assert.deepEqual(added.map((f) => f.category), ['Widening', 'Widening']);
  const fixed = applyTextEdits(applyTextEdits(text, added[1].fixes![0].edits), added[0].fixes![0].edits);
  assert.equal(fixed.slice(original.length), "export const s = ({ kind: 'square' } satisfies Shape).kind;\nexport const t = ({ kind: 'round' } satisfies Shape);\n");
});
