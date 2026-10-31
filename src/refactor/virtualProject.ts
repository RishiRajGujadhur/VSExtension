import * as path from 'path';
import * as ts from 'typescript';
import { normalizePath, pathKey } from '../analysis/paths';
import { SourceLocation } from '../analysis/types';
import { FileChange } from './types';

/** Shared across language services so unchanged files are parsed once. */
const documentRegistry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);

interface VirtualFile {
  fileName: string;
  original: string | undefined;
  text: string | undefined;
  version: number;
}

export const formatOptions: ts.FormatCodeSettings = {
  ...ts.getDefaultFormatCodeSettings('\n'),
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
};

export const preferences: ts.UserPreferences = {
  quotePreference: 'auto',
  importModuleSpecifierPreference: 'relative',
  allowTextChangesInNewFiles: true,
  providePrefixAndSuffixTextForRename: true,
};

/**
 * An in-memory, editable copy of a compiler project backed by a TypeScript language service.
 * Refactorings edit it step by step; `changes()` reports the net result against the originals.
 */
export class VirtualProject {
  readonly service: ts.LanguageService;
  private readonly files = new Map<string, VirtualFile>();
  private readonly roots: string[];

  constructor(
    private readonly parsed: ts.ParsedCommandLine,
    private readonly overlay: (fileName: string) => string | undefined,
    readonly configPath?: string,
  ) {
    this.roots = parsed.fileNames.map(normalizePath);
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsed.options,
      getProjectReferences: () => parsed.projectReferences,
      getScriptFileNames: () => this.scriptFileNames(),
      getScriptVersion: (fileName) => String(this.entry(fileName).version),
      getScriptSnapshot: (fileName) => {
        const text = this.text(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => (configPath ? path.dirname(configPath) : process.cwd()),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => this.text(fileName) !== undefined,
      readFile: (fileName) => this.text(fileName),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(host, documentRegistry);
  }

  program(): ts.Program {
    return this.service.getProgram()!;
  }

  sourceFile(fileName: string): ts.SourceFile {
    const sourceFile = this.program().getSourceFile(normalizePath(fileName));
    if (!sourceFile) {
      throw new Error(`${path.basename(fileName)} is not part of the compiler project.`);
    }
    return sourceFile;
  }

  text(fileName: string): string | undefined {
    return this.entry(fileName).text;
  }

  setText(fileName: string, text: string | undefined): void {
    const file = this.entry(fileName);
    if (file.text !== text) {
      file.text = text;
      file.version++;
    }
  }

  /** Applies language-service edits, creating files as needed. */
  applyTextChanges(changes: readonly ts.FileTextChanges[]): void {
    for (const change of changes) {
      const current = this.text(change.fileName) ?? '';
      const ordered = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
      let text = current;
      for (const edit of ordered) {
        text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
      }
      this.setText(change.fileName, text);
    }
  }

  /** Net changes against the text each file had when first read. */
  changes(): FileChange[] {
    const result: FileChange[] = [];
    for (const file of this.files.values()) {
      if (file.original !== file.text) {
        result.push({ file: file.fileName, before: file.original, after: file.text });
      }
    }
    return result;
  }

  locationOf(node: ts.Node): SourceLocation {
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { file: normalizePath(sourceFile.fileName), ...position };
  }

  private scriptFileNames(): string[] {
    const names = new Set(this.roots);
    for (const file of this.files.values()) {
      if (file.text !== undefined && file.original === undefined) {
        names.add(file.fileName);
      }
    }
    return [...names].filter((name) => this.text(name) !== undefined);
  }

  private entry(fileName: string): VirtualFile {
    const key = pathKey(fileName);
    let file = this.files.get(key);
    if (!file) {
      const normalized = normalizePath(fileName);
      const text = this.overlay(normalized) ?? ts.sys.readFile(normalized);
      file = { fileName: normalized, original: text, text, version: 0 };
      this.files.set(key, file);
    }
    return file;
  }
}
