import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { dataFlowReport, dataFlowSteps, groupPatterns } from '../inspect/dataFlow';
import { fixtures, offsetIn, virtualProject } from './helpers';

const flow = path.join(fixtures, 'inspect/src/flow.ts');

test('data flow lists definitions, updates, checks, mutations and hand-offs in order', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const { steps } = dataFlowSteps(project, flow, offsetIn(flow, 'let to|tal'));
  assert.deepEqual(
    steps.map((s) => `${s.kind} ${s.label}`),
    [
      'declaration = 0',
      'update += item',
      'condition checked: if (total > 100)',
      'write = total * 0.9',
      'read read: total * 0.9',
      'argument → items.push(…)',
      'argument → applyTax(…) as amount',
    ],
  );
  assert.equal(steps[0].type, 'number');
});

test('data flow of a parameter shows the values call sites pass in', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'applyTax(am|ount'));
  const incoming = report.roots.find((r) => r.label === 'Flows in')?.children?.find((r) => r.label === 'Incoming values from call sites');
  assert.ok(incoming);
  assert.deepEqual(incoming.children?.map((c) => c.label), ['total', '5']);
  assert.ok(report.fileHashes[incoming.children![0].location!.file]);
});

test('data flow steps show their line and type', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const checkout = report.roots.find((r) => r.label.startsWith('checkout'));
  assert.equal(checkout?.description, 'flow.ts · 3 writes, 1 check, 2 hand-offs, 1 read');
  assert.equal(checkout?.children?.[0].description, 'line 6 · number · at cursor');
  // Later steps have the declared type, so it is not repeated.
  assert.equal(checkout?.children?.[1].description, 'line 8');
});

test('hand-offs can be followed into the called function', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const handOff = report.roots.flatMap((r) => r.children ?? []).find((c) => c.label === '→ applyTax(…) as amount');
  const action = handOff?.action as { kind: string; command: string; file: string; offset: number };
  assert.equal(action.kind, 'traceValue');
  assert.equal(action.command, 'tsStructure.dataFlow');
  assert.equal(action.offset, offsetIn(flow, 'applyTax(|amount'));
});

test('data flow marks the step at the cursor', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'total = to|tal * 0.9'));
  const focused = report.roots.flatMap((r) => r.children ?? []).filter((c) => c.focus);
  assert.deepEqual(
    focused.map((c) => `${c.label} (${c.description})`),
    ['read: total * 0.9 (line 11 · at cursor)'],
  );
});

test('data flow shows types where narrowing changes them', () => {
  const nullable = path.join(fixtures, 'inspect/src/nullable.ts');
  const project = virtualProject('inspect', 'src/nullable.ts');
  const report = dataFlowReport(project, nullable, offsetIn(nullable, 'const us|er = findUser'));
  const timeline = report.roots.filter((r) => !r.label.startsWith('Flows '));
  const descriptions = timeline.flatMap((r) => r.children ?? []).map((c) => c.description);
  assert.equal(descriptions[0], 'line 28 · User | undefined · at cursor');
  assert.ok(descriptions.some((d) => d?.endsWith(' · User')), descriptions.join(', '));
});

test('data flow rejects symbols that are not values', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  assert.throws(() => dataFlowSteps(project, flow, offsetIn(flow, 'export function check|out')), /isn't a variable/);
});

test('flows in lists each value assigned and what it is computed from', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const inflows = report.roots.find((r) => r.label === 'Flows in');
  assert.deepEqual(inflows?.children?.map((c) => c.label), ['= 0', '+= item', '= total * 0.9']);
  const scaled = inflows?.children?.[2];
  assert.deepEqual(scaled?.children?.map((c) => c.label), ['from total (its previous value)']);
});

test('flows out lists the variables, calls and callers the value reaches', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const total = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'));
  const out = total.roots.find((r) => r.label === 'Flows out');
  assert.deepEqual(out?.children?.map((c) => c.label), ['→ items.push(…)', '→ applyTax(…) as amount']);

  const sum = dataFlowReport(project, flow, offsetIn(flow, 'const s|um'));
  const sumIn = sum.roots.find((r) => r.label === 'Flows in')?.children?.[0];
  assert.equal(sumIn?.label, "= checkout([3], 'X')");
  assert.deepEqual(sumIn?.children?.map((c) => c.label), ['returned by checkout(…)']);
  const sumOut = sum.roots.find((r) => r.label === 'Flows out');
  assert.deepEqual(sumOut?.children?.map((c) => c.label), ['→ label', '→ copy']);
  const action = sumOut?.children?.[1].action as { kind: string; command: string; offset: number };
  assert.equal(action.command, 'tsStructure.dataFlow');
  assert.equal(action.offset, offsetIn(flow, 'const |copy'));

  const amount = dataFlowReport(project, flow, offsetIn(flow, 'applyTax(am|ount'));
  const returned = amount.roots.find((r) => r.label === 'Flows out')?.children?.[0];
  assert.equal(returned?.label, 'returned from applyTax');
  assert.deepEqual(returned?.children?.map((c) => c.label), ['returned again from checkout', 'returned again from run']);
});

test('data flow groups a design pattern found in several places', () => {
  const at = (file: string, line: number) => ({ file, line, character: 0, endLine: line, endCharacter: 1 });
  const rows = groupPatterns([
    { name: 'Controlled component', row: { label: 'Controlled component', description: 'the <input> shows value', location: at('/a/App.tsx', 4) } },
    { name: 'Portal', row: { label: 'Portal', description: 'renders into slot', location: at('/a/App.tsx', 9) } },
    { name: 'Controlled component', row: { label: 'Controlled component', description: 'the <select> shows value', location: at('/a/Form.tsx', 2) } },
  ]);
  assert.deepEqual(rows.map((r) => `${r.label} · ${r.description}`), ['Controlled component · 2 places in 2 files', 'Portal · renders into slot']);
  assert.deepEqual(rows[0].children?.map((c) => `${c.label} · ${c.description}`), ['the <input> shows value · App.tsx:5', 'the <select> shows value · Form.tsx:3']);
  assert.equal(rows[0].location, undefined);
});

test('data flow by direction puts writing code under Flows in and reading code under Flows out', () => {
  const project = virtualProject('inspect', 'src/flow.ts');
  const report = dataFlowReport(project, flow, offsetIn(flow, 'let to|tal'), { byDirection: true });
  assert.deepEqual(report.roots.slice(0, 2).map((r) => r.label), ['Flows in', 'Flows out']);
  assert.ok(!report.roots.some((r) => r.label.startsWith('checkout')));
  const written = report.roots[0].children?.find((c) => c.label === 'Where it is written');
  const read = report.roots[1].children?.find((c) => c.label === 'Where it is read');
  assert.equal(written?.description, '1 function');
  assert.equal(written?.children?.[0].description, 'flow.ts · 3 writes');
  assert.equal(read?.children?.[0].description, 'flow.ts · 1 check, 2 hand-offs, 1 read');
  assert.match(report.roots[0].description ?? '', /written in 1 function$/);
  // The step at the cursor is still marked.
  assert.ok(written?.children?.[0].children?.some((c) => c.focus));
});
