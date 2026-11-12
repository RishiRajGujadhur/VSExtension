import { ImpactedTest, ImpactResult } from '../analysis/types';
import { plural } from './report';

/**
 * How the Affected tests view and its status bar item present a result: busiest and surest files first, tests in
 * line order with the confirmed ones first, counts per file, how far each test is from the change, and plain
 * words when no test reaches the code.
 */

const confirmedFirst = (a: ImpactedTest, b: ImpactedTest) => Number(a.confidence !== 'confirmed') - Number(b.confidence !== 'confirmed');

/** Tests grouped by file: files with the most confirmed tests first, then the most tests; within a file, confirmed first, then by line. */
export function groupByFile(tests: readonly ImpactedTest[]): { file: string; tests: ImpactedTest[] }[] {
  const byFile = new Map<string, ImpactedTest[]>();
  const seen = new Set<string>();
  for (const t of tests) {
    // The same test reached two ways is listed once, the surer way.
    const key = `${t.test.file}:${t.test.location.line}:${t.test.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byFile.set(t.test.file, [...(byFile.get(t.test.file) ?? []), t]);
  }
  const confirmed = (list: ImpactedTest[]) => list.filter((t) => t.confidence === 'confirmed').length;
  return [...byFile]
    .map(([file, list]) => ({ file, tests: list.sort((a, b) => confirmedFirst(a, b) || a.test.location.line - b.test.location.line) }))
    .sort((a, b) => confirmed(b.tests) - confirmed(a.tests) || b.tests.length - a.tests.length || a.file.localeCompare(b.file));
}

/** A file row's counts: "3 tests · 1 possible". */
export function fileCounts(tests: readonly ImpactedTest[]): string {
  const possible = tests.filter((t) => t.confidence !== 'confirmed').length;
  return [plural(tests.length, 'test'), possible ? `${possible} possible` : ''].filter(Boolean).join(' · ');
}

/** How far the test is from the change: the calls in between. */
export function distance(impacted: ImpactedTest): string {
  const between = Math.max(0, impacted.path.length - 2);
  return between === 0 ? 'calls it directly' : `${plural(between, 'step')} away`;
}

/** The status bar text and tooltip for a result. */
export function statusOf(result: ImpactResult): { text: string; tooltip: string } {
  const possible = result.tests.filter((t) => t.confidence !== 'confirmed').length;
  const files = new Set(result.tests.map((t) => t.test.file)).size;
  return {
    text: `$(beaker) ${plural(result.tests.length, 'test')}${possible ? ` (${possible} possible)` : ''}`,
    tooltip: result.tests.length
      ? `${plural(result.tests.length, 'test')} in ${plural(files, 'file')} reach ${result.target.name}${possible ? `; ${possible} only possibly` : ''}. Click to see or run them.`
      : `No test reaches ${result.target.name}. Click for details.`,
  };
}

/** The view's message: the warnings, or what an empty result means. */
export function viewMessage(result: ImpactResult): string | undefined {
  if (result.warnings.length) return result.warnings.join(' ');
  if (!result.tests.length) return `No test reaches ${result.target.name}: it may be untested, or tested only through code outside the ${plural(result.testFilesScanned, 'test file')} checked.`;
  return undefined;
}
