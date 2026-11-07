import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { glossary, termFor } from '../structure/glossary';

test('rows about a language construct find their explanation', () => {
  assert.equal(termFor('destructured: ReactNode')?.term, 'Destructuring');
  assert.equal(termFor('destructured, default null')?.term, 'Destructuring');
  assert.equal(termFor('→ prop badge')?.term, 'Passing a prop');
  assert.equal(termFor('→ saveOrder(id, total)')?.term, 'Passing an argument');
});

test('group rows have no explanation', () => {
  for (const label of ['Flows in', 'Flows out', 'Design patterns', 'Next', 'Paths that produce null or undefined']) {
    assert.equal(termFor(label), undefined, label);
  }
});

test('every term links to documentation and has a plain meaning', () => {
  const names = new Set<string>();
  for (const t of glossary) {
    assert.match(t.url, /^https:\/\//, t.term);
    assert.ok(t.meaning.length > 20, t.term);
    assert.ok(!names.has(t.term), `${t.term} twice`);
    names.add(t.term);
  }
});

test('import rows that start with an arrow are not arguments', () => {
  assert.equal(termFor('→ src/cart.ts'), undefined);
});

test('Nullability rows explain their terms', () => {
  assert.equal(termFor('index lookup items[0] may be missing', '')?.term, 'Index lookup');
  assert.equal(termFor('badge is an optional property', '')?.term, 'Optional property or parameter');
  assert.equal(termFor('badge || actions', 'line 24')?.term, 'Logical OR (||)');
  assert.equal(termFor('{badge}', 'line 26')?.term, 'JSX expression');
  assert.equal(termFor('user?.name', '')?.term, 'Optional chaining (?.)');
  assert.equal(termFor('el!.focus()', '')?.term, 'Non-null assertion (!)');
});
