import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { runInspections } from '../inspect/inspection';
import { applyTextEdits } from '../intentions/intentions';
import { customInspections, inspectionId } from '../search/customInspections';
import { fixtures, virtualProject } from './helpers';

const file = path.join(fixtures, 'search/src/code.ts');

test('saved patterns report matches with filled-in messages and offer replacement fixes', () => {
  const { inspections, errors } = customInspections([
    { id: 'no-foreach', pattern: '$list$.forEach($callback$)', message: 'Use for…of over $list$', replacement: 'for (const x of $list$) ($callback$)(x)', severity: 'info' },
    { id: 'broken', pattern: 'if ($c$ {', message: 'never compiles' },
    { id: 'disabled', pattern: 'console.log($a$)', message: 'off', enabled: false },
  ]);
  assert.equal(inspections.length, 1);
  assert.match(errors[0], /broken.*not valid TypeScript/);

  const program = virtualProject('search', 'src/code.ts').program();
  const sourceFile = program.getSourceFile(file)!;
  const findings = runInspections(inspections, { sourceFile, program, checker: program.getTypeChecker() });
  assert.deepEqual(findings.map((f) => `${f.inspection} ${f.severity} ${f.message}`), [
    'custom:no-foreach info Use for…of over items',
    'custom:no-foreach info Use for…of over items',
  ]);
  const fixAll = findings[0].fixes!.find((f) => f.title.startsWith('Fix all'))!;
  const fixed = applyTextEdits(sourceFile.text, fixAll.edits);
  assert.match(fixed, /for \(const x of items\) \(\(item\) => console\.log\(item\)\)\(x\);/);
  assert.match(fixed, /for \(const x of items\) \(\(item, index\) => console\.log\(item, index\)\)\(x\);/);
});

test('inspection ids are derived from the message and kept unique', () => {
  assert.equal(inspectionId('Prefer for…of over $list$.forEach', []), 'prefer-for-of-over-foreach');
  assert.equal(inspectionId('No console', ['no-console']), 'no-console-2');
});
