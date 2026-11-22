import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { phonemizerEnvironment } from '../reel/kitten';
import { allowedHost } from '../reel/pinnedDownload';
import { CODE_MODEL, fileMatches, fileUrl } from '../reel/codeModelText';

const root = path.resolve(__dirname, '../..');
// The engine is bundled (dist/kitten); a voice model is downloaded on use, here the copy in assets/kitten.
const bundled = fs.existsSync(path.join(root, 'dist', 'kitten', 'phonemize.mjs')) && fs.existsSync(path.join(root, 'assets', 'kitten', 'voices.npz'));

test('Privacy: the voice-over runs with every network route blocked, and tries none', { skip: !bundled && 'needs the bundle and assets/kitten (node scripts/fetch-kitten.js)', timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-privacy-'));
  const log = path.join(dir, 'network.log');
  fs.writeFileSync(log, '');
  try {
    const preload = path.join(root, 'test-fixtures', 'block-network.cjs');
    // The preload blocks and logs sockets, DNS, HTTP(S), fetch and UDP in this process, its worker thread (the
    // model) and its child process (the phonemizer, which gets NODE_OPTIONS).
    const out = execFileSync(process.execPath, ['--require', preload, path.join(root, 'test-fixtures', 'narrate-offline.cjs')], {
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, NETWORK_LOG: log, CACHE_DIR: path.join(dir, 'cache') },
      encoding: 'utf8',
      timeout: 170000,
    });
    const result = JSON.parse(out) as { seconds?: number; error?: string };
    assert.equal(result.error, undefined, result.error);
    assert.ok((result.seconds ?? 0) > 2, `narrated ${result.seconds} s`);
    assert.equal(fs.readFileSync(log, 'utf8'), '', 'network attempts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Privacy: the phonemizer gets only what it needs from the environment, never tokens or keys', () => {
  const env = phonemizerEnvironment({ PATH: '/bin', GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'k', OPENAI_API_KEY: 'k', HOME: '/home/me', TEMP: '/tmp' });
  assert.deepEqual(env, { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', TEMP: '/tmp' });
});

test('Privacy: the code model is downloaded from Hugging Face only, pinned, checked, and sends nothing of yours', () => {
  assert.ok(allowedHost('huggingface.co') && allowedHost('cdn-lfs.huggingface.co') && allowedHost('cas-bridge.xethub.hf.co'));
  assert.ok(!allowedHost('example.com') && !allowedHost('huggingface.co.example.com') && !allowedHost('evilhf.co'));
  for (const file of CODE_MODEL.files) assert.match(fileUrl(file), /^https:\/\/huggingface\.co\/Xenova\/all-MiniLM-L6-v2\/resolve\/[0-9a-f]{40}\//);
  // Only the download module touches the network, only in its download, with no cookie, token or name of yours.
  const source = fs.readFileSync(path.join(root, 'src', 'reel', 'pinnedDownload.ts'), 'utf8');
  assert.equal((source.match(/https\.get\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /Authorization|Cookie|process\.env|os\.userInfo|hostname\(\)/);
  assert.ok(!fileMatches(CODE_MODEL.files[1], Buffer.from('not the vocabulary')));
});

test('Privacy: nothing the extension ships calls the network, and its pages cannot', () => {
  // The extension's own code: no network modules, no fetch, no sockets (analyses only name them as text). The one
  // exception is the code model's download (above), which you start yourself.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|js|mjs)$/.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        if (/require\(['"](https?|net|tls|dgram|dns)['"]\)|from ['"](node:)?(https?|net|tls|dgram|dns)['"]|new WebSocket\(|sendBeacon\(/.test(text)) offenders.push(path.relative(root, file));
      }
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'media'));
  assert.deepEqual(offenders.filter((f) => !f.startsWith(path.join('src', 'test'))), [path.join('src', 'reel', 'pinnedDownload.ts')]);
  // Every webview page: no connections, no remote scripts, styles or images.
  const page = fs.readFileSync(path.join(root, 'src', 'ui', 'webviewPage.ts'), 'utf8');
  assert.match(page, /default-src 'none'/);
  assert.doesNotMatch(page, /connect-src|https?:\/\/\*/);
});
