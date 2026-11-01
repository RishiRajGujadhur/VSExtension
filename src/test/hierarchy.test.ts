import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { hierarchyReport, overrideImpactReport } from '../navigate/hierarchy';
import { ReportNode, forEachReportNode } from '../structure/report';
import { fixtures, offsetIn, virtualProject } from './helpers';

const models = path.join(fixtures, 'navigate/src/models.ts');

function outline(nodes: readonly ReportNode[], maxDepth = 9): string[] {
  const lines: string[] = [];
  forEachReportNode(nodes, (n, depth) => depth <= maxDepth && lines.push(`${'  '.repeat(depth)}${n.label}${n.description ? ` — ${n.description}` : ''}`));
  return lines;
}

test('the hierarchy shows supertypes, nested subtypes and member overrides', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ba|se'));
  assert.deepEqual(outline(report.roots), [
    'abstract class Base — models.ts',
    'Supertypes — 1 type',
    '  interface Shape — implements · models.ts',
    'Subtypes and implementations — 3 types',
    '  class Square — extends · overrides area · models.ts',
    '    class Tiny — extends · overrides area · models.ts',
    '  class Circle — extends · overrides area, describe · models.ts',
    'Members — 3 members',
    '  name — from Shape',
    '  area() — abstract · from Shape · 3 overrides',
    '    Square.area',
    '    Circle.area',
    '    Tiny.area — calls super',
    '  describe() — 1 override',
    '    Circle.describe — calls super',
  ]);
});

test('changing a base method reaches super callers, inheriting subtypes and calls through the base type', () => {
  const report = overrideImpactReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'descr|ibe(): string {\n    return `${'));
  assert.deepEqual(outline(report.roots, 1), [
    'Base.describe — models.ts',
    'Overrides in subtypes — 1 override',
    '  Circle.describe — calls super: affected',
    'Subtypes that inherit it unchanged — 2 types',
    '  Square — inherits describe unchanged: affected · models.ts',
    '  Tiny — inherits describe unchanged: affected · models.ts',
    'Call sites — 1 call',
    '  super calls from overrides — 1 call',
    'Impacted tests — 0 tests',
  ]);
});

test('an abstract member lists implementations and splits calls by the type they go through', () => {
  const report = overrideImpactReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'abstract ar|ea'));
  const lines = outline(report.roots, 1);
  assert.deepEqual(lines.slice(0, 5), [
    'Base.area — overrides Shape.area',
    '  Shape.area — base declaration: callers through it reach this one',
    'Overrides in subtypes — 3 overrides',
    '  Square.area — implements it',
    '  Circle.area — implements it',
  ]);
  assert.ok(lines.includes('  Tiny.area — calls super: affected'), lines.join('\n'));
  assert.ok(lines.includes('  Through Base or a supertype: any implementation may run — 2 calls'), lines.join('\n'));
  assert.ok(lines.includes('  Through Square — 1 call'), lines.join('\n'));
  assert.ok(lines.includes('  super calls from overrides — 1 call'), lines.join('\n'));
  assert.ok(lines.includes('Impacted tests — 1 test'), lines.join('\n'));
});

test('with the cursor on a member, that member is selected', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'describe|(): string {\n    return `${this.name}'));
  const members = report.roots.find((r) => r.label === 'Members')!;
  assert.deepEqual(members.children?.filter((m) => m.focus).map((m) => m.label), ['describe()']);
});

test('inherited members name the supertype they come from', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ti|ny'));
  const inherited = report.roots.find((r) => r.label === 'Inherited members');
  assert.deepEqual(inherited?.children?.map((c) => `${c.label} ${c.description}`), ['name from Base', 'describe() from Base']);
});

test('other types in the hierarchy can become the root', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ba|se'));
  const square = report.roots.find((r) => r.label === 'Subtypes and implementations')?.children?.[0];
  assert.deepEqual(square?.action, { kind: 'showHierarchy', command: 'tsStructure.typeHierarchy', file: square?.action?.file, offset: offsetIn(models, 'class |Square') });
});

test('members open the override impact analysis', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ba|se'));
  const area = report.roots.find((r) => r.label === 'Members')?.children?.find((m) => m.label === 'area()');
  assert.equal(area?.action?.command, 'tsStructure.overrideImpact');
  assert.equal(area?.action?.offset, offsetIn(models, 'abstract |area'));
});

test('overrides show their code on hover', () => {
  const report = hierarchyReport(virtualProject('navigate', 'src/models.ts'), models, offsetIn(models, 'class Ba|se'));
  const area = report.roots.find((r) => r.label === 'Members')?.children?.find((m) => m.label === 'area()');
  const tiny = area?.children?.find((c) => c.label === 'Tiny.area');
  assert.match(tiny?.tooltip ?? '', /area\(\): number \{\n\s+return super\.area\(\) \/ 10;/);
});
