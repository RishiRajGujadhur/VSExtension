import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Framework, TestCase } from './analysis/types';
import { detectFramework, testCommand } from './analysis/testCommand';

interface RunGroup {
  framework: Exclude<Framework, 'unknown'>;
  cwd: string;
  files: Set<string>;
  /** Title patterns; null when some test in the group cannot be filtered by name. */
  patterns: Set<string> | null;
}

/** Runs the given tests through their framework's name filter in a VS Code task. Only called on explicit user action. */
export async function runTests(tests: TestCase[]): Promise<void> {
  const groups = new Map<string, RunGroup>();
  const unknown: string[] = [];
  for (const test of tests) {
    const packageDir = findPackageDir(test.file);
    const framework = test.framework !== 'unknown' ? test.framework : detectFramework(packageDir);
    if (!framework) {
      unknown.push(path.basename(test.file));
      continue;
    }
    const cwd = packageDir ?? path.dirname(test.file);
    const key = `${framework}|${cwd}`;
    let group = groups.get(key);
    if (!group) {
      group = { framework, cwd, files: new Set(), patterns: new Set() };
      groups.set(key, group);
    }
    group.files.add(test.file);
    if (test.isFileEntry || !group.patterns) {
      group.patterns = null;
    } else {
      group.patterns.add(titlePattern(test));
    }
  }

  if (unknown.length > 0) {
    void vscode.window.showWarningMessage(
      `Could not determine the test framework for ${unknown.join(', ')}. Add one of vitest, jest, mocha, @playwright/test, ava, tape, jasmine or cypress to package.json, or use bun:test, Deno.test or node:test.`,
    );
  }
  for (const group of groups.values()) {
    await vscode.tasks.executeTask(createTask(group));
  }
}

function createTask(group: RunGroup): vscode.Task {
  const files = [...group.files].map((f) => path.relative(group.cwd, f).replace(/\\/g, '/'));
  const pattern = group.patterns && group.patterns.size > 0 ? [...group.patterns].join('|') : undefined;
  const { command, args } = testCommand(group.framework, files, pattern, group.cwd);
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(group.cwd)) ?? vscode.TaskScope.Workspace;
  const quoted = args.map((value) => ({ value, quoting: vscode.ShellQuoting.Strong }));
  const task = new vscode.Task(
    { type: 'tsImpact', framework: group.framework },
    folder,
    `Impacted tests (${group.framework}, ${files.length} file${files.length === 1 ? '' : 's'})`,
    'Test Impact',
    new vscode.ShellExecution(command, quoted, { cwd: group.cwd }),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  return task;
}

/** A regular expression matching the test's own title; parameterized placeholders match anything. */
function titlePattern(test: TestCase): string {
  const escaped = test.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return test.parameterized ? escaped.replace(/%[sdifjoOpc#]|\\\$[\w.]+/g, '.*') : escaped;
}

function findPackageDir(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

