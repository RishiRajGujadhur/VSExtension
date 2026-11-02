import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { commandIcons, featureIcon, reportIcons, rowCommandFeatures } from '../structure/icons';
import { features } from '../structure/features';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributed = new Map<string, unknown>(pkg.contributes.commands.map((c: { command: string; icon?: unknown }) => [c.command, c.icon]));

test('every feature command has its own icon, and every feature too', () => {
  const icons = Object.values(commandIcons);
  assert.equal(new Set(icons).size, icons.length, 'two commands share an icon');
  const byFeature = features.map((f) => featureIcon(f));
  assert.equal(new Set(byFeature).size, byFeature.length, `two features share an icon: ${byFeature.join(', ')}`);
  // Each report names an icon of the command that makes it.
  for (const icon of Object.values(reportIcons)) {
    assert.ok(icons.includes(icon), icon);
  }
});

test('package.json uses the same icons, and row buttons share the icon of the analysis they run', () => {
  for (const [command, icon] of Object.entries(commandIcons)) {
    assert.equal(contributed.get(command), `$(${icon})`, command);
  }
  for (const [command, runs] of Object.entries(rowCommandFeatures)) {
    assert.equal(contributed.get(command), `$(${commandIcons[runs]})`, command);
  }
  // Apart from those, a feature's icon is not reused by another command, so it always means that feature.
  const shared = new Set(Object.keys(rowCommandFeatures));
  for (const [command, icon] of contributed) {
    if (typeof icon === 'string' && !(command in commandIcons) && !shared.has(command)) {
      assert.ok(!Object.values(commandIcons).includes(icon.slice(2, -1)), `${command} reuses ${icon}`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, pkg.icon)), 'the Marketplace icon is missing');
});

test('Analyze or Refactor This lists only commands with an icon', () => {
  const source = fs.readFileSync(path.join(root, 'src/ui/actionsAtCursor.ts'), 'utf8');
  for (const [, command] of source.matchAll(/command: '([\w.]+)', label/g)) {
    assert.ok(commandIcons[command], command);
  }
});
