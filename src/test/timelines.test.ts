import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { fixtures, offsetIn, virtualProject } from './helpers';
import { asyncTimelineReport, valueTimelineReport } from '../inspect/timelines';
import { AnalysisError } from '../analysis/types';

const file = path.join(fixtures, 'timelines', 'src/timelines.ts');
const project = () => virtualProject('timelines', 'src/timelines.ts');

test('value timeline: phases around a loop, conditions, what each pass hands on, no duplicate reads', () => {
  const r = valueTimelineReport(project(), file, offsetIn(file, 'let to|tal = 0'));
  assert.deepEqual(r.roots.map((p) => p.label), ['At the start', 'Every pass of for (const item of items)', 'After the loop']);
  assert.equal(r.roots[0].children![0].label, 'starts as 0');
  const pass = r.roots[1].children!;
  assert.match(pass[0].label, /^Each pass starts with what the pass before left; the first pass starts with 0/);
  assert.equal(pass[1].label, '+= item.price');
  assert.match(pass[1].description!, /when item\.inStock/);
  assert.deepEqual(r.roots[2].children!.map((e) => e.label), ['= total * 0.9', 'returned: total']);
  assert.match(r.description!, /2 changes in and around 1 loop/);
});

test('value timeline: a counter steps pass by pass, and a loop check says so', () => {
  const r = valueTimelineReport(project(), file, offsetIn(file, 'let |n = start'));
  const pass = r.roots.find((p) => /^Every pass of while \(n > 0\)/.test(p.label))!.children!;
  assert.match(pass[0].label, /^Pass by pass: start, then start − 1, start − 2/);
  assert.ok(pass.some((e) => e.label === 'checked in while (n > 0)'));
  assert.ok(pass.some((e) => e.label === 'n--'));
});

test('value timeline: only variables and parameters', () => {
  assert.throws(() => valueTimelineReport(project(), file, offsetIn(file, 'function cart|Total')), AnalysisError);
});

test('async timeline: waits, calls started together, waits in a loop, a promise not awaited, one started early', () => {
  const r = asyncTimelineReport(project(), file, offsetIn(file, 'function check|out'));
  const steps = r.roots[0].children!;
  assert.deepEqual(steps.map((s) => s.label.replace(/^\d+\. /, '').split(' ')[0]), ['waits', 'waits', 'waits', 'starts', 'starts', 'starts', 'waits']);
  assert.match(steps[1].label, /2 calls at once/);
  assert.match(steps[2].description!, /on every pass, one after another/);
  assert.equal(steps[2].tone, 'warning');
  assert.match(steps[3].label, /never waits for it/);
  assert.match(steps[4].label, /on purpose \(void\)/);
  assert.match(steps[5].description!, /runs in the background until line 45/);
  assert.match(r.description!, /4 waits, 1 started together, 1 wait in loops, 1 not awaited/);
  assert.ok(r.roots.some((g) => g.label === 'How to make it faster and safer'));
});

test('async timeline: a function that only hands a promise on', () => {
  const r = asyncTimelineReport(project(), file, offsetIn(file, 'function qu|ick'));
  assert.match(r.roots[0].children![0].label, /hands fetchPrice\('only'\) to the caller/);
});
