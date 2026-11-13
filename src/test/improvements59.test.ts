import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { valueTimelineReport, asyncTimelineReport } from '../inspect/timelines';
import { resultCard } from '../structure/resultCard';

const shaped = (kind: string, title: string, roots: ReportNode[]): Report => ({ kind, title, description: 'x', roots, warnings: [], fileHashes: {} });
const find = (r: Report, t: (n: ReportNode) => boolean) => { let f: ReportNode | undefined; forEachReportNode(r.roots, (n) => { if (!f && t(n)) f = n; }); return f; };

test('find usages: a file that imports it and never uses it', () => {
  const r = polishReport(shaped('usages', 'Usages of total', [
    { label: 'Calls', children: [{ label: 'cart.ts', children: [{ label: 'total()', description: 'checkout · line 3' }] }] },
    { label: 'Imports', children: [{ label: 'cart.ts', children: [] }, { label: 'unused.ts', children: [] }] },
  ]));
  assert.match(find(r, (n) => n.label === 'unused.ts')!.description!, /imports it but never uses it/);
  assert.doesNotMatch(find(r, (n) => n.label === 'cart.ts' && !n.children?.length)?.description ?? '', /never uses/);
});

test('callers and calls: a call to itself is recursion', () => {
  const r = polishReport(shaped('callGraph', 'Call graph of walk', [{ label: 'Called by', children: [{ label: 'main' }] }, { label: 'Calls', children: [{ label: 'walk', description: 'tree.ts:3' }] }]));
  assert.match(find(r, (n) => n.label === 'walk')!.description!, /calls itself/);
});

test('value timeline: a last change nothing reads is pointed out', () => {
  const file = path.join(fixtures, 'timelines', 'src/timelines.ts');
  const r = valueTimelineReport(virtualProject('timelines', 'src/timelines.ts'), file, offsetIn(file, 'let to|tal = 0'));
  // total is returned after its last change, so nothing is flagged.
  assert.ok(!find(r, (n) => /nothing reads it after this/.test(n.description ?? '')));
});

test('async timeline: counts steps inside callbacks in its summary', () => {
  const file = path.join(fixtures, 'timelines', 'src/timelines.ts');
  const r = asyncTimelineReport(virtualProject('timelines', 'src/timelines.ts'), file, offsetIn(file, 'function check|out'));
  assert.doesNotMatch(r.description!, /inside callbacks/);
});

test('result cards say when they ran', () => {
  const card = resultCard({ ...shaped('usages', 'Usages of x', []), ranAt: new Date(2026, 10, 13, 14, 3).getTime() });
  assert.equal(card.ranAt, '14:03');
});
