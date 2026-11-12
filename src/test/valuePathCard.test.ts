import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { explainValueReport } from '../inspect/paths';
import { polishReport } from '../structure/reportPolish';
import { valuePathCard } from '../structure/valuePathCard';

test('value path card: the subject, the timing, each value with its ways and when it happens', () => {
  const ctl = path.join(fixtures, 'inspect', 'src/control.ts');
  const report = polishReport(explainValueReport(virtualProject('inspect', 'src/control.ts'), ctl, offsetIn(ctl, 'return permis|sion')));
  report.durationMs = 116;
  const card = valuePathCard(report)!;
  assert.equal(card.subject, 'permission');
  assert.equal(card.timing, '116 ms');
  assert.match(card.summary, /4 possible values at line 25.*\(116 ms\)/);
  assert.deepEqual(card.values.map((v) => v.title), ["'write'", "'limited'", "'read'", "'none'"]);
  assert.equal(card.values[0].ways, '1 way');
  assert.match(card.values[0].when, /^When user\.active, user\.role is 'admin'/);
  assert.match(card.needs!, /Every value needs user\.active/);
});

test('value path card: a value from outside the function, always; other reports get no card', () => {
  const card = valuePathCard({ kind: 'explainValue', title: 'Value path of useConfirm', description: '1 possible value at line 59', warnings: [], fileHashes: {},
    roots: [{ label: 'its value from outside the function', icon: 'symbol-variable', description: '1 way', children: [{ label: 'always', description: 'no branch decides it' }] }] })!;
  assert.equal(card.values[0].title, 'Its value from outside the function');
  assert.equal(card.values[0].when, 'Always — no branch decides it');
  assert.equal(card.values[0].always, true);
  assert.equal(valuePathCard({ kind: 'usages', title: 'x', roots: [], warnings: [], fileHashes: {} }), undefined);
});
