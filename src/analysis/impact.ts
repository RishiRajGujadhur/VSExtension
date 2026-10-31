import * as path from 'path';
import * as ts from 'typescript';
import { AnalysisError, AnalysisScope, Confidence, ImpactedTest, ImpactResult, ImpactTarget, PathStep, SourceLocation, TestCase } from './types';
import { LoadedProject } from './project';
import { ReferenceIndex, projectSourceFiles, resolveAlias } from './referenceIndex';
import { DiscoveredTestFile, discoverTests } from './testDiscovery';
import { hashText, pathKey } from './paths';

export interface ImpactOptions {
  maxDepth?: number;
  /** Follow class members through the interfaces and base classes they implement or override. */
  includeInheritedMembers?: boolean;
}

export interface ImpactRequest {
  fileName: string;
  /** Zero-based offset in the file's current text. */
  offset: number;
  scope: AnalysisScope;
}

/** What a reference site means for impact. */
type Attribution =
  | { kind: 'test'; test: TestCase }
  | { kind: 'testFile'; file: DiscoveredTestFile; note: string }
  | { kind: 'declaration'; declaration: ts.Node };

interface QueueItem {
  declaration: ts.Node;
  path: PathStep[];
  confidence: Confidence;
}

export function analyzeImpact(project: LoadedProject, request: ImpactRequest, options: ImpactOptions = {}): ImpactResult {
  const started = Date.now();
  const { program, checker } = project;
  const sourceFile = program.getSourceFiles().find((sf) => pathKey(sf.fileName) === pathKey(request.fileName));
  if (!sourceFile) {
    throw new AnalysisError(`${path.basename(request.fileName)} is not part of the compiler project.`);
  }
  if (!project.index) {
    project.index = new ReferenceIndex(program, checker);
  }
  const tracer = new Tracer(project.index, checker, options);
  const seeds = request.scope === 'module' ? moduleSeeds(sourceFile) : symbolSeeds(checker, sourceFile, request.offset);
  const target =
    request.scope === 'module'
      ? moduleTarget(sourceFile)
      : seeds.declarations.length > 0
        ? describe(seeds.declarations[0])
        : { ...stepForTest(seeds.directTests[0]) };
  tracer.trace(seeds.declarations);
  for (const test of seeds.directTests) {
    tracer.record(test, [stepForTest(test)], 'confirmed', request.scope === 'module' ? 'Defined in the selected module' : 'The cursor is inside this test');
  }

  const tests = tracer.results();
  const testFiles = projectSourceFiles(program).filter((sf) => discoverTests(sf).isTestFile);
  const warnings = [...tracer.warnings];
  if (testFiles.length === 0) {
    warnings.push(
      `No test files were found in ${project.configPath ? path.basename(project.configPath) : 'the inferred project'}. ` +
        'If tests use a separate config, open a test file and select the imported symbol there.',
    );
  }

  const fileHashes: Record<string, string> = {};
  const hashFile = (file: string) => {
    if (!(file in fileHashes)) {
      const sf = program.getSourceFile(file);
      if (sf) {
        fileHashes[file] = hashText(sf.text);
      }
    }
  };
  hashFile(target.location.file);
  for (const impacted of tests) {
    hashFile(impacted.test.file);
    impacted.path.forEach((step) => hashFile(step.location.file));
  }

  return {
    scope: request.scope,
    target,
    configPath: project.configPath,
    tests,
    fileHashes,
    filesScanned: project.index.filesIndexed,
    testFilesScanned: testFiles.length,
    durationMs: Date.now() - started,
    warnings,
  };
}

class Tracer {
  readonly warnings: string[] = [];
  private readonly found = new Map<string, ImpactedTest>();
  private readonly maxDepth: number;
  private readonly includeInherited: boolean;

  constructor(
    private readonly index: ReferenceIndex,
    private readonly checker: ts.TypeChecker,
    options: ImpactOptions,
  ) {
    this.maxDepth = options.maxDepth ?? 25;
    this.includeInherited = options.includeInheritedMembers ?? true;
  }

  /** Breadth-first over callers, so each test keeps its shortest explanation. Visited declarations end cycles. */
  trace(seeds: ts.Node[]): void {
    const visited = new Set<ts.Node>();
    const queue: QueueItem[] = [];
    const enqueue = (item: QueueItem) => {
      if (!visited.has(item.declaration)) {
        visited.add(item.declaration);
        queue.push(item);
      }
    };
    for (const declaration of seeds) {
      enqueue({ declaration, path: [describe(declaration)], confidence: 'confirmed' });
    }

    let truncated = false;
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.path.length > this.maxDepth) {
        truncated = true;
        continue;
      }
      for (const site of this.index.referencesTo(item.declaration)) {
        this.follow(item, site, enqueue);
      }
      if (this.includeInherited) {
        for (const related of this.inheritedMembers(item.declaration)) {
          const step: PathStep = { ...describe(related.declaration), note: related.note };
          enqueue({ declaration: related.declaration, path: [...item.path, step], confidence: 'possible' });
        }
      }
    }
    if (truncated) {
      this.warnings.push(`Some dependency chains were longer than ${this.maxDepth} steps and were not followed further.`);
    }
  }

  private follow(item: QueueItem, site: ts.Node, enqueue: (item: QueueItem) => void): void {
    const via = locationOf(site);
    const attribution = attribute(site);
    switch (attribution.kind) {
      case 'test':
        this.record(attribution.test, [...item.path, { ...stepForTest(attribution.test), via }], item.confidence, 'Referenced in the test body');
        break;
      case 'testFile': {
        const file = attribution.file;
        const tests = file.cases.length > 0 ? file.cases : [file.fileEntry];
        for (const test of tests) {
          this.record(test, [...item.path, { ...stepForTest(test), via, note: attribution.note }], 'possible', attribution.note);
        }
        break;
      }
      case 'declaration': {
        const step: PathStep = { ...describe(attribution.declaration), via };
        // Running a module's top-level code is an assumption about load order, not a resolved call.
        const confidence = ts.isSourceFile(attribution.declaration) ? 'possible' : item.confidence;
        enqueue({ declaration: attribution.declaration, path: [...item.path, step], confidence });
        break;
      }
    }
  }

  record(test: TestCase, steps: PathStep[], confidence: Confidence, reason: string): void {
    const existing = this.found.get(test.id);
    const better =
      !existing ||
      (existing.confidence === 'possible' && confidence === 'confirmed') ||
      (existing.confidence === confidence && steps.length < existing.path.length);
    if (better) {
      this.found.set(test.id, { test, confidence, path: steps, reason });
    }
  }

  results(): ImpactedTest[] {
    return [...this.found.values()].sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1) ||
        a.test.file.localeCompare(b.test.file) ||
        a.test.location.line - b.test.location.line,
    );
  }

  /** Interface and base-class members that a class member implements or overrides. */
  private inheritedMembers(declaration: ts.Node): { declaration: ts.Node; note: string }[] {
    if (
      !(ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) ||
      !ts.isClassLike(declaration.parent) ||
      !declaration.name ||
      ts.isComputedPropertyName(declaration.name)
    ) {
      return [];
    }
    const name = declaration.name.text;
    const related: { declaration: ts.Node; note: string }[] = [];
    for (const clause of declaration.parent.heritageClauses ?? []) {
      for (const heritage of clause.types) {
        const type = this.checker.getTypeAtLocation(heritage);
        const member = type.getProperty(name);
        for (const memberDeclaration of member?.declarations ?? []) {
          if (memberDeclaration !== declaration && !memberDeclaration.getSourceFile().isDeclarationFile) {
            related.push({ declaration: memberDeclaration, note: `Calls through ${heritage.expression.getText()} may dispatch here` });
          }
        }
      }
    }
    return related;
  }
}

/**
 * Walks up from a reference to the code that contains it: a test body, a hook or test-file
 * initialization, or the nearest declaration whose callers must be followed next.
 */
function attribute(site: ts.Node): Attribution {
  const sourceFile = site.getSourceFile();
  const tests = discoverTests(sourceFile);
  let child: ts.Node = site;
  for (let node = site.parent; node; child = node, node = node.parent) {
    const callback = tests.callbacks.get(node);
    if (callback?.role === 'test') {
      return { kind: 'test', test: callback.test };
    }
    if (callback?.role === 'hook') {
      return { kind: 'testFile', file: tests, note: 'Used by a shared hook in this test file' };
    }
    const declaration = containerFor(node, child);
    if (declaration) {
      return { kind: 'declaration', declaration };
    }
    if (ts.isSourceFile(node)) {
      return tests.isTestFile
        ? { kind: 'testFile', file: tests, note: 'Used during test file initialization' }
        : { kind: 'declaration', declaration: node };
    }
  }
  return { kind: 'declaration', declaration: sourceFile };
}

/** The declaration whose callers are affected when `child`, a part of `node`, is affected. */
function containerFor(node: ts.Node, child: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return node;
  }
  if (ts.isConstructorDeclaration(node) || ts.isClassStaticBlockDeclaration(node)) {
    return node.parent;
  }
  if (ts.isPropertyDeclaration(node)) {
    // A function-valued property is called through its own name; other initializers run on construction.
    return node.initializer && isFunctionLike(node.initializer) ? node : node.parent;
  }
  if (ts.isClassDeclaration(node)) {
    // Decorators and `extends` clauses. Class expressions continue up to the variable they are assigned to.
    return node;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && child === node.initializer) {
    return isFunctionLike(node.initializer) || isModuleLevel(node) ? node : undefined;
  }
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && isModuleLevel(node)) {
    // Module-level destructuring: treat as module initialization.
    return node.getSourceFile();
  }
  if (ts.isPropertyAssignment(node) && child === node.initializer && isFunctionLike(node.initializer)) {
    return node;
  }
  if (ts.isExportAssignment(node) || ts.isEnumDeclaration(node)) {
    return node;
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node);
}

function isModuleLevel(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent));
}

function symbolSeeds(checker: ts.TypeChecker, sourceFile: ts.SourceFile, offset: number): { declarations: ts.Node[]; directTests: TestCase[] } {
  const token = findIdentifier(sourceFile, offset);
  if (token) {
    const parent = token.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === token
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(token);
    if (symbol) {
      const resolved = resolveAlias(checker, symbol);
      const declarations = (resolved.declarations ?? []).filter((d) => !d.getSourceFile().isDeclarationFile);
      if (declarations.length > 0) {
        return { declarations, directTests: [] };
      }
      throw new AnalysisError(`'${resolved.getName()}' is declared outside the project (a library or type declaration), so its callers cannot be traced.`);
    }
  }
  // Not on a name: use the enclosing function, method, class or variable.
  const node = token ?? findNode(sourceFile, offset);
  for (let current: ts.Node | undefined = node, child: ts.Node = node; current; child = current, current = current.parent) {
    const callback = discoverTests(sourceFile).callbacks.get(current);
    if (callback?.role === 'test') {
      return { declarations: [], directTests: [callback.test] };
    }
    const container = containerFor(current, child);
    if (container) {
      return { declarations: [container], directTests: [] };
    }
  }
  throw new AnalysisError('Place the cursor on a function, class, method or other symbol.');
}

function moduleSeeds(sourceFile: ts.SourceFile): { declarations: ts.Node[]; directTests: TestCase[] } {
  const declarations: ts.Node[] = [];
  let sideEffects = false;
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isExportAssignment(statement)) {
      declarations.push(statement);
    } else if (ts.isVariableStatement(statement)) {
      declarations.push(...statement.declarationList.declarations);
    } else if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isImportEqualsDeclaration(statement) &&
      !ts.isModuleDeclaration(statement) &&
      !ts.isEmptyStatement(statement)
    ) {
      sideEffects = true;
    }
  }
  if (sideEffects) {
    // Importing the module runs its top-level statements.
    declarations.push(sourceFile);
  }
  const tests = discoverTests(sourceFile);
  return { declarations, directTests: tests.isTestFile ? (tests.cases.length > 0 ? tests.cases : [tests.fileEntry]) : [] };
}

function moduleTarget(sourceFile: ts.SourceFile): ImpactTarget {
  return { name: path.basename(sourceFile.fileName), kind: 'module', location: { file: sourceFile.fileName, line: 0, character: 0 } };
}

export function findIdentifier(sourceFile: ts.SourceFile, offset: number): ts.Identifier | ts.PrivateIdentifier | undefined {
  // Accept a cursor placed just after the name, as editors commonly report.
  for (const at of [offset, offset - 1]) {
    const node = findNode(sourceFile, at);
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.getStart(sourceFile) <= at && at <= node.end) {
      return node;
    }
  }
  return undefined;
}

/** The innermost node whose span contains the offset. */
export function findNode(sourceFile: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = sourceFile;
  const visit = (node: ts.Node) => {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function locationOf(node: ts.Node): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: sourceFile.fileName, ...position };
}

function describe(declaration: ts.Node): ImpactTarget {
  const sourceFile = declaration.getSourceFile();
  if (ts.isSourceFile(declaration)) {
    return { name: `${path.basename(sourceFile.fileName)} (module initialization)`, kind: 'module', location: { file: sourceFile.fileName, line: 0, character: 0 } };
  }
  const named = declaration as ts.NamedDeclaration;
  const nameNode = named.name && !ts.isComputedPropertyName(named.name) ? named.name : undefined;
  let name = nameNode ? nameNode.getText(sourceFile) : ts.isExportAssignment(declaration) ? 'default export' : ts.isConstructorDeclaration(declaration) ? 'constructor' : '<anonymous>';
  const owner = declaration.parent;
  if ((ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && owner.name && !ts.isClassLike(declaration)) {
    name = `${owner.name.text}.${name}`;
  }
  return { name, kind: kindOf(declaration), location: locationOf(nameNode ?? declaration) };
}

function kindOf(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) return 'accessor';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) return 'property';
  if (ts.isClassLike(node)) return 'class';
  if (ts.isEnumDeclaration(node) || ts.isEnumMember(node)) return 'enum';
  if (ts.isVariableDeclaration(node)) return node.initializer && isFunctionLike(node.initializer) ? 'function' : 'variable';
  if (ts.isExportAssignment(node)) return 'export';
  if (ts.isParameter(node)) return 'parameter';
  return ts.SyntaxKind[node.kind];
}

function stepForTest(test: TestCase): PathStep {
  return {
    name: test.isFileEntry ? `${test.title} (whole file)` : test.titlePath.join(' › '),
    kind: test.isFileEntry ? 'test file' : 'test',
    location: test.location,
  };
}
