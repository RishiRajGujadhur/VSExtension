import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { raceFindings, raceReport, variableMutationReport, variableUse } from '../inspect/races';
import { fixtures, offsetIn, virtualProject } from './helpers';

const races = path.join(fixtures, 'inspect/src/races.ts');
const use = (marker: string) => variableUse(virtualProject('inspect', 'src/races.ts'), races, offsetIn(races, marker));
const kinds = (marker: string) => raceFindings(use(marker)).map((f) => `${f.kind}${f.fn ? ` ${f.fn.name?.getText()}` : ''}`);

test('x += await f() is a lost update; awaiting first and then adding is not', () => {
  assert.deepEqual(kinds('let to|tal'), ['lost-update addToTotal']);
});

test('checking, awaiting and then setting is check-then-act', () => {
  assert.deepEqual(kinds('let ca|che'), ['check-then-act getCache']);
});

test('a read, an await and a write, plus a timer callback, are both reported', () => {
  assert.deepEqual(kinds('let coun|ter'), ['lost-update bump', 'many-writers']);
});

test('a write after an await with nothing read before it is not a lost update', () => {
  assert.deepEqual(kinds('const que|ue'), []);
});

test('a local variable is not shared between calls', () => {
  const local = use('let mi|ne');
  assert.equal(local.sharing, 'local');
  assert.deepEqual(raceFindings(local), []);
  assert.equal(use('let to|tal').sharing, 'module');
});

test('writes take effect when the assignment finishes, after its await', () => {
  const total = use('let to|tal');
  const inAdd = total.accesses.filter((a) => a.fn?.name?.getText() === 'addToTotal');
  assert.deepEqual(inAdd.map((a) => `${a.kind}${a.afterAwait ? ' after await' : ''}`), ['read', 'write after await']);
});

test('the reports group uses by function and name the risk', () => {
  const project = virtualProject('inspect', 'src/races.ts');
  const report = raceReport(project, races, offsetIn(races, 'let coun|ter'));
  assert.equal(report.description, '2 possible races');
  assert.deepEqual(report.roots[1].children?.map((c) => c.label), ['Lost update', 'Several async writers']);
  const mutations = variableMutationReport(virtualProject('inspect', 'src/races.ts'), races, offsetIn(races, 'let coun|ter'));
  assert.deepEqual(mutations.roots.slice(1, -1).map((r) => `${r.label}: ${r.description}`), [
    'module scope: initial value',
    'bump: 1 change · async · changes after an await',
    'arrow function: 1 change · runs from setTimeout()',
  ]);
});
