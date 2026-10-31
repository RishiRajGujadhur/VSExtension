import * as path from 'path';
import * as ts from 'typescript';
import { Framework, TestCase } from './types';
import { normalizePath } from './paths';

type Role = 'test' | 'suite' | 'hook';

export interface DiscoveredTestFile {
  fileName: string;
  isTestFile: boolean;
  framework: Framework;
  cases: TestCase[];
  /** Test and hook callbacks, so a reference can be attributed by walking up its ancestors. */
  callbacks: Map<ts.Node, { role: 'test'; test: TestCase } | { role: 'hook' }>;
  /** Stand-in used when the file has no static registrations. */
  fileEntry: TestCase;
}

const testModules: Record<string, Framework> = {
  vitest: 'vitest',
  '@jest/globals': 'jest',
  '@playwright/test': 'playwright',
  mocha: 'mocha',
  'node:test': 'node',
};

const roles: Record<string, Role> = {
  test: 'test',
  it: 'test',
  specify: 'test',
  fit: 'test',
  xit: 'test',
  xtest: 'test',
  describe: 'suite',
  suite: 'suite',
  context: 'suite',
  fdescribe: 'suite',
  xdescribe: 'suite',
  beforeEach: 'hook',
  afterEach: 'hook',
  beforeAll: 'hook',
  afterAll: 'hook',
  before: 'hook',
  after: 'hook',
  setup: 'hook',
  teardown: 'hook',
  suiteSetup: 'hook',
  suiteTeardown: 'hook',
};

/** Property names that keep the meaning of the registration they are chained onto. */
const modifiers = new Set([
  'only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'failing', 'fixme', 'slow',
  'serial', 'parallel', 'shuffle', 'each', 'for', 'skipIf', 'runIf', 'if',
]);

const testPathPattern = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:\/(?:test|tests|__tests__)\/)/i;

const cache = new WeakMap<ts.SourceFile, DiscoveredTestFile>();

/** Syntactic only, so results are cached per parsed source file and survive program rebuilds. */
export function discoverTests(sourceFile: ts.SourceFile): DiscoveredTestFile {
  let discovered = cache.get(sourceFile);
  if (!discovered) {
    discovered = new Discovery(sourceFile).run();
    cache.set(sourceFile, discovered);
  }
  return discovered;
}

class Discovery {
  private readonly fileName: string;
  /** Local name to canonical registration name, from imports of known test modules. */
  private readonly imported = new Map<string, string>();
  /** Namespace and default imports whose properties are registrations, e.g. `vt.test`. */
  private readonly namespaces = new Set<string>();
  private framework: Framework = 'unknown';
  private importsTestModule = false;
  private readonly cases: TestCase[] = [];
  private readonly callbacks: DiscoveredTestFile['callbacks'] = new Map();

  constructor(private readonly sourceFile: ts.SourceFile) {
    this.fileName = normalizePath(sourceFile.fileName);
  }

  run(): DiscoveredTestFile {
    this.collectImports();
    const isTestFile = testPathPattern.test(this.fileName) || this.importsTestModule;
    if (isTestFile) {
      this.visit(this.sourceFile, []);
    }
    return {
      fileName: this.fileName,
      isTestFile,
      framework: this.framework,
      cases: this.cases,
      callbacks: this.callbacks,
      fileEntry: {
        id: `${this.fileName}#file`,
        file: this.fileName,
        titlePath: [path.basename(this.fileName)],
        title: path.basename(this.fileName),
        dynamic: true,
        parameterized: false,
        isFileEntry: true,
        framework: this.framework,
        location: { file: this.fileName, line: 0, character: 0 },
      },
    };
  }

  private collectImports(): void {
    for (const statement of this.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const framework = testModules[statement.moduleSpecifier.text];
      if (!framework) {
        continue;
      }
      this.importsTestModule = true;
      this.framework = framework;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) {
        continue;
      }
      if (clause.name) {
        // node:test and mocha export the test function as the default.
        this.imported.set(clause.name.text, framework === 'node' ? 'test' : clause.name.text);
        this.namespaces.add(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        this.namespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (roles[exported]) {
            this.imported.set(element.name.text, exported);
          }
        }
      }
    }
    // Playwright fixtures: `const test = base.extend({...})`.
    for (const statement of this.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          init &&
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === 'extend' &&
          ts.isIdentifier(init.expression.expression) &&
          this.canonical(init.expression.expression.text) === 'test'
        ) {
          this.imported.set(declaration.name.text, 'test');
        }
      }
    }
  }

  /** Canonical registration name for a root identifier, or undefined if it is not one. */
  private canonical(name: string): string | undefined {
    // Unimported names are treated as framework globals (Jest, Mocha, Vitest with globals: true).
    return this.imported.get(name) ?? (roles[name] ? name : undefined);
  }

  private classify(callee: ts.Expression): { role: Role; parameterized: boolean } | undefined {
    let parameterized = false;
    let expr = callee;
    // `test.each(table)(title, fn)`, `test.skipIf(cond)(...)` and `test.each\`...\`(...)`
    if (ts.isCallExpression(expr)) {
      parameterized = isParameterizing(expr.expression);
      expr = expr.expression;
    } else if (ts.isTaggedTemplateExpression(expr)) {
      parameterized = isParameterizing(expr.tag);
      expr = expr.tag;
    }
    const chain: string[] = [];
    while (ts.isPropertyAccessExpression(expr)) {
      chain.unshift(expr.name.text);
      expr = expr.expression;
    }
    if (!ts.isIdentifier(expr)) {
      return undefined;
    }
    let base: string | undefined;
    let rest = chain;
    if (this.namespaces.has(expr.text) && chain.length > 0 && roles[chain[0]] && !this.imported.has(expr.text)) {
      base = chain[0];
      rest = chain.slice(1);
    } else {
      base = this.canonical(expr.text);
    }
    if (!base) {
      return undefined;
    }
    let role = roles[base];
    for (const name of rest) {
      if (roles[name] && role === 'test') {
        // Playwright: test.describe, test.beforeEach
        role = roles[name];
      } else if (!modifiers.has(name)) {
        return undefined;
      }
      if (name === 'each' || name === 'for') {
        parameterized = true;
      }
    }
    return { role, parameterized };
  }

  private visit(node: ts.Node, suites: string[]): void {
    if (ts.isCallExpression(node)) {
      const kind = this.classify(node.expression);
      if (kind) {
        this.register(node, kind.role, kind.parameterized, suites);
        return;
      }
    }
    ts.forEachChild(node, (child) => this.visit(child, suites));
  }

  private register(call: ts.CallExpression, role: Role, parameterized: boolean, suites: string[]): void {
    const callback = [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    const otherArgs = call.arguments.filter((a) => a !== callback);
    const visitArgs = (inner: string[]) => otherArgs.forEach((a) => this.visit(a, inner));

    if (role === 'hook') {
      if (callback) {
        this.callbacks.set(callback, { role: 'hook' });
        this.visit(callback, suites);
      }
      visitArgs(suites);
      return;
    }

    const title = readTitle(call.arguments[0] === callback ? undefined : call.arguments[0], parameterized);
    if (role === 'suite') {
      const inner = [...suites, title.text];
      if (callback) {
        this.visit(callback, inner);
      }
      visitArgs(suites);
      return;
    }

    const start = this.sourceFile.getLineAndCharacterOfPosition(call.getStart(this.sourceFile));
    const test: TestCase = {
      id: `${this.fileName}#${call.getStart(this.sourceFile)}`,
      file: this.fileName,
      titlePath: [...suites, title.text],
      title: title.text,
      dynamic: title.dynamic,
      parameterized,
      isFileEntry: false,
      framework: this.framework,
      location: { file: this.fileName, ...start },
    };
    this.cases.push(test);
    if (callback) {
      this.callbacks.set(callback, { role: 'test', test });
    }
    visitArgs(suites);
  }
}

function isParameterizing(expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && (expr.name.text === 'each' || expr.name.text === 'for');
}

function readTitle(arg: ts.Expression | undefined, parameterized: boolean): { text: string; dynamic: boolean } {
  if (!arg) {
    return { text: '<untitled>', dynamic: true };
  }
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    // Parameterized titles may contain printf-style or $name placeholders.
    const dynamic = parameterized && /%[sdifjoOpc#%]|\$[\w.]+/.test(arg.text);
    return { text: arg.text, dynamic };
  }
  // Template expressions, identifiers (Vitest accepts a function or class as the name) and other expressions.
  return { text: arg.getText(), dynamic: true };
}
