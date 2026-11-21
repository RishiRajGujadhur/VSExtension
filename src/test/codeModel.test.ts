import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { CodeModel } from '../reel/codeModel';
import { basicTokens, codeAsWords, CODE_MODEL, cosine, fileMatches, meanPool, readVocab, tokenize, wordPieces } from '../reel/codeModelText';
import { understandCandidates } from '../reel/plan';

const root = path.resolve(__dirname, '../..');
// Downloaded once into assets/code-model (git-ignored), as the extension downloads it on your agreement.
const modelDir = path.join(root, 'assets', 'code-model');
const downloaded = CODE_MODEL.files.every((f) => fs.existsSync(path.join(modelDir, f.name)));
const runnable = downloaded && fs.existsSync(path.join(root, 'dist', 'codeModelWorker.js')) && fs.existsSync(path.join(root, 'dist', 'kitten', 'ort', 'ort.wasm.min.mjs'));

test('Code model: BERT tokenizing, lowercase, punctuation apart, longest pieces first', () => {
  assert.deepEqual(basicTokens('Add-to-Cart, NOW!'), ['add', '-', 'to', '-', 'cart', ',', 'now', '!']);
  assert.deepEqual(basicTokens('Café'), ['cafe']);
  const vocab = readVocab(['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'cart', 'add', '##ing', 'play', '##s'].join('\n'));
  assert.deepEqual(wordPieces('playings', vocab), [7, 6, 8]);
  assert.deepEqual(wordPieces('zebra', vocab), [1]);
  assert.deepEqual(tokenize('Add cart', vocab), [2, 5, 4, 3]);
  assert.equal(tokenize('add '.repeat(300), vocab, 10).length, 10);
});

test('Code model: names and code as words, mean pooling to unit length, pinned files', () => {
  assert.equal(codeAsWords('addToCart', ['setItems((prev) => [...prev, item]); // keep order', 'const label = "Hello there";']), 'add cart set items prev item label');
  const v = meanPool(Float32Array.from([1, 0, 3, 0]), 2, 2);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.deepEqual([...v], [1, 0]);
  assert.equal(CODE_MODEL.files.length, 2);
  assert.ok(!fileMatches(CODE_MODEL.files[0], Buffer.alloc(10)));
});

test('Code model: the downloaded files are the pinned ones', { skip: !downloaded && 'assets/code-model is not downloaded' }, () => {
  for (const f of CODE_MODEL.files) assert.ok(fileMatches(f, fs.readFileSync(path.join(modelDir, f.name))), f.name);
  assert.ok(new CodeModel(modelDir, '', '').downloaded);
});

test('Code model: names what a function is for, and ranks changes by the title', { skip: !runnable && 'needs assets/code-model and the bundle', timeout: 120000 }, async () => {
  const model = new CodeModel(modelDir, path.join(root, 'dist', 'codeModelWorker.js'), path.join(root, 'dist', 'kitten', 'ort'));
  try {
    const [a, b, c] = await model.embed(['add an item to the cart', 'put a product in the basket', 'parse a date from text']);
    assert.ok(cosine(a, b) > cosine(a, c));
    const make = (name: string, line: string) => ({ feature: undefined as string | undefined, weight: 10, caption: `${name} now does something.`, seconds: 3, lines: [], model: { text: codeAsWords(name, [line]), name, withFeature: (phrase: string) => `${name} ${phrase}. It now does something.` } });
    const coupon = make('applyCoupon', 'const discount = coupon.percent * subtotal / 100;');
    const orders = make('getOrders', 'const res = await api.request(`/orders`);');
    const date = make('parseDate', 'return new Date(text.replace(/-/g, "/"));');
    await understandCandidates([coupon, orders, date], 'Apply coupon discounts at checkout', (texts) => model.embed(texts));
    assert.equal(coupon.feature, 'Works out coupon');
    assert.match(coupon.caption, /^applyCoupon works out the coupon\./);
    assert.equal(orders.feature, 'Loads orders');
    // Formatting is not a feature: nothing named.
    assert.equal(date.feature, undefined);
    // Closest to the title, weighs most.
    assert.ok(coupon.weight > orders.weight && coupon.weight > date.weight);
  } finally {
    model.dispose();
  }
});
