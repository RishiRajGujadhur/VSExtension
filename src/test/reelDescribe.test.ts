import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeFileChange, describeFunctionChange, differingSpan, readable, speakable } from '../reel/describe';
import { callPhrase, conditionWords, declarationPhrase, exitPhrase, loopPhrase, settingPhrase, verbPhrase, words } from '../reel/words';
import { testClaim } from '../reel/describe';
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
  assert.deepEqual(sentences, ['pay now fails with "empty cart" early when there are no items.', 'It also uses 0.8 instead of 0.9 for the sum.', 'And it audits the sum.']);
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
  assert.deepEqual(describeFileChange('src/cart.test.ts', testFile.split('\n'), [], true, testFile), ['This test file is new: it checks that it rejects an empty cart and that it applies the discount.']);
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

test('Explainer: short forms, kinds, plurals, settings, choices, screens, answers and tests read naturally', () => {
  // Short forms in names read in full.
  assert.equal(words('btnMsgCfg').join(' '), 'button message config');
  // A kind compared with a name, and an "or" of two on the same thing.
  assert.equal(conditionWords("op.kind === 'undo' || op.kind === 'redo'"), 'the operation is an undo or a redo');
  assert.equal(conditionWords("user.role !== 'admin'"), 'the user is not an admin');
  // Plurals agree, and "the number of" is one thing.
  assert.equal(conditionWords('!items.includes(x)'), 'the items do not contain the item');
  assert.equal(conditionWords('fields.length > 3'), 'the number of fields is more than 3');
  // Settings by what they become.
  assert.deepEqual(['setFeature(undefined)', 'setItems([])', 'setLoading(false)', 'setOpen(true)'].map((c) => callPhrase(c)), ['clears the feature', 'empties the items', 'marks it as no longer loading', 'marks it as open']);
  assert.equal(settingPhrase('visible', 'true'), 'marks it as visible');
  assert.equal(settingPhrase('autoSave', 'false'), 'turns the auto save off');
  // Declarations: state kept, a choice between two calls, a choice of value.
  assert.equal(declarationPhrase('const [open, setOpen] = useState(false);'), 'keeps track of whether it is open');
  assert.equal(declarationPhrase("const label = op.kind === 'undo' ? await undoFileEdit() : await redoFileEdit();"), 'undoes or redoes the file edit');
  assert.equal(declarationPhrase("const label = done ? 'Done' : 'Working';"), 'picks the label depending on whether it is done');
  // Answers and screens.
  assert.equal(exitPhrase('return true;', 'return'), 'answers yes');
  assert.equal(exitPhrase('return (\n  <div><Button /></div>\n);', 'return'), 'shows a button');
  // Test names as claims.
  assert.equal(testClaim('rejects an empty cart'), 'that it rejects an empty cart');
  assert.equal(testClaim('should apply the discount'), 'that it applies the discount');
  assert.equal(testClaim('Cart: totals'), '"Cart: totals"');
  assert.equal(verbPhrase('redoFileEdit'), 'redoes the file edit');
});

test('Explainer: what JSX shows, what it reacts to, counting, errors handled', async () => {
  const file = 'c:/demo/T.tsx';
  const before = 'function Toolbar() {\n  return null;\n}';
  const after = 'function Toolbar() {\n  const [open, setOpen] = useState(false);\n  return (\n    <div>\n      <Button onClick={() => setOpen(true)} />\n    </div>\n  );\n}';
  const old = standaloneCharts(file, before)(10);
  const now = standaloneCharts(file, after)(10);
  assert.deepEqual(describeFunctionChange('Toolbar', now, compareCharts(old, now)), ['Toolbar now keeps track of whether it is open.', 'It also shows a button.']);
  const saveBefore = 'async function save(doc) {\n  await write(doc);\n}';
  const saveAfter = 'async function save(doc) {\n  try {\n    await write(doc);\n    count++;\n  } catch (err) {\n    setNotice(err.message);\n  }\n}';
  const s0 = standaloneCharts('c:/demo/s.ts', saveBefore)(10);
  const s1 = standaloneCharts('c:/demo/s.ts', saveAfter)(10);
  const said = describeFunctionChange('save', s1, compareCharts(s0, s1), 4, saveAfter.split('\n').filter((l) => /count\+\+|setNotice/.test(l)).map((text) => ({ kind: 'add', text })));
  assert.ok(said.some((x) => /updates the notice if something goes wrong/.test(x)), said.join(' | '));
  assert.ok(said.some((x) => /counts up the count/.test(x)), said.join(' | '));
});
