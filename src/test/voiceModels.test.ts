import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_VOICE_MODEL, SYSTEM_VOICE_MODEL, VOICE_MODELS, voiceModel, VoiceModelStore } from '../reel/voiceModels';
import { fileUrl } from '../reel/codeModelText';
import { credits } from '../structure/credits';

const root = path.resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require(path.join(root, 'package.json'));

test('Voice models: Kitten 0.8, pinned and checked, Nano recommended and the default', () => {
  assert.deepEqual(VOICE_MODELS.map((m) => m.id), ['kitten-nano-int8', 'kitten-nano', 'kitten-micro', 'kitten-mini']);
  assert.deepEqual(VOICE_MODELS.filter((m) => m.recommended).map((m) => m.id), [DEFAULT_VOICE_MODEL]);
  assert.equal(voiceModel(DEFAULT_VOICE_MODEL)?.name, 'Kitten Nano');
  for (const m of VOICE_MODELS) {
    assert.match(m.revision, /^[0-9a-f]{40}$/, m.id);
    assert.deepEqual(m.files.map((f) => f.name), ['model.onnx', 'voices.npz']);
    for (const f of m.files) {
      assert.match(f.sha256 ?? '', /^[0-9a-f]{64}$/, `${m.id} ${f.name}`);
      // Only ever from Hugging Face, at the pinned revision.
      assert.match(fileUrl(f, m.repo, m.revision), new RegExp(`^https://huggingface\\.co/KittenML/kitten-tts-[a-z0-9.-]+/resolve/${m.revision}/`));
    }
    // The size said in the prompts is the download.
    assert.ok(Math.abs(m.files.reduce((n, f) => n + f.size, 0) / 1e6 - m.megabytes) < 0.6, m.id);
  }
  // The setting offers every model and the computer's own voice, Nano by default.
  const setting = pkg.contributes.configuration.find((s: { title: string }) => s.title === 'Git reel').properties['tsStructure.reel.voiceModel'];
  assert.deepEqual(setting.enum, [...VOICE_MODELS.map((m) => m.id), SYSTEM_VOICE_MODEL]);
  assert.equal(setting.default, DEFAULT_VOICE_MODEL);
});

test('Voice models: none ships with the extension; a downloaded one is found by its files, and removed', () => {
  const ignored = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignored, /^assets\/\*\*$/m);
  const bundle = fs.readFileSync(path.join(root, 'scripts', 'bundle.js'), 'utf8');
  assert.doesNotMatch(bundle, /fetchKitten|\.onnx'/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-store-'));
  try {
    const store = new VoiceModelStore(dir);
    const nano = voiceModel(DEFAULT_VOICE_MODEL)!;
    assert.ok(!store.downloaded(nano));
    fs.mkdirSync(store.dir(nano), { recursive: true });
    // A file of the wrong size is not a download.
    for (const f of nano.files) fs.writeFileSync(path.join(store.dir(nano), f.name), Buffer.alloc(10));
    assert.ok(!store.downloaded(nano));
    for (const f of nano.files) fs.truncateSync(path.join(store.dir(nano), f.name), f.size);
    assert.deepEqual(store.list().map((m) => m.id), [nano.id]);
    store.remove(nano);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Credits: every library and model, with its author, license and page, bundled or downloaded', () => {
  for (const c of credits) {
    assert.ok(c.name && c.usedFor && c.author && c.license && c.size, c.name);
    assert.match(c.url, /^https:\/\//, c.name);
    if (c.licenseUrl) assert.match(c.licenseUrl, /^https:\/\//, c.name);
  }
  const named = (part: string) => credits.find((c) => c.name.includes(part));
  for (const part of ['TypeScript', 'web-tree-sitter', 'tree-sitter-c-sharp', 'Codicons', 'robot-components', 'ONNX Runtime', 'eSpeak NG', 'Kitten TTS', 'all-MiniLM-L6-v2']) assert.ok(named(part), part);
  assert.equal(named('Kitten TTS')?.shipped, 'downloaded');
  assert.equal(named('all-MiniLM-L6-v2')?.shipped, 'downloaded');
  // Every component the notices name has its card.
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const heading of notices.match(/^## .+$/gm) ?? []) {
    const first = heading.replace(/^## /, '').split(/[ (]/)[0];
    assert.ok(credits.some((c) => c.name.includes(first)), `${heading} has a credit`);
  }
});
