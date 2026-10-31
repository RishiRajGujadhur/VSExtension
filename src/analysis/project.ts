import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { AnalysisError } from './types';
import { normalizePath, pathKey } from './paths';
import { ReferenceIndex } from './referenceIndex';
import { VirtualProject } from '../refactor/virtualProject';

/** Returns the unsaved text of an open editor, or undefined to read from disk. */
export type OverlayProvider = (fileName: string) => string | undefined;

export interface LoadedProject {
  configPath?: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Built on first use and kept while the program is unchanged. */
  index?: ReferenceIndex;
}

interface CachedSourceFile {
  text: string;
  languageKey: string;
  sourceFile: ts.SourceFile;
}

const inferredExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const inferredExcludes = ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/coverage/**', '**/.git/**'];
const maxInferredFiles = 5000;

/**
 * Loads compiler projects for files and caches them. Parsed source files are reused across
 * programs while their text is unchanged, and a program whose files are all unchanged is
 * reused whole, together with its reference index.
 */
export class ProjectService {
  private readonly sourceFiles = new Map<string, CachedSourceFile>();
  private readonly projects = new Map<string, LoadedProject>();

  constructor(private readonly overlay: OverlayProvider = () => undefined) {}

  load(fileName: string, fallbackRoot?: string): LoadedProject {
    const file = normalizePath(fileName);
    const { configPath, parsed } = this.resolve(file, fallbackRoot);
    const cacheKey = configPath ? pathKey(configPath) : `inferred:${pathKey(fallbackRoot ?? path.dirname(file))}`;
    const previous = this.projects.get(cacheKey);
    const host = this.createHost(parsed.options);
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      host,
      oldProgram: previous?.program,
    });

    if (previous && sameSourceFiles(previous.program, program)) {
      return previous;
    }
    const project: LoadedProject = { configPath, program, checker: program.getTypeChecker() };
    this.projects.set(cacheKey, project);
    return project;
  }

  /** The compiler configuration that includes the file, or an inferred one when no config exists. */
  resolve(fileName: string, fallbackRoot?: string): { configPath?: string; parsed: ts.ParsedCommandLine } {
    const file = normalizePath(fileName);
    return this.findConfig(file) ?? { parsed: this.inferProject(file, fallbackRoot ?? path.dirname(file)) };
  }

  /** An editable in-memory copy of the file's project, for computing refactorings. */
  createVirtualProject(fileName: string, fallbackRoot?: string): VirtualProject {
    const { configPath, parsed } = this.resolve(fileName, fallbackRoot);
    return new VirtualProject(parsed, this.overlay, configPath);
  }

  /** Drops cached programs, for example after a configuration file changes. */
  invalidate(): void {
    this.projects.clear();
  }

  private createHost(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options, true);
    const readFile = (fileName: string) => this.overlay(fileName) ?? ts.sys.readFile(fileName);
    host.readFile = readFile;
    host.getSourceFile = (fileName, languageVersion) => {
      const text = readFile(fileName);
      if (text === undefined) {
        return undefined;
      }
      const key = pathKey(fileName);
      const languageKey = JSON.stringify(languageVersion);
      const cached = this.sourceFiles.get(key);
      if (cached && cached.text === text && cached.languageKey === languageKey) {
        return cached.sourceFile;
      }
      const sourceFile = ts.createSourceFile(fileName, text, languageVersion, true);
      this.sourceFiles.set(key, { text, languageKey, sourceFile });
      return sourceFile;
    };
    return host;
  }

  /**
   * Walks up from the file, checking tsconfig.json, jsconfig.json, tsconfig.*.json and their
   * project references, and returns the first configuration whose file list includes the file.
   */
  private findConfig(file: string): { configPath: string; parsed: ts.ParsedCommandLine } | undefined {
    const target = pathKey(file);
    const rejected: string[] = [];
    let dir = path.dirname(file);
    for (;;) {
      for (const candidate of configCandidates(dir)) {
        const found = this.searchConfig(candidate, target, new Set(), rejected);
        if (found) {
          return found;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (rejected.length > 0) {
      throw new AnalysisError(
        `${path.basename(file)} is not included by ${rejected.map((c) => path.basename(c)).join(', ')}. ` +
          'Keep source and tests in the same compiler project. If the application config excludes tests, ' +
          'open a test file under a config that includes them and select the imported symbol there.',
      );
    }
    return undefined;
  }

  private searchConfig(
    configPath: string,
    target: string,
    seen: Set<string>,
    rejected: string[],
  ): { configPath: string; parsed: ts.ParsedCommandLine } | undefined {
    const key = pathKey(configPath);
    if (seen.has(key) || seen.size > 50) {
      return undefined;
    }
    seen.add(key);
    const parsed = parseConfig(configPath);
    if (!parsed) {
      return undefined;
    }
    if (parsed.fileNames.some((f) => pathKey(f) === target)) {
      return { configPath: normalizePath(configPath), parsed };
    }
    for (const reference of parsed.projectReferences ?? []) {
      const referencePath = ts.resolveProjectReferencePath(reference);
      const found = this.searchConfig(referencePath, target, seen, rejected);
      if (found) {
        return found;
      }
    }
    rejected.push(configPath);
    return undefined;
  }

  private inferProject(file: string, root: string): ts.ParsedCommandLine {
    const fileNames = ts.sys
      .readDirectory(root, inferredExtensions, inferredExcludes, ['**/*'])
      .filter((f) => !/\.d\.[cm]?ts$/i.test(f))
      .slice(0, maxInferredFiles);
    if (!fileNames.some((f) => pathKey(f) === pathKey(file))) {
      fileNames.push(file);
    }
    return {
      options: {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      fileNames,
      errors: [],
    };
  }
}

function configCandidates(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rank = (name: string) => (name === 'tsconfig.json' ? 0 : name === 'jsconfig.json' ? 1 : 2);
  return entries
    .filter((name) => name === 'jsconfig.json' || /^tsconfig(\..+)?\.json$/i.test(name))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

function parseConfig(configPath: string): ts.ParsedCommandLine | undefined {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) {
    return undefined;
  }
  const isJsConfig = path.basename(configPath).toLowerCase() === 'jsconfig.json';
  const existing: ts.CompilerOptions = isJsConfig ? { allowJs: true, maxNodeModuleJsDepth: 2, skipLibCheck: true } : {};
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), existing, configPath);
}

function sameSourceFiles(a: ts.Program, b: ts.Program): boolean {
  const left = a.getSourceFiles();
  const right = b.getSourceFiles();
  return left.length === right.length && left.every((sf, i) => sf === right[i]);
}
