import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { enabledByDefault, featureOf, featureWhen, features } from '../structure/features';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const contributes = pkg.contributes;
const settings = Object.assign({}, ...contributes.configuration.map((section: { properties: object }) => section.properties));

test('every feature has a switch in the settings; only the core ones are on by default', () => {
  for (const feature of features) {
    assert.equal(settings[`tsStructure.features.${feature.id}`]?.default, enabledByDefault(feature), feature.id);
  }
  assert.ok(features.filter(enabledByDefault).length < features.length / 2 + 1, 'most features start off');
});

test('every feature command is contributed and belongs to one feature', () => {
  const contributed = new Set(contributes.commands.map((c: { command: string }) => c.command));
  const seen = new Set<string>();
  for (const feature of features) {
    for (const command of feature.commands) {
      assert.ok(contributed.has(command), command);
      assert.ok(!seen.has(command), `${command} is in two features`);
      seen.add(command);
    }
  }
});

test('menus and keybindings of a feature are hidden while it is off', () => {
  const entries = [...Object.values(contributes.menus).flat(), ...contributes.keybindings] as { command?: string; when?: string }[];
  for (const entry of entries) {
    const feature = entry.command && featureOf(entry.command);
    if (feature && entry.when !== 'false') {
      assert.ok(entry.when?.includes(featureWhen(feature)), `${entry.command} when: ${entry.when}`);
    }
  }
});

test('every feature command is in the command palette only while its feature is on', () => {
  for (const feature of features) {
    for (const command of feature.commands) {
      const entry = contributes.menus.commandPalette.find((m: { command: string }) => m.command === command);
      assert.ok(entry, command);
    }
  }
});

test('file settings can differ per workspace folder', () => {
  for (const key of ['tsStructure.include', 'tsStructure.exclude', 'tsStructure.inspections.severity', 'tsStructure.deadExports.entryPoints']) {
    assert.equal(settings[key]?.scope, 'resource', key);
  }
});
