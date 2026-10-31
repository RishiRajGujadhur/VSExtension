export type Framework = 'vitest' | 'jest' | 'mocha' | 'playwright' | 'node' | 'unknown';

/** confirmed: a resolved chain of references reaches the test body. possible: the chain relies on a conservative assumption. */
export type Confidence = 'confirmed' | 'possible';

export type AnalysisScope = 'symbol' | 'module';

/** Zero-based position, matching both the TypeScript API and VS Code. */
export interface SourceLocation {
  file: string;
  line: number;
  character: number;
}

export interface TestCase {
  /** Stable within one analysis: file plus registration offset. */
  id: string;
  file: string;
  /** Suite titles followed by the test title. */
  titlePath: string[];
  title: string;
  /** The title is not a plain literal, so it cannot be used as an exact run filter. */
  dynamic: boolean;
  /** Registered through .each/.for; listed once. */
  parameterized: boolean;
  /** A stand-in for a test file in which no static registrations were found. */
  isFileEntry: boolean;
  framework: Framework;
  location: SourceLocation;
}

export interface PathStep {
  name: string;
  kind: string;
  location: SourceLocation;
  /** Where this step references the previous one. */
  via?: SourceLocation;
  note?: string;
}

export interface ImpactedTest {
  test: TestCase;
  confidence: Confidence;
  /** From the selected symbol to the test, inclusive. */
  path: PathStep[];
  reason: string;
}

export interface ImpactTarget {
  name: string;
  kind: string;
  location: SourceLocation;
}

export interface ImpactResult {
  scope: AnalysisScope;
  target: ImpactTarget;
  configPath?: string;
  tests: ImpactedTest[];
  /** Content hash of every file a result points into, used to reject stale navigation. */
  fileHashes: Record<string, string>;
  filesScanned: number;
  testFilesScanned: number;
  durationMs: number;
  warnings: string[];
}

export class AnalysisError extends Error {}
