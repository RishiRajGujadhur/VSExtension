import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { argumentFlowReport } from '../navigate/argumentFlow';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'navigate/src/flow.tsx');

function outline(nodes: readonly ReportNode[]): string[] {
  const lines: string[] = [];
  forEachReportNode(nodes, (n, depth) => lines.push(`${'  '.repeat(depth)}${n.label}${n.description ? ` — ${n.description}` : ''}`));
  return lines;
}

test('origins are traced back through callers, derived locals and their parameters', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'log(mes|sage: string)'));
  assert.deepEqual(outline([report.roots[1]]), [
    'Where values come from — 1 call site',
    '  value — from format',
    '    label — from page',
    '      name.trim() — initializes label',
    "        'home' — from main",
    '        user.name — from main',
    "          { name: 'ann' } — initializes user",
  ]);
});

test('values are followed forward through derived locals, calls and returns', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'page(na|me: string)'));
  assert.deepEqual(outline([report.roots.find((r) => r.label === 'Where the value goes')!]), [
    'Where the value goes — 1 destination',
    '  name.trim() → local label',
    '    label → format() — as value',
    '      value → log() — as message',
    '        message → console.log() — outside the project',
    '        returned: message — to callers of log',
  ]);
});

test('JSX props are followed between components in both directions', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'Title({ te|xt }'));
  assert.deepEqual(outline([report.roots[1]]), [
    'Where values come from — 1 call site',
    '  title — from Header',
    '    "Welcome" — from render',
  ]);
  const forward = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'Header({ ti|tle }'));
  assert.deepEqual(outline([forward.roots.find((r) => r.label === 'Where the value goes')!]), ['Where the value goes — 1 destination', '  title → <Title text> — prop of Title']);
});

test('assignments to a same-named variable in a nested function are not origins', () => {
  const project = virtualProject('navigate', 'src/flow.tsx');
  const text = `${fs.readFileSync(file, 'utf8')}
export function sink(value: string): string {
  return value;
}

export function shadow(input: string): string {
  let text = input;
  const helper = () => {
    let text = 'other';
    text = 'inner';
    return text;
  };
  return sink(text) + helper();
}
`;
  project.setText(file, text);
  const report = argumentFlowReport(project, file, text.lastIndexOf('value: string') + 1);
  const lines = outline([report.roots[1]]);
  assert.ok(lines.some((l) => l.includes('input — initializes text')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes("'inner'")), lines.join('\n'));
});

test('rows show their code on hover', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'page(na|me: string)'));
  const local = report.roots.find((r) => r.label === 'Where the value goes')?.children?.[0];
  assert.equal(local?.tooltip, '```tsx\nconst label = name.trim();\n```');
});

test('the distinct values that can arrive are summarized', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'log(mes|sage: string)'));
  const values = report.roots.find((r) => r.label === 'Values that can arrive');
  assert.deepEqual(values?.children?.map((c) => c.label), ["'home'", "{ name: 'ann' }"]);
});

test('a value passed to another function can be followed there', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'page(na|me: string)'));
  const intoFormat = report.roots.find((r) => r.label === 'Where the value goes')?.children?.[0].children?.[0];
  assert.equal(intoFormat?.label, 'label → format()');
  assert.deepEqual(intoFormat?.action, { kind: 'follow', command: 'tsStructure.argumentFlow', file: intoFormat?.action?.file, offset: offsetIn(file, 'format(|value: string') });
});

test('paths cut by the depth limit are pointed out', () => {
  const shallow = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'log(mes|sage: string)'), 1);
  assert.match(shallow.warnings[0] ?? '', /deeper than 1 call and were cut off; raise tsStructure\.argumentFlow\.maxDepth/);
  const deep = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'log(mes|sage: string)'));
  assert.deepEqual(deep.warnings, []);
});

test('the first row says what the parameter accepts', () => {
  const report = argumentFlowReport(virtualProject('navigate', 'src/flow.tsx'), file, offsetIn(file, 'log(mes|sage: string)'));
  assert.equal(report.roots[0].description, 'string');
});
