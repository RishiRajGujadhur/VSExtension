import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeFileChange, describeFunctionChange, differingSpan, readable, speakable } from '../reel/describe';
import { callPhrase, conditionWords, loopPhrase, verbPhrase, words } from '../reel/words';
import { standaloneCharts } from '../inspect/controlFlowChart';
import { compareCharts } from '../inspect/flowCompare';

test('Code to English: names, conditions, calls and loops read as plain words', () => {
  assert.deepEqual(words('parseURLQuery'), ['parse', 'URL', 'query']);
  assert.equal(verbPhrase('validateSettingsExport'), 'validates the settings export');
  assert.equal(verbPhrase('isEmpty'), 'checks whether it is empty');
  assert.equal(verbPhrase('onClick'), 'handles the click');
  assert.equal(verbPhrase('sizeOf'), 'works out the size');
  assert.equal(conditionWords('!items.length'), 'there are no items');
  assert.equal(conditionWords('amount <= 0'), 'the amount is at most 0');
  assert.equal(conditionWords('!object(value.tracing)'), "the value's tracing is not an object");
  assert.equal(conditionWords('!fs.existsSync(file)'), 'the file does not exist');
  assert.equal(conditionWords('playing'), 'it is playing');
  assert.equal(conditionWords('@name IS NULL'), 'the name is missing');
  assert.equal(callPhrase('fs.writeFileSync(file, data)'), 'writes a file');
  assert.equal(callPhrase('this.save(user)'), 'saves the user');
  assert.equal(callPhrase('window.addEventListener("resize", f)'), 'listens for resize events');
  assert.equal(loopPhrase('for (const field of fields)'), 'goes through each field in the fields');
});

test('Change describer: what a changed function now does, in sentences, without counts', () => {
  const file = 'c:/demo/a.ts';
  const before = 'function pay(items: number[]) {\n  let sum = 0;\n  sum = sum * 0.9;\n  return sum;\n}';
  const after = 'function pay(items: number[]) {\n  if (!items.length) throw new Error("empty cart");\n  let sum = 0;\n  sum = sum * 0.8;\n  audit(sum);\n  return sum;\n}';
  const old = standaloneCharts(file, before)(10);
  const now = standaloneCharts(file, after)(10);
  const sentences = describeFunctionChange('pay', now, compareCharts(old, now), 3, [
    { kind: 'del', text: '  sum = sum * 0.9;', span: [14, 17] },
    { kind: 'add', text: '  sum = sum * 0.8;', span: [14, 17] },
    { kind: 'add', text: '  audit(sum);' },
  ]);
  assert.deepEqual(sentences, ['pay now fails with "empty cart" early when there are no items.', 'It also uses 0.8 instead of 0.9 for the sum.', 'It also audits the sum.']);
  assert.ok(sentences.every((s) => !/\d+ (boxes|paths|lines)/.test(s)));
  // A function that was not there.
  const fresh = describeFunctionChange('validatePayment', now, compareCharts(undefined, now));
  assert.equal(fresh[0], 'validatePayment is new: it validates the payment.');
  assert.match(fresh[1], /^It fails with "empty cart" early when there are no items/);
});

test('Change describer: new files by what they hold, changed files by what they now use', () => {
  const script = 'export function validateSettings(s: unknown) { return true; }\nexport interface Settings { port: number }\n';
  assert.deepEqual(describeFileChange('src/settings.ts', script.split('\n'), [], true, script), ['This new file adds validateSettings, which validates the settings and the shape of settings.']);
  const testFile = "test('rejects an empty cart', () => {});\ntest('applies the discount', () => {});";
  assert.deepEqual(describeFileChange('src/cart.test.ts', testFile.split('\n'), [], true, testFile), ['This new test file checks "rejects an empty cart" and "applies the discount".']);
  assert.deepEqual(describeFileChange('media/reel.css', ['.timeline { }', '.big-play { }'], [], true, '.timeline { }\n.big-play { }'), ['This new stylesheet styles the timeline and the big play.']);
  assert.deepEqual(describeFileChange('src/a.ts', ["import { retry } from './retry';", 'export function charge() {'], ["import { old } from './old';"], false), [
    'This file now uses retry from the retry module.',
    'It no longer uses the old module.',
    'It now offers charge, which charges.',
  ]);
  assert.deepEqual(describeFileChange('package.json', ['  "version": "0.84.0",'], ['  "version": "0.83.0",'], false), ['This file sets the version to 0.84.0.']);
});

test('Change describer: sentences that would read as code are left out; the voice never reads a file name', () => {
  assert.equal(readable('sets x to a + b * 2'), false);
  assert.equal(readable('returns 0 early when there are no items'), true);
  assert.equal(readable('uses 0.8 instead of 0.9 for the sum'), true);
  assert.deepEqual(differingSpan('sum = sum * 0.9;', 'sum = sum * 0.8;'), ['0.9', '0.8']);
  assert.equal(speakable('settingsValidation.ts — This new file adds validateSettings.'), 'This new file adds validate Settings.');
  assert.equal(speakable('It moves code out of src/reel/plan.ts and app.module.css.'), 'It moves code out of this file and this file.');
  assert.equal(speakable('Changes a ?? b to a === b.'), 'Changes a or else b to a equals b.');
});
