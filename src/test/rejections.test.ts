import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { rejectionReport } from '../inspect/rejections';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/rejections.ts');

function outline(nodes: readonly ReportNode[]): string[] {
  const lines: string[] = [];
  forEachReportNode(nodes.filter((n) => n.label !== 'How to fix'), (n, depth) => lines.push(`${'  '.repeat(depth)}${n.label}${n.tone ? ` [${n.tone}]` : ''}`));
  return lines;
}

test('rejection sources and every path a rejection takes through callers', () => {
  const report = rejectionReport(virtualProject('inspect', 'src/rejections.ts'), file, offsetIn(file, 'function sa|ve('));
  assert.deepEqual(outline(report.roots), [
    'Unhandled [error]',
    '  not awaited: the rejection is unhandled [error]',
    '  returned from arrow function, a callback passed to setTimeout(), which ignores returned promises [error]',
    'Rejection sources',
    "  throws new Error('empty') [error]",
    '  awaits write(data) [warning]',
    'Where rejections go [error]',
    '  caught in safeSave [warning]',
    '    catch block: logs the error and continues [warning]',
    '  caught in strictSave [info]',
    "    catch block: throws new Error('save failed', { cause: error }) instead [info]",
    '  not awaited: the rejection is unhandled [error]',
    '  handled by .catch(…) [ok]',
    '  awaited in relaySave [error]',
    '    returned from arrow function, a callback passed to setTimeout(), which ignores returned promises [error]',
    '  collected by Promise.allSettled, which never rejects [ok]',
  ]);
  assert.equal(report.roots[2].description, '3 handled, 2 unhandled, 1 swallowed or unknown');
  // The flat list says how each unhandled end is reached.
  assert.deepEqual(report.roots[0].children?.map((c) => c.description), ['save(data); · rejections.ts:29', 'via relaySave']);
  // A dropped call offers the missing-await fixes.
  assert.equal(report.roots[0].children?.[0].action?.kind, 'quickFix');
});

test('only branches that need attention start expanded', () => {
  const report = rejectionReport(virtualProject('inspect', 'src/rejections.ts'), file, offsetIn(file, 'function sa|ve('));
  const where = report.roots.find((r) => r.label === 'Where rejections go')!;
  forEachReportNode(where.children ?? [], (node) => {
    if (node.children?.length && node.expanded) {
      assert.ok(node.tone === 'error' || node.tone === 'warning', `${node.label} is expanded`);
    }
  });
  const relay = where.children?.find((c) => c.label === 'awaited in relaySave');
  assert.equal(relay?.expanded, true);
});

test('on a call, the path of that call comes first', () => {
  const report = rejectionReport(virtualProject('inspect', 'src/rejections.ts'), file, offsetIn(file, '  sa|ve(data);\n}'));
  assert.deepEqual(outline(report.roots.slice(0, 1)), ['This call: save(data) [error]', '  not awaited: the rejection is unhandled [error]']);
  assert.ok(report.roots[0].focus);
});
