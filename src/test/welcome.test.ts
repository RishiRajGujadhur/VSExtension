import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { boldRuns, pictureOf, welcomeSteps } from '../structure/welcome';

const root = path.join(__dirname, '..', '..');

test('welcome: bold runs, command buttons, and the picture of a media page with its folder', () => {
  assert.deepEqual(boldRuns('Press **Ctrl+F6** to change'), [{ text: 'Press ' }, { text: 'Ctrl+F6', bold: true }, { text: ' to change' }]);
  const [step] = welcomeSteps(
    [{ id: 'a', title: 'A', description: 'Run **it** now.\n[Do It](command:tsStructure.doIt)\n[Help](command:tsStructure.help)', media: { markdown: 'media/walkthrough/a.md' } }],
    () => '<p><img src="a.png" alt="An A" width="360"></p><p><em>The A.</em></p>',
  );
  assert.deepEqual(step.buttons, [{ label: 'Do It', command: 'tsStructure.doIt' }, { label: 'Help', command: 'tsStructure.help' }]);
  assert.deepEqual(step.text, [{ text: 'Run ' }, { text: 'it', bold: true }, { text: ' now.' }]);
  assert.deepEqual(step.image, { file: 'media/walkthrough/a.png', alt: 'An A', caption: 'The A.' });
  assert.equal(pictureOf('no picture'), undefined);
});

test('welcome: every walkthrough step has a title, a button and a picture that exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const walkthrough = pkg.contributes.walkthroughs.find((w: { id: string }) => w.id === 'gettingStarted');
  const steps = welcomeSteps(walkthrough.steps, (p) => fs.readFileSync(path.join(root, p), 'utf8'));
  assert.equal(steps.length, 8);
  const commands = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
  for (const step of steps) {
    assert.ok(step.buttons.length, step.id);
    for (const b of step.buttons) assert.ok(commands.has(b.command), b.command);
    assert.ok(step.image && fs.existsSync(path.join(root, step.image.file)), `${step.id}: ${step.image?.file}`);
  }
});
