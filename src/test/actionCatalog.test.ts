import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { actionCatalog, mostUsed } from '../structure/actionCatalog';
import { commandIcons } from '../structure/icons';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const commands = new Map<string, { icon?: string }>(pkg.contributes.commands.map((c: { command: string; icon?: string }) => [c.command, c]));

test('every action in the sidebar is a real command with an icon, listed once', () => {
  for (const action of actionCatalog) {
    assert.ok(commands.has(action.command), action.command);
    assert.ok(action.icon || commandIcons[action.command] || commands.get(action.command)?.icon, `${action.command} has no icon`);
  }
  assert.equal(new Set(actionCatalog.map((a) => a.command)).size, actionCatalog.length);
});

test('most used: the actions run most often, then the defaults', () => {
  const available = actionCatalog.map((a) => a.command);
  assert.deepEqual(mostUsed({}, available, 3), ['tsStructure.dataFlow', 'tsStructure.semanticUsages', 'tsStructure.controlFlow']);
  assert.deepEqual(mostUsed({ 'tsStructure.nullability': 4, 'tsStructure.controlFlow': 7, 'tsStructure.safeDelete': 0 }, available, 3), ['tsStructure.controlFlow', 'tsStructure.nullability', 'tsStructure.dataFlow']);
  // Actions of turned-off features are left out.
  assert.ok(!mostUsed({ 'tsStructure.nullability': 9 }, available.filter((c) => c !== 'tsStructure.nullability')).includes('tsStructure.nullability'));
});
