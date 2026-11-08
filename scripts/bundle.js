// Bundles the extension into one file, dist/extension.js, so VS Code loads one module instead of about 120.
// Usage: node scripts/bundle.js [--production]   (production: minified, no source map)
// TypeScript stays a separate dependency: it is already a single large file, and vscode is provided by VS Code.
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const root = path.resolve(__dirname, '..');

async function bundle() {
  const started = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    outfile: path.join(root, 'dist', 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'typescript'],
    minify: production,
    sourcemap: production ? false : 'linked',
    keepNames: true,
    metafile: true,
    logLevel: 'warning',
  });
  const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint);
  console.log(`bundled ${Object.keys(result.metafile.inputs).length} modules into dist/extension.js (${Math.round(output.bytes / 1024)} KB${production ? ', minified' : ''}) in ${Date.now() - started} ms`);
}

module.exports = { bundle };
if (require.main === module) {
  bundle().catch(() => process.exit(1));
}
