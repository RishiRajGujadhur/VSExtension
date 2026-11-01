// Captures the README screenshots: drives a real VS Code over the demo project and saves PNGs to docs/images.
// Usage: VSCODE_EXECUTABLE="/path/to/Code.exe" npm run screenshots [-- sceneName ...]
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const executable = process.env.VSCODE_EXECUTABLE;
if (!executable) {
  console.error('Set VSCODE_EXECUTABLE to a VS Code executable (for example a portable install).');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');

// A throwaway Git repository holding the demo project, so the graph diff has a revision to compare with.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshop-demo-'));
fs.cpSync(path.join(root, 'docs', 'demo'), workspace, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
git('init', '-q');
// Keep the demo's line endings on checkout, so restoring files after a scene doesn't change them.
git('config', 'core.autocrlf', 'false');
git('add', '.');
git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'Demo project');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-shots-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'User', 'settings.json'),
  JSON.stringify(
    {
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.layoutControl.enabled': false,
      'window.commandCenter': false,
      'window.restoreWindows': 'none',
      'editor.minimap.enabled': false,
      'editor.fontSize': 14,
      'editor.stickyScroll.enabled': false,
      'breadcrumbs.enabled': false,
      'chat.disableAIFeatures': true,
      'git.enabled': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
    },
    null,
    2,
  ),
);

const port = 9339;
const result = spawnSync(
  executable,
  [
    `--remote-debugging-port=${port}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'screenshots', 'index.js')}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--user-data-dir=${userData}`,
    workspace,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, SCREENSHOT_PORT: String(port), SCREENSHOT_DIR: path.join(root, 'docs', 'images'), SCREENSHOT_ONLY: process.argv.slice(2).join(',') },
  },
);
for (const dir of [workspace, userData]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still held open on Windows; it is in the temp directory either way.
  }
}
process.exit(result.status ?? 1);
