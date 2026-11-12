import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { resultCard } from '../structure/resultCard';
import { explainValueReport } from '../inspect/paths';
import { polishReport } from '../structure/reportPolish';

test('every result has a card: groups with their rows for most, the values for a Value path', () => {
  const card = resultCard({ kind: 'usages', title: 'Usages of total', description: '3 usages', warnings: [], fileHashes: {}, durationMs: 42,
    roots: [{ label: 'Calls', description: '2', children: [{ label: 'cart.ts', children: [{ label: 'total()', description: 'line 3' }] }, { label: 'main.ts', children: [] }] }] });
  assert.equal(card.heading, 'Usages');
  assert.equal(card.subject, 'total');
  assert.equal(card.timing, '42 ms');
  assert.equal(card.rows![0].children.length, 2);
  assert.equal(card.rows![0].children[0].children[0].label, 'total()');
  assert.equal(card.value, undefined);

  const ctl = path.join(fixtures, 'inspect', 'src/control.ts');
  const value = resultCard(polishReport(explainValueReport(virtualProject('inspect', 'src/control.ts'), ctl, offsetIn(ctl, 'return permis|sion'))));
  assert.equal(value.heading, 'Value path');
  assert.equal(value.value!.values.length, 4, 'all four values, not just one');
});

test('a very long list is trimmed for the card, and says how many are left out', () => {
  const card = resultCard({ kind: 'usages', title: 'Usages of x', warnings: [], fileHashes: {}, roots: [{ label: 'Reads', children: Array.from({ length: 400 }, (_, i) => ({ label: `r${i}` })) }] });
  assert.equal(card.rows![0].children.length, 150);
  assert.equal(card.rows![0].more, 250);
});
