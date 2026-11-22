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
  await bundleKitten();
  const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint && o.entryPoint.endsWith('boot.ts'));
  console.log(`bundled ${Object.keys(result.metafile.inputs).length} modules into dist/extension.js (${Math.round(output.bytes / 1024)} KB${production ? ', minified' : ''}) in ${Date.now() - started} ms`);
}

/**
 * The natural voices' engine, in dist/kitten: the one ONNX Runtime Web build it runs on (WebAssembly, one thread), the
 * worker (dist/kittenWorker.js), and the eSpeak NG phonemizer, which runs as its own GPL program (media/kitten) with
 * its license and notice. No voice model: you choose one, and it is downloaded on first use (src/reel/voiceModels.ts).
 */
async function bundleKitten() {
  const home = path.join(root, 'dist', 'kitten');
  fs.rmSync(home, { recursive: true, force: true });
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  const ort = path.join(root, 'node_modules', 'onnxruntime-web');
  for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copy(path.join(ort, 'dist', file), path.join(home, 'ort', file));
  // The npm package has no license file; its license is MIT (Microsoft), shipped from media/kitten.
  copy(path.join(root, 'media', 'kitten', 'ONNXRUNTIME-LICENSE.txt'), path.join(home, 'ort', 'LICENSE'));
  const phonemizer = path.join(root, 'node_modules', 'phonemizer');
  copy(path.join(phonemizer, 'dist', 'phonemizer.js'), path.join(home, 'phonemizer', 'phonemizer.js'));
  copy(path.join(phonemizer, 'LICENSE'), path.join(home, 'phonemizer', 'LICENSE'));
  // An ES module: the folder says so, as the package did.
  fs.writeFileSync(path.join(home, 'phonemizer', 'package.json'), '{ "type": "module" }\n');
  for (const file of ['phonemize.mjs', 'GPL-3.0.txt', 'ESPEAK-NG-NOTICE.md']) copy(path.join(root, 'media', 'kitten', file), path.join(home, file));
  // The voices' worker, and the code model's (the model itself is downloaded on use; it runs on the same runtime).
  for (const name of ['kittenWorker', 'codeModelWorker']) {
    await esbuild.build({
      entryPoints: [path.join(root, 'src', 'reel', `${name}.ts`)],
      outfile: path.join(root, 'dist', `${name}.js`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      minify: production,
      logLevel: 'warning',
    });
  }
}

module.exports = { bundle };
if (require.main === module) {
  bundle().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
