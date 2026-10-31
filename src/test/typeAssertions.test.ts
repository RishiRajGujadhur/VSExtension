import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { runInspections } from '../inspect/inspection';
import { typeAssertions } from '../inspect/typeAssertions';
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
  const optional = applyTextEdits(sourceFile.text, findings[7].fixes![0].edits);
  assert.match(optional, /const h = maybe\?\.length;/);
});
