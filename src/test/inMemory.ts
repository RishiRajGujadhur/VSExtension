import ts = require('typescript');

const libs = new Map<string, ts.SourceFile | undefined>();
const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, types: [] };

/** A one-file program with the standard library (including the DOM), for tests of analyses that need types. */
export function compile(code: string): { program: ts.Program; sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = '/test.ts';
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => {
    if (name === fileName) return ts.createSourceFile(name, code, ts.ScriptTarget.ES2022, true);
    if (!libs.has(name)) libs.set(name, read(name, version));
    return libs.get(name);
  };
  const exists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || exists(name);
  const program = ts.createProgram([fileName], options, host);
  return { program, sourceFile: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

/** The function declaration with the name. */
export function functionNamed(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  return sourceFile.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)!;
}
