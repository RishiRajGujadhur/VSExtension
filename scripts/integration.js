// Runs src/test/integration inside a real VS Code against the sample project.
// Usage: VSCODE_EXECUTABLE="/path/to/Code.exe" npm run test:integration
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
// VS Code loads the bundle (package.json main), so build it first.
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'bundle.js')], { stdio: 'inherit' });

const executable = process.env.VSCODE_EXECUTABLE;
if (!executable) {
  console.error('Set VSCODE_EXECUTABLE to a VS Code executable (for example a portable install).');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const userData = path.join(os.tmpdir(), 'ts-impact-vscode-user');
// The voice model the tests speak with, as if downloaded: the copy in assets/kitten (node scripts/fetch-kitten.js),
// put where the extension keeps downloaded models. Without it, the voice-over would stop to ask which to download.
const fs = require('fs');
const voiceModels = path.join(userData, 'User', 'globalStorage', 'rishigujadhur.ts-test-impact', 'voice-models');
fs.rmSync(voiceModels, { recursive: true, force: true });
const model = require('../test-fixtures/voice-model.cjs').testVoiceModel();
if (model) fs.cpSync(model.dir, path.join(voiceModels, model.id), { recursive: true });
else console.warn('No assets/kitten: the voice-over tests use the system voice (run node scripts/fetch-kitten.js).');
const result = spawnSync(
  executable,
  [
    // EXTENSION_PATH tests another copy of the extension, such as a packaged .vsix unzipped (its extension/ folder).
    `--extensionDevelopmentPath=${process.env.EXTENSION_PATH || root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'integration', 'index.js')}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--user-data-dir=${userData}`,
    path.join(root, 'sample'),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
