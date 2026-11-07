import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { relatedAnalyses } from '../structure/related';

test('every Next entry runs a contributed command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const commands = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
  for (const [kind, list] of Object.entries(relatedAnalyses)) {
    for (const r of list) assert.ok(commands.has(r.command), `${kind}: ${r.command}`);
  }
});
