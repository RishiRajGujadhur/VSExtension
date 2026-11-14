import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { callGraphReport } from '../navigate/callGraph';
import { DiagramNode, badgeOf, reportDiagram } from '../structure/diagram';
import { ReportNode } from '../structure/report';
import { ProjectService } from '../analysis/project';

const kind = (label: string, description?: string, parent?: string) => badgeOf({ label, description } as ReportNode, parent)?.key;

test('badges: calls, errors and promises get their kind from the words of the row', () => {
  assert.equal(kind('persist', 'orders.ts:7 · called at line 15 · async'), 'async');
  assert.equal(kind('main.ts (module scope)', 'top-level code · line 12'), 'entry');
  assert.equal(kind('walk', 'tree.ts:3 · calls itself (recursion)'), 'recursion');
  // A repeat wins over everything else, so hiding repeats hides them all.
  assert.equal(kind('GiftCardPayment.charge', 'models.ts:56 · async · shown above'), 'repeat');
  assert.equal(kind('CardPayment.charge', 'models.ts:40 · implementation · async'), 'impl');
  assert.equal(kind('not awaited: the rejection is unhandled'), 'unhandled');
  assert.equal(kind('checkName() → throw new Error()', 'escapes to the caller · 2 calls deep'), 'unhandled');
  assert.equal(kind('caught in load', 'empty catch block swallows the error'), 'swallowed');
  assert.equal(kind('caught in load', 'handles the error'), 'handled');
  assert.equal(kind('throw new Error(\'empty\')'), 'throw');
});

test('badges: values, React, types and modules', () => {
  assert.equal(kind('reads count, missing from the dependencies'), 'missingDep');
  assert.equal(kind('mutates parameter items (.push())', 'items.push(x)'), 'param');
  assert.equal(kind('changes module state carts (.set())', 'carts.set(id, items)'), 'shared');
  assert.equal(kind('user: User | undefined', 'may be undefined here'), 'maybe');
  assert.equal(kind('user.name', 'line 33 · safe'), 'safe');
  assert.equal(kind('abstract class Base'), 'abstract');
  assert.equal(kind('interface Shape'), 'interface');
  assert.equal(kind('Tiny.area', 'calls super: affected'), 'super');
  assert.equal(kind('Through Base or a supertype: any implementation may run', '2 calls'), 'throughBase');
  assert.equal(kind('src/app.tsx · import type { Shape } from \'./models\''), 'typeOnly');
  assert.equal(kind('app.tsx', 'line 2', 'Import it directly'), 'direct');
  assert.equal(kind('main.ts', 'line 4', 'Through 2 other modules'), 'indirect');
  assert.equal(kind('Replace as with a check', undefined, 'How to fix'), 'tip');
  assert.equal(kind('placeOrder', 'orders.ts:18 · called at line 4'), undefined);
});

test('badges: chart boxes carry a badge, with a pill and a theme colour role, but tests and arrow functions keep their own look', () => {
  const demo = path.resolve(__dirname, '../../docs/demo/src/orders.ts');
  const text = fs.readFileSync(demo, 'utf8');
  const diagram = reportDiagram(callGraphReport(new ProjectService().createVirtualProject(demo), demo, text.indexOf('function placeOrder') + 9));
  const all: DiagramNode[] = [];
  const walk = (nodes: DiagramNode[]) => nodes.forEach((n) => { all.push(n); walk(n.children); });
  walk([...diagram.left, ...diagram.right]);
  const badged = all.filter((n) => n.badge);
  assert.ok(badged.some((n) => n.badge?.key === 'async' && n.badge.pill === 'async' && n.badge.color === 'blue'));
  assert.ok(badged.some((n) => n.badge?.key === 'entry'));
  assert.ok(all.filter((n) => n.test || n.arrow).every((n) => !n.badge));
});
