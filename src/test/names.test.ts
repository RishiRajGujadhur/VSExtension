import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { names } from '../structure/names';
import { actionCatalog } from '../structure/actionCatalog';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));

/** Words that keep their capital in the middle of a name. */
const properNames = new Set(['Code', 'X-Ray', 'VS', 'React', 'Markdown', 'JSON', 'CSV', 'API', 'Explorer', 'Actions']);

test('every command has a plain name, and package.json uses it', () => {
  for (const command of pkg.contributes.commands as { command: string; title: string; category: string }[]) {
    assert.equal(command.title, names[command.command], command.command);
    assert.equal(command.category, 'Code X-Ray', command.command);
  }
});

test('names are in sentence case, short, and the sidebar shows them', () => {
  for (const [command, name] of Object.entries(names)) {
    assert.match(name, /^[A-ZÀ-Ý]/, `${command}: "${name}" starts with a capital`);
    for (const word of name.split(' ').slice(1)) {
      const core = word.replace(/^[("“]+|[…?.,:)"”]+$|’s$/g, '');
      assert.ok(!/^[A-Z][a-z]/.test(core) || properNames.has(core), `${command}: "${name}" has a capital in "${word}"`);
    }
    assert.ok(name.length <= 40, `${command}: "${name}" is long`);
  }
  for (const action of actionCatalog) assert.equal(action.label, names[action.command], action.command);
});

test('a renamed action is still found by its old, technical name', () => {
  const flowchart = actionCatalog.find((a) => a.command === 'tsStructure.controlFlow' && a.tab === 'analyze')!;
  assert.match(flowchart.keywords ?? '', /Control Flow Graph/);
});
