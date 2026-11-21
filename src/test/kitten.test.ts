import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_KITTEN_VOICE, encode, KITTEN_VOICES, modelSpeed, phonemeParts, readVoices, spaceTokens, styleFor, toWav, trimEnd } from '../reel/kittenModel';
import { KittenNarrator } from '../reel/kitten';
import { wavSeconds } from '../reel/voice';

const root = path.resolve(__dirname, '../..');
const home = path.join(root, 'dist', 'kitten');
const bundled = fs.existsSync(path.join(home, 'model', 'voices.npz'));

test('Kitten: phonemes to tokens as the model expects, spaced words and marks, pieces around punctuation', () => {
  // Start token 0, then symbols, then end 10 and pad 0; unknown symbols are skipped.
  assert.deepEqual(encode('ab'), [0, 43, 44, 10, 0]);
  assert.deepEqual(encode('a\u{1F600}b'), [0, 43, 44, 10, 0]);
  assert.equal(spaceTokens('həlˈoʊ, wˈɜːld.'), 'həlˈoʊ , wˈɜːld .');
  assert.deepEqual(phonemeParts('Hello, world.'), [{ text: 'Hello', mark: false }, { text: ',', mark: true }, { text: 'world', mark: false }, { text: '.', mark: true }]);
  assert.equal(Object.keys(KITTEN_VOICES).length, 8);
  assert.equal(DEFAULT_KITTEN_VOICE, 'Jasper');
});

test('Kitten: a natural pace from the voices\' slower priors, silence trimmed, a WAV of the right length', () => {
  assert.equal(modelSpeed('Jasper'), 1);
  assert.equal(modelSpeed('Hugo'), 0.9 / 0.8);
  assert.equal(modelSpeed('Bella', 1.5), 1.5);
  const samples = new Float32Array(24000 + 2400);
  samples.fill(0.2, 0, 24000);
  assert.equal(trimEnd(samples).length, 24000);
  assert.equal(wavSeconds(toWav(new Float32Array(48000))), 2);
});

test('Kitten: the bundled voices file holds the eight voices, a style row for each text length', { skip: !bundled && 'dist/kitten is built by the bundle' }, () => {
  const voices = readVoices(fs.readFileSync(path.join(home, 'model', 'voices.npz')));
  for (const key of Object.values(KITTEN_VOICES)) {
    assert.ok(voices[key], key);
    assert.equal(voices[key].cols, 256);
  }
  const table = voices[KITTEN_VOICES.Jasper];
  assert.equal(styleFor(table, 10).length, 256);
  // Past the last row, the last row.
  assert.deepEqual(styleFor(table, 100000), styleFor(table, table.rows + 2));
});

test('Kitten: the narrator speaks a caption with the bundled model, offline, and keeps the clip', { skip: !bundled && 'dist/kitten is built by the bundle', timeout: 120000 }, async () => {
  const narrator = new KittenNarrator(home, path.join(root, 'dist', 'kittenWorker.js'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'kitten-test-'));
  try {
    assert.ok(narrator.available);
    assert.match(await narrator.phonemes('Returns zero early.'), /ɹᵻtˈɜːnz zˈiəɹoʊ ˈɜːli \./);
    const items = [{ id: 'a', text: 'apply Coupon now returns 0 early when the amount is at most 0.' }];
    assert.equal(narrator.missing(items, 'Kitten Jasper', cache), 1);
    let reported = 0;
    const [clip] = await narrator.speak(items, 'Kitten Jasper', cache, () => reported++);
    assert.equal(reported, 1);
    // Speech: a few seconds, loud in places, quiet between words.
    assert.ok(clip.seconds > 2 && clip.seconds < 9, `${clip.seconds} s`);
    const pcm = clip.wav.subarray(44);
    let loud = 0;
    for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 3000) loud++;
    assert.ok(loud > pcm.length / 2 / 50, 'loud enough to be speech');
    // Kept: asked again, nothing to make.
    assert.equal(narrator.missing(items, 'Kitten Jasper', cache), 0);
    await assert.rejects(narrator.speak(items, 'Nobody', cache), /No natural voice/);
  } finally {
    narrator.dispose();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
