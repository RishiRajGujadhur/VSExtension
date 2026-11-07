import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { patternNames } from '../inspect/patterns';
import { learnMore, patternLink } from '../inspect/patternLinks';

test('every pattern links to a page that explains it', () => {
  for (const name of patternNames()) {
    assert.match(patternLink(name) ?? '', /^https:\/\//, name);
  }
});

test('tooltips end with a Learn more link', () => {
  assert.equal(learnMore('Strategy'), '\n\n[Learn more about Strategy](https://refactoring.guru/design-patterns/strategy)');
  assert.equal(learnMore('Not a pattern'), '');
});
