// Fetches the Kitten TTS Nano 0.8 (int8) voice model into assets/kitten, at a pinned revision, and checks every file
// against its SHA-256. It is a copy for the tests and recordings only (git-ignored, never packaged): the extension ships
// no voice model and downloads the one a user chooses, after they agree. Files already there with the right checksum
// are kept.
// Model: https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8 (Apache-2.0, KittenML / Stellon Labs).
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const REPO = 'KittenML/kitten-tts-nano-0.8-int8';
const REVISION = '84781d74e29ee25217551556398b42f80593a813';
const FILES = {
  'kitten_tts_nano_v0_8.onnx': 'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc',
  'voices.npz': '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f',
  'config.json': 'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64',
};
const target = path.resolve(__dirname, '..', 'assets', 'kitten');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'code-xray-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).href, file, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`${url}: HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fetchKitten() {
  fs.mkdirSync(target, { recursive: true });
  for (const [name, expected] of Object.entries(FILES)) {
    const file = path.join(target, name);
    if (fs.existsSync(file) && sha256(file) === expected) continue;
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`;
    console.log(`fetching ${name} from ${REPO}@${REVISION.slice(0, 8)}`);
    await download(url, `${file}.part`);
    const actual = sha256(`${file}.part`);
    if (actual !== expected) {
      fs.rmSync(`${file}.part`, { force: true });
      throw new Error(`${name}: checksum ${actual} does not match ${expected}`);
    }
    fs.renameSync(`${file}.part`, file);
  }
  console.log(`Kitten voice model ready in assets/kitten (${REPO}@${REVISION.slice(0, 8)})`);
}

module.exports = { fetchKitten, FILES, REVISION };
if (require.main === module) {
  fetchKitten().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
