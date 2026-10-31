import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectService } from '../analysis/project';
import { pathKey } from '../analysis/paths';
import { RefactorResult } from '../refactor/types';
import { VirtualProject } from '../refactor/virtualProject';

export const fixtures = path.resolve(__dirname, '../../test-fixtures');

/** A fresh in-memory copy of a fixture project; tests never write to disk. */
export function virtualProject(fixture: string, file = 'src/math.ts'): VirtualProject {
  return new ProjectService().createVirtualProject(path.join(fixtures, fixture, file));
}

/** Offset of `marker` in the file, at the `|` inside it if present. */
export function offsetIn(fileName: string, marker: string): number {
  const text = fs.readFileSync(fileName, 'utf8');
  const cursor = marker.indexOf('|');
  const needle = marker.replace('|', '');
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `marker not found in ${path.basename(fileName)}: ${needle}`);
  return at + Math.max(cursor, 0);
}

export function changedText(result: RefactorResult, fileName: string): string {
  const change = result.changes.find((c) => pathKey(c.file) === pathKey(fileName));
  assert.ok(change, `${path.basename(fileName)} was not changed`);
  return change.after ?? '';
}
