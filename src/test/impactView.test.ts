import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImpactedTest, ImpactResult } from '../analysis/types';
import { distance, fileCounts, groupByFile, statusOf, viewMessage } from '../structure/impactView';

const t = (file: string, line: number, title: string, confidence: 'confirmed' | 'possible', steps = 3): ImpactedTest =>
  ({ test: { file, title, titlePath: [title], location: { file, line } }, confidence, path: Array.from({ length: steps }, () => ({})), reason: '' }) as unknown as ImpactedTest;
const result = (tests: ImpactedTest[], warnings: string[] = []): ImpactResult => ({ target: { name: 'total' }, tests, warnings, testFilesScanned: 4 }) as unknown as ImpactResult;

test('affected tests: surest and busiest files first, confirmed first then by line, repeats once', () => {
  const groups = groupByFile([
    t('b.test.ts', 9, 'b2', 'possible'),
    t('a.test.ts', 5, 'a1', 'possible'),
    t('b.test.ts', 3, 'b1', 'confirmed'),
    t('b.test.ts', 3, 'b1', 'possible'),
    t('b.test.ts', 7, 'b3', 'possible'),
  ]);
  assert.deepEqual(groups.map((g) => g.file), ['b.test.ts', 'a.test.ts']);
  assert.deepEqual(groups[0].tests.map((x) => x.test.title), ['b1', 'b3', 'b2']);
  assert.equal(fileCounts(groups[0].tests), '3 tests · 2 possible');
});

test('affected tests: distance, the status bar, and an empty result in words', () => {
  assert.equal(distance(t('a', 1, 'x', 'confirmed', 2)), 'calls it directly');
  assert.equal(distance(t('a', 1, 'x', 'confirmed', 5)), '3 steps away');
  const status = statusOf(result([t('a', 1, 'x', 'confirmed'), t('b', 1, 'y', 'possible')]));
  assert.equal(status.text, '$(beaker) 2 tests (1 possible)');
  assert.match(status.tooltip, /2 tests in 2 files reach total; 1 only possibly/);
  assert.match(viewMessage(result([]))!, /No test reaches total: it may be untested/);
  assert.equal(viewMessage(result([t('a', 1, 'x', 'confirmed')])), undefined);
  assert.equal(viewMessage(result([], ['Stale'])), 'Stale');
});
