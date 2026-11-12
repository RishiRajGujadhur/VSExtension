import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { polishReport } from '../structure/reportPolish';
import { Report, ReportNode, forEachReportNode } from '../structure/report';
import { explainValueReport } from '../inspect/paths';
import { nullabilityReport } from '../inspect/nullability';
import { raceReport, variableMutationReport } from '../inspect/races';
import { reactStateReport } from '../inspect/reactState';

const file = (fixture: string, name: string) => path.join(fixtures, fixture, name);
const find = (report: Report, test: (n: ReportNode) => boolean) => {
  let found: ReportNode | undefined;
  forEachReportNode(report.roots, (n) => { if (!found && test(n)) found = n; });
  return found;
};
const report = (kind: string, title: string, roots: ReportNode[], description = 'summary'): Report => ({ kind, title, description, roots, warnings: [], fileHashes: {} });

test('data flow: call sites counted, literals and import-time values marked, the type and reach', () => {
  const r = polishReport(report('dataFlow', 'Data flow of payment', [
    { label: 'Flows in', children: [
      { label: 'Incoming values from call sites', children: [
        { label: "new CardPayment('4242')", description: 'module scope · main.ts' },
        { label: 'payment', description: 'submitSafely · orders.ts' },
      ] },
      { label: 'Where it is written', children: [{ label: 'placeOrder', children: [{ label: 'parameter', description: 'line 18 · PaymentMethod · at cursor' }] }] },
    ] },
    { label: 'Flows out', children: [{ label: '→ receipt', description: 'line 20 · placeOrder', children: [{ label: 'used in run()', description: 'submitSafely · orders.ts' }] }] },
  ], '1 definition'));
  const incoming = find(r, (n) => n.label === 'Incoming values from call sites')!;
  assert.match(incoming.description!, /2 call sites in 2 files/);
  assert.match(incoming.children![0].description!, /literal value · set when the module loads/);
  assert.doesNotMatch(incoming.children![1].description!, /literal/);
  assert.match(r.description!, /type PaymentMethod/);
  assert.match(r.roots[1].description!, /reaches 2 functions/);
});

test('why this value: shared conditions lifted out, branches in words, the deepest condition count', () => {
  const ctl = file('inspect', 'src/control.ts');
  const r = polishReport(explainValueReport(virtualProject('inspect', 'src/control.ts'), ctl, offsetIn(ctl, 'return permis|sion')));
  assert.match(r.roots[0].label, /^Every value needs user\.active/);
  assert.ok(find(r, (n) => n.description === 'the no branch'));
  assert.match(r.description!, /up to 3 conditions each/);
});

test('null checks: every use safe said plainly, ways counted, tips folded when nothing is unsafe', () => {
  const nl = file('inspect', 'src/nullable.ts');
  const r = polishReport(nullabilityReport(virtualProject('inspect', 'src/nullable.ts'), nl, offsetIn(nl, 'const us|er = findUser')));
  assert.ok(r.roots.some((n) => n.label === 'Every use is safe'));
  assert.match(r.roots.find((n) => /^Paths that produce/.test(n.label))!.description!, /1 way/);
  assert.equal(r.roots.find((n) => n.label === 'How to fix')!.expanded, false);
});

test('changes to a variable: each write named, writers counted; a variable nothing changes could be const', () => {
  const rc = file('inspect', 'src/races.ts');
  const r = polishReport(variableMutationReport(virtualProject('inspect', 'src/races.ts'), rc, offsetIn(rc, 'let coun|ter')));
  assert.ok(find(r, (n) => /counter\+\+/.test(n.label) && /increment/.test(n.description ?? '')));
  assert.ok(find(r, (n) => /counter = before/.test(n.label) && /assignment/.test(n.description ?? '')));
  assert.match(r.description!, /2 of 2 writers async/);
  const still = polishReport(report('variableMutations', 'Mutations of x', [{ label: 'x' }, { label: 'module scope', children: [{ label: 'const x = 1;', description: 'line 1 · initial value' }] }]));
  assert.equal(still.roots[1].label, 'Never changes after it starts');
});

test('race conditions: ++ is one step, lost updates first, async writers counted; none found said plainly', () => {
  const rc = file('inspect', 'src/races.ts');
  const r = polishReport(raceReport(virtualProject('inspect', 'src/races.ts'), rc, offsetIn(rc, 'let coun|ter')));
  assert.ok(find(r, (n) => /counter\+\+/.test(n.label) && /one step/.test(n.description ?? '')));
  assert.match(r.roots.find((n) => n.label === 'Possible race conditions')!.children![0].label, /^Lost update/);
  assert.match(r.description!, /2 async writers/);
  const calm = polishReport(report('races', 'Race conditions on y', [{ label: 'y' }]));
  assert.equal(calm.roots[1].label, 'No race found');
});

test('react state: missing dependencies counted and first; unread state and refs read while rendering flagged', () => {
  const re = file('navigate', 'src/react.tsx');
  const r = polishReport(reactStateReport(virtualProject('navigate', 'src/react.tsx'), re, offsetIn(re, 'function Cart|Page')));
  assert.match(r.description!, /2 missing dependencies/);
  const shaped = polishReport(report('reactState', 'React state of A', [
    { label: 'State — 1 value', children: [{ label: 'open', description: 'useState', children: [{ label: 'set in toggle (line 3)' }] }] },
    { label: 'Refs — 1 value', children: [{ label: 'box', description: 'useRef', children: [{ label: 'read in rendered (line 9)' }] }] },
    { label: 'Props — 1 value', children: [{ label: 'title', description: 'prop' }] },
  ]));
  assert.match(shaped.roots[0].children![0].description!, /set but never read/);
  assert.equal(shaped.roots[1].children![0].tone, 'warning');
  assert.match(shaped.roots[2].children![0].description!, /not used/);
});
