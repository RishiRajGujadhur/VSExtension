import * as path from 'path';
import * as ts from 'typescript';
import { createHash } from 'crypto';

/** Absolute path with forward slashes, the form the TypeScript API uses. */
export function normalizePath(fileName: string): string {
  return path.resolve(fileName).replace(/\\/g, '/');
}

/** Comparison key that respects the host file system's case sensitivity. */
export function pathKey(fileName: string): string {
  const normalized = normalizePath(fileName);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/i;

export function isSourceFileName(fileName: string): boolean {
  return sourceExtensions.test(fileName) && !/\.d\.[cm]?ts$/i.test(fileName);
}
