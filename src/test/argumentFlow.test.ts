import * as assert from 'node:assert/strict';
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
  assert.deepEqual(outline([report.roots[2]]), [
    'Where the value goes — 1',
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
  assert.deepEqual(outline([forward.roots[2]]), ['Where the value goes — 1', '  title → <Title text> — prop of Title']);
});
