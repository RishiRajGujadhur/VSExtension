import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { compilePattern, structuralReplace, structuralSearch, SearchSpec } from '../search/structuralSearch';
import { changedText, fixtures, virtualProject } from './helpers';

const file = path.join(fixtures, 'search/src/code.ts');

function find(spec: SearchSpec): string[] {
  const program = virtualProject('search', 'src/code.ts').program();
  return structuralSearch(program, spec).map((m) => m.sourceFile.text.slice(m.start, m.end));
}

test('placeholders match any expression and bind consistently', () => {
  assert.deepEqual(find({ pattern: '$list$.forEach($callback$)' }), [
    'items.forEach((item) => console.log(item))',
    'items.forEach((item, index) => console.log(item, index))',
  ]);
  assert.deepEqual(find({ pattern: '$x$ === $x$' }), ['count === count']);
});

test('list placeholders take any number of items', () => {
  assert.equal(find({ pattern: 'console.log($args*$)' }).length, 7);
  assert.deepEqual(find({ pattern: 'console.log($first$, $second$, $rest*$)' }), [
    'console.log(item, index)',
    "console.log('count', count)",
    'console.log(same, other)',
  ]);
});

test('type and text constraints filter matches', () => {
  assert.deepEqual(find({ pattern: 'console.log($a$)', constraints: [{ name: 'a', type: '^string$' }] }), [
    'console.log(item)',
    'console.log(label)',
    "console.log('positive')",
    "console.log('still positive')",
  ]);
  assert.deepEqual(find({ pattern: 'console.log($a$)', constraints: [{ name: 'a', text: '^\'', negate: true }] }), ['console.log(item)', 'console.log(label)']);
});

test('statement patterns match single statements and consecutive sequences', () => {
  assert.deepEqual(find({ pattern: 'if ($c$) { $body*$ }' }).map((m) => m.split('\n')[0]), ['if (count > 0) {']);
  assert.deepEqual(find({ pattern: 'console.log($a$);\nconsole.log($b$);' }), ["console.log('positive');\n    console.log('still positive');"]);
});

test('invalid and overly general patterns are explained', () => {
  assert.throws(() => compilePattern({ pattern: '$x$' }), /matches everything/);
  assert.throws(() => compilePattern({ pattern: 'if ($c$ {' }), /Invalid pattern/);
});

test('replace rewrites matches and reports type errors it would introduce', () => {
  const project = virtualProject('search', 'src/code.ts');
  const ok = structuralReplace(project, { pattern: '$x$ === $x$' }, 'true');
  assert.equal(ok.matches, 1);
  assert.deepEqual(ok.conflicts, []);
  assert.match(changedText(ok, file), /const same = true;/);
  // Each rewrite is listed for the preview.
  assert.equal(ok.replacements.length, 1);
  assert.equal(ok.replacements[0].after, 'true');
  assert.match(ok.replacements[0].before, /^(\w+) === \1$/);

  const broken = structuralReplace(virtualProject('search', 'src/code.ts'), { pattern: 'console.log($a$)', constraints: [{ name: 'a', type: '^string$' }] }, '$a$.toFixed()');
  assert.equal(broken.matches, 4);
  assert.ok(broken.conflicts.length > 0);
  assert.match(broken.conflicts[0].message, /toFixed/);

  // A range limits the search and the replacement to part of a file, such as the selection.
  const whole = structuralSearch(virtualProject('search', 'src/code.ts').program(), { pattern: 'console.log($a$)' });
  const ranged = structuralReplace(virtualProject('search', 'src/code.ts'), { pattern: 'console.log($a$)' }, 'console.info($a$)', { range: { start: whole[1].start, end: whole[1].end } });
  assert.equal(ranged.matches, 1);
  assert.equal(ranged.replacements[0].before, whole[1].sourceFile.text.slice(whole[1].start, whole[1].end));

  // A replacement that is not valid code is refused before anything is written.
  assert.throws(
    () => structuralReplace(virtualProject('search', 'src/code.ts'), { pattern: '$x$ === $x$' }, '($x$'),
    /Invalid replacement at code\.ts:\d+/,
  );
});

test('every built-in search template compiles and its replacement uses only its placeholders', async () => {
  const { searchTemplates } = await import('../search/templates');
  const { placeholdersIn } = await import('../search/structuralSearch');
  for (const template of searchTemplates) {
    assert.doesNotThrow(() => compilePattern(template), template.title);
    const defined = new Set(placeholdersIn(template.pattern).map((p) => p.name));
    for (const used of placeholdersIn(template.replacement ?? '')) {
      assert.ok(defined.has(used.name), `${template.title}: $${used.name}$`);
    }
  }
  assert.deepEqual(find({ pattern: searchTemplates[0].pattern }), []);
});
