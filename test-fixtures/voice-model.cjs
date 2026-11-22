// For tests: the Kitten Nano int8 voice model laid out as the extension keeps a downloaded one (model.onnx and
// voices.npz in a folder of its own), from the copy `node scripts/fetch-kitten.js` puts in assets/kitten. Undefined
// when that copy is not there.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function testVoiceModel() {
  const source = path.join(root, 'assets', 'kitten');
  const onnx = path.join(source, 'kitten_tts_nano_v0_8.onnx');
  const voices = path.join(source, 'voices.npz');
  if (!fs.existsSync(onnx) || !fs.existsSync(voices)) return undefined;
  const dir = path.join(os.tmpdir(), 'code-x-ray-test-voice-model', 'kitten-nano-int8');
  fs.mkdirSync(dir, { recursive: true });
  for (const [from, name] of [[onnx, 'model.onnx'], [voices, 'voices.npz']]) {
    const to = path.join(dir, name);
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
  }
  return { id: 'kitten-nano-int8', dir, priors: true };
}

module.exports = { testVoiceModel };
