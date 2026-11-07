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

test('Side Effects rows explain their terms', () => {
  assert.equal(termFor('Input/output', '')?.term, 'Input/output');
  assert.equal(termFor('Schedules work', '')?.term, 'Scheduled work');
  assert.equal(termFor('Writes globals', '')?.term, 'Global state');
});

test('Mutation Tracking rows explain their terms', () => {
  assert.equal(termFor('Mutates arguments', '')?.term, 'Mutating an argument');
  assert.equal(termFor('Mutates captured variables', '')?.term, 'Captured variable');
  assert.equal(termFor('total', 'module-level: every caller shares one value')?.term, 'Module state');
});

test('Race Conditions rows explain their terms', () => {
  assert.equal(termFor('Lost update', 'addToTotal')?.term, 'Lost update');
  assert.equal(termFor('waits here: await load()', 'line 26')?.term, 'await');
  assert.equal(termFor('counter = before + 1', 'line 35 · write · after an await')?.term, 'await');
});

test('Promise Rejections rows explain their terms', () => {
  assert.equal(termFor('Unhandled', '')?.term, 'Unhandled rejection');
  assert.equal(termFor('.catch(console.error)', '')?.term, '.catch()');
  assert.equal(termFor('caught in submitSafely', '')?.term, 'catch block');
});

test('Exception Flow rows explain their terms', () => {
  assert.equal(termFor('finally block runs on every exit', '')?.term, 'finally');
  assert.equal(termFor('Thrown here', '')?.term, 'throw');
  assert.equal(termFor('propagates through placeOrder', '')?.term, 'Propagation');
});

test('Argument Propagation rows explain their terms', () => {
  assert.equal(termFor('Values that can arrive', '')?.term, 'Values that can arrive');
  assert.equal(termFor('stored in this.handler', '')?.term, 'Storing a value');
});

test('Find Usages rows explain their terms', () => {
  assert.equal(termFor('Calls', '')?.term, 'Call');
  assert.equal(termFor('Type references', '')?.term, 'Type reference');
  assert.equal(termFor('JSX usages', '')?.term, 'JSX usage');
});

test('Inheritance Hierarchy rows explain their terms', () => {
  assert.equal(termFor('Supertypes', '')?.term, 'Supertype');
  assert.equal(termFor('Overrides in subtypes', '')?.term, 'Override');
  assert.equal(termFor('super calls from overrides', '')?.term, 'super call');
});

test('Re-export Chain rows explain their terms', () => {
  assert.equal(termFor('Imported through', '')?.term, 'Imported through');
});
