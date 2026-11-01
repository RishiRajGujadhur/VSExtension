import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { rejectionReport } from '../inspect/rejections';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/rejections.ts');

function outline(nodes: readonly ReportNode[]): string[] {
  const lines: string[] = [];
  forEachReportNode(nodes, (n, depth) => lines.push(`${'  '.repeat(depth)}${n.label}${n.tone ? ` [${n.tone}]` : ''}`));
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
  assert.deepEqual(report.roots[0].children?.map((c) => c.description), ['save(data);', 'via relaySave']);
});
