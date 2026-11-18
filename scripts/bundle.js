// Bundles the extension into one file, dist/extension.js, so VS Code loads one module instead of about 120.
// Usage: node scripts/bundle.js [--production]   (production: minified, no source map)
// TypeScript stays a separate dependency: it is already a single large file, and vscode is provided by VS Code.
// The C# parser's two .wasm files are copied to dist/parsers.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const root = path.resolve(__dirname, '..');

async function bundle() {
  const started = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'boot.ts')],
    outfile: path.join(root, 'dist', 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'typescript'],
    // The C# parser (web-tree-sitter) is an ES module that finds its files from import.meta.url, which a CommonJS
    // bundle doesn't have: it becomes the bundle's own file URL.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    minify: production,
    sourcemap: production ? false : 'linked',
    keepNames: true,
    metafile: true,
    logLevel: 'warning',
  });
  // The C# parser's WebAssembly (src/csharp/parser.ts loads it from dist/parsers): node_modules is not packaged.
  const parsers = path.join(root, 'dist', 'parsers');
  fs.mkdirSync(parsers, { recursive: true });
  for (const [pkg, file] of [['web-tree-sitter', 'tree-sitter.wasm'], ['tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm']]) {
    fs.copyFileSync(path.join(root, 'node_modules', pkg, file), path.join(parsers, file));
  }
  const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint);
  console.log(`bundled ${Object.keys(result.metafile.inputs).length} modules into dist/extension.js (${Math.round(output.bytes / 1024)} KB${production ? ', minified' : ''}) in ${Date.now() - started} ms`);
}

module.exports = { bundle };
if (require.main === module) {
  bundle().catch(() => process.exit(1));
}
