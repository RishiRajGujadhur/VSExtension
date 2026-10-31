// Runs src/test/integration inside a real VS Code against the sample project.
// Usage: VSCODE_EXECUTABLE="/path/to/Code.exe" npm run test:integration
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const executable = process.env.VSCODE_EXECUTABLE;
if (!executable) {
  console.error('Set VSCODE_EXECUTABLE to a VS Code executable (for example a portable install).');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const result = spawnSync(
  executable,
  [
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'integration', 'index.js')}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--user-data-dir=${path.join(os.tmpdir(), 'ts-impact-vscode-user')}`,
    path.join(root, 'sample'),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
