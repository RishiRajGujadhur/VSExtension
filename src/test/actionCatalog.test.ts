import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { actionCatalog, changeLayout, defaultLayout, maxDetailLength, mostUsed, normalizeLayout } from '../structure/actionCatalog';
import { effectiveKeybindings, parseKeybindingsJson, shortcuts } from '../structure/keys';
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

test('every description fits a narrow sidebar, and every action explains itself in full', () => {
  for (const action of actionCatalog) {
    assert.ok(action.detail.length <= maxDetailLength, `${action.label}: "${action.detail}" is ${action.detail.length} characters`);
    assert.ok(action.info.length > action.detail.length, `${action.label} needs a longer explanation`);
    assert.match(action.info, /\.$/, action.label);
  }
});

const df = 'tsStructure.dataFlow';
const cf = 'tsStructure.controlFlow';
const fu = 'tsStructure.semanticUsages';

test('layout: pin, reorder, unpin', () => {
  let layout = defaultLayout();
  layout = changeLayout(layout, { kind: 'pin', command: df });
  layout = changeLayout(layout, { kind: 'pin', command: cf });
  layout = changeLayout(layout, { kind: 'pin', command: fu });
  layout = changeLayout(layout, { kind: 'pin', command: df });
  assert.deepEqual(layout.pinned, [df, cf, fu]);
  assert.deepEqual(changeLayout(layout, { kind: 'move', command: fu, to: 0 }).pinned, [fu, df, cf]);
  assert.deepEqual(changeLayout(layout, { kind: 'move', command: df, to: 99 }).pinned, [cf, fu, df]);
  assert.deepEqual(changeLayout(layout, { kind: 'move', command: df, to: -3 }).pinned, [df, cf, fu]);
  assert.deepEqual(changeLayout(layout, { kind: 'unpin', command: cf }).pinned, [df, fu]);
  // Moving an action that isn't pinned, or naming an unknown one, changes nothing.
  assert.equal(changeLayout(layout, { kind: 'move', command: 'tsStructure.nullability', to: 0 }), layout);
  assert.equal(changeLayout(layout, { kind: 'pin', command: 'workbench.action.quit' }), layout);
});

test('layout: hiding unpins, pinning shows again, and Show All brings every action back', () => {
  let layout = changeLayout(defaultLayout(), { kind: 'pin', command: df });
  layout = changeLayout(layout, { kind: 'hide', command: df });
  layout = changeLayout(layout, { kind: 'hide', command: cf });
  assert.deepEqual(layout.pinned, []);
  assert.deepEqual(layout.hidden, [df, cf]);
  assert.deepEqual(changeLayout(layout, { kind: 'show', command: cf }).hidden, [df]);
  assert.deepEqual(changeLayout(layout, { kind: 'pin', command: cf }).hidden, [df]);
  assert.deepEqual(changeLayout(layout, { kind: 'showAll' }).hidden, []);
});

test('layout: sections fold, and the view settings switch', () => {
  let layout = defaultLayout();
  assert.deepEqual(layout.collapsed, ['hidden'], 'the Hidden section starts folded');
  layout = changeLayout(layout, { kind: 'toggleSection', id: 'category:Values' });
  layout = changeLayout(layout, { kind: 'toggleSection', id: 'hidden' });
  assert.deepEqual(layout.collapsed, ['category:Values']);
  assert.deepEqual(changeLayout(layout, { kind: 'setCollapsed', ids: ['a', 'a', 'b'] }).collapsed, ['a', 'b']);
  assert.equal(changeLayout(layout, { kind: 'compact', value: true }).compact, true);
  assert.equal(changeLayout(layout, { kind: 'hideMostUsed', value: true }).hideMostUsed, true);
});

test('a stored layout is cleaned up: unknown and repeated actions go, hidden ones are not pinned', () => {
  assert.deepEqual(normalizeLayout(undefined), defaultLayout());
  assert.deepEqual(normalizeLayout('nonsense'), defaultLayout());
  const layout = normalizeLayout({ pinned: [df, df, 'gone', 3, cf], hidden: [cf], collapsed: ['x', 4], compact: 'yes', hideMostUsed: true });
  assert.deepEqual(layout, { pinned: [df], hidden: [cf], collapsed: ['x'], compact: false, hideMostUsed: true });
});

test('shortcuts follow the user’s keybindings.json: comments, removed defaults and their own keys', () => {
  const defaults = [
    { command: df, key: 'ctrl+alt+s d', mac: 'cmd+alt+s d' },
    { command: cf, key: 'ctrl+alt+s 1' },
    { command: fu, key: 'alt+f7' },
  ];
  const user = parseKeybindingsJson(`// Place your key bindings in this file
[
  { "key": "ctrl+shift+d", "command": "${df}" }, /* mine */
  { "key": "ctrl+alt+s 1", "command": "-${cf}" },
  { "key": "alt+f7", "command": "-${fu}", "when": "a // not a comment" },
  { "key": "ctrl+k f", "command": "${fu}" },
]`);
  assert.equal(user.length, 4);
  const keys = shortcuts(effectiveKeybindings(defaults, user, 'win32'), 'win32');
  assert.equal(keys.get(df), 'Ctrl+Shift+D');
  assert.equal(keys.get(cf), undefined);
  assert.equal(keys.get(fu), 'Ctrl+K F');
  // No file, or one that isn't valid, leaves the defaults.
  assert.deepEqual(parseKeybindingsJson('{ broken'), []);
  assert.equal(shortcuts(effectiveKeybindings(defaults, [], 'win32'), 'win32').get(cf), 'Ctrl+Alt+S 1');
});
