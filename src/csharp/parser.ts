import * as fs from 'fs';
import * as path from 'path';
import { Language, Parser, Tree } from 'web-tree-sitter';

/**
 * The bundled C# parser: tree-sitter's C# grammar, run as WebAssembly, so C# works with nothing else installed. It
 * gives syntax only (no types): enough for flowcharts and syntax-based inspections. Loaded once, on first use.
 *
 * The .wasm files sit in dist/parsers in the packaged extension (scripts/bundle.js copies them there) and come from
 * node_modules when running from out/ (the tests).
 */

const candidates = (file: string, packageDir: string) => [
  path.join(__dirname, 'parsers', file),
  path.join(__dirname, '..', 'dist', 'parsers', file),
  path.join(__dirname, '..', '..', 'node_modules', packageDir, file),
  path.join(__dirname, '..', 'node_modules', packageDir, file),
];

function locate(file: string, packageDir: string): string {
  const found = candidates(file, packageDir).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`The C# parser is missing (${file}). Reinstall Code X-Ray.`);
  return found;
}

let loading: Promise<Parser> | undefined;

/** The C# parser, ready to use. */
export function csharpParser(): Promise<Parser> {
  loading ??= (async () => {
    const runtime = locate('tree-sitter.wasm', 'web-tree-sitter');
    await Parser.init({ locateFile: () => runtime });
    const language = await Language.load(locate('tree-sitter-c_sharp.wasm', 'tree-sitter-c-sharp'));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return loading;
}

/** The syntax tree of C# code. */
export async function parseCSharp(code: string): Promise<Tree> {
  const tree = (await csharpParser()).parse(code);
  if (!tree) throw new Error('The C# parser could not read this file.');
  return tree;
}
