import { SourceLocation } from '../analysis/types';

/** A whole-file change. `before` is undefined for a created file and `after` for a deleted one. */
export interface FileChange {
  file: string;
  before: string | undefined;
  after: string | undefined;
}

/** Something that may make the refactoring unsafe; shown to the user before applying. */
export interface Conflict {
  message: string;
  location?: SourceLocation;
}

export interface RefactorResult {
  label: string;
  changes: FileChange[];
  conflicts: Conflict[];
}

export class RefactorError extends Error {}
