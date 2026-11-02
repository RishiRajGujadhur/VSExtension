import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { shortcuts } from '../structure/keys';

test('shortcuts are written the way VS Code shows them, per platform', () => {
  const bindings = [
    { command: 'a', key: 'ctrl+f6', mac: 'cmd+f6' },
    { command: 'b', key: 'alt+delete' },
    { command: 'c', key: 'ctrl+k ctrl+t' },
  ];
  assert.equal(shortcuts(bindings, 'win32').get('a'), 'Ctrl+F6');
  assert.equal(shortcuts(bindings, 'darwin').get('a'), 'Cmd+F6');
  assert.equal(shortcuts(bindings, 'darwin').get('b'), 'Alt+Delete');
  assert.equal(shortcuts(bindings, 'linux').get('c'), 'Ctrl+K Ctrl+T');
});
