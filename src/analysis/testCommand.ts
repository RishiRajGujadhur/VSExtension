import * as fs from 'fs';
import * as path from 'path';
import { Framework } from './types';

export type RunnableFramework = Exclude<Framework, 'unknown'>;

/** How to run a package's binaries: pnpm exec, yarn or bunx when the project uses them, else npx. */
export function packageRunner(cwd: string): { command: string; prefix: string[] } {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return { command: 'pnpm', prefix: ['exec'] };
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return { command: 'yarn', prefix: [] };
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return { command: 'bunx', prefix: [] };
    if (fs.existsSync(path.join(dir, 'package-lock.json')) || path.dirname(dir) === dir) return { command: 'npx', prefix: [] };
  }
}

/** The command line that runs test files through their framework, keeping only tests whose titles match `pattern`. */
export function testCommand(framework: RunnableFramework, files: readonly string[], pattern: string | undefined, cwd: string): { command: string; args: string[] } {
  const exec = packageRunner(cwd);
  const run = (...args: string[]) => ({ command: exec.command, args: [...exec.prefix, ...args] });
  switch (framework) {
    case 'cypress':
      return run('cypress', 'run', '--spec', files.join(','));
    case 'deno':
      return { command: 'deno', args: ['test', '--allow-all', ...files, ...(pattern ? ['--filter', `/${pattern}/`] : [])] };
    case 'tape':
      return run(fs.existsSync(path.join(cwd, 'node_modules', 'tap')) ? 'tap' : 'tape', ...files);
    case 'ava':
      return run('ava', ...files);
    case 'bun':
      return { command: 'bun', args: ['test', ...files, ...(pattern ? ['-t', pattern] : [])] };
    case 'vitest':
      return run('vitest', 'run', ...files, ...(pattern ? ['-t', pattern] : []));
    case 'jest':
      return run('jest', '--runTestsByPath', ...files, ...(pattern ? ['-t', pattern] : []));
    case 'playwright':
      return run('playwright', 'test', ...files, ...(pattern ? ['-g', pattern] : []));
    case 'mocha':
      return run('mocha', ...files, ...(pattern ? ['-g', pattern] : []));
    case 'node':
      return { command: 'node', args: ['--test', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files] };
  }
}

/** The test framework a package uses, from its dependencies. */
export function detectFramework(packageDir: string | undefined): RunnableFramework | undefined {
  if (!packageDir) {
    return undefined;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return 'vitest';
    if (deps.jest || deps['ts-jest']) return 'jest';
    if (deps['@playwright/test']) return 'playwright';
    if (deps.mocha) return 'mocha';
    if (deps.cypress) return 'cypress';
    if (deps.tape || deps.tap) return 'tape';
    if (deps.ava) return 'ava';
    if (deps['@types/bun'] || deps['bun-types']) return 'bun';
  } catch {
    // Unreadable package.json: fall through.
  }
  // A config file says it too, such as vitest.config.ts in a package that gets vitest from the workspace root.
  const configs: [RegExp, RunnableFramework][] = [[/^vitest\.config\./, 'vitest'], [/^jest\.config\./, 'jest'], [/^playwright\.config\./, 'playwright'], [/^\.mocharc/, 'mocha']];
  try {
    const names = fs.readdirSync(packageDir);
    return configs.find(([pattern]) => names.some((n) => pattern.test(n)))?.[1];
  } catch {
    return undefined;
  }
}
