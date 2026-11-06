import * as path from 'path';
import * as ts from 'typescript';
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';

/** A design pattern or architectural style recognized from the shape of the code, never guessed from names alone. */
export interface DetectedPattern {
  name: string;
  /** What in the code shows it, such as "createOrder() returns new Order(…)". */
  evidence: string;
  /** What the pattern means for a value passing through it. */
  meaning: string;
  node: ts.Node;
  /** The type the pattern is about, such as the class of a Singleton or the interface of a Strategy. */
  subject?: string;
}

const meanings: Record<string, string> = {
  Singleton: 'One shared instance: every caller reads and changes the same object.',
  Factory: 'Objects are created in one place: values come out of the factory, not from new at each call site.',
  Builder: 'The object is assembled step by step through chained calls before build() produces it.',
  Observer: 'Listeners are registered and notified: values flow out to every subscriber when an event is emitted.',
  Strategy: 'Interchangeable implementations of one interface: which code runs depends on the object passed in.',
  Repository: 'Data access sits behind find, save and delete methods: values come from and go to a store.',
  Reducer: 'State is replaced, not changed: each action produces a new state object (Redux or useReducer style).',
  Memoization: 'Results are cached in a map: a repeated call returns the stored value instead of recomputing it.',
  Pipeline: 'Data is transformed by a chain of steps, each one producing a new value from the previous.',
  'Dependency injection': 'Collaborators are passed into the constructor, so values flow in from whoever creates the object.',
  'Shared module state': 'A module-level variable changed by functions: a global the whole module shares.',
  'Higher-order function': 'A function that wraps or returns another function, adding behavior around it (decorator style).',
  'React component with hooks': 'UI state lives in hooks; values flow into props and out to rendered JSX.',
  Command: 'Actions are objects with execute(), so they can be queued, logged or undone.',
  'Layered architecture': 'Code is split into layers such as controllers, services and repositories, each calling the next.',
};

const describe = (node: ts.Node, name: string, evidence: string, subject?: string): DetectedPattern => ({ name, evidence, meaning: meanings[name], node, subject });

const nameOf = (node: ts.Node): string | undefined => {
  const name = (node as ts.NamedDeclaration).name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) => (ts.canHaveModifiers(node) ? ts.getModifiers(node)?.some((m) => m.kind === kind) : false) ?? false;

function returnsOf(body: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      found.push(node.expression);
    }
    if (!ts.isFunctionLike(node)) {
      ts.forEachChild(node, visit);
    }
  };
  if (ts.isBlock(body)) {
    visit(body);
  } else if (ts.isExpression(body)) {
    found.push(body);
  }
  return found;
}

const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e);

/** Functions in the file with their names: declarations, methods and functions assigned to names. */
function namedFunctions(sourceFile: ts.SourceFile): { name: string; fn: ts.FunctionLikeDeclaration & { body?: ts.ConciseBody } }[] {
  const out: { name: string; fn: ts.FunctionLikeDeclaration & { body?: ts.ConciseBody } }[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && nameOf(node)) {
      out.push({ name: nameOf(node)!, fn: node });
    } else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && nameOf(node)) {
      out.push({ name: nameOf(node)!, fn: node.initializer });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function calls(node: ts.Node, test: (call: ts.CallExpression) => boolean): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && test(n)) {
      found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;

/** Patterns in one class. */
function classPatterns(cls: ts.ClassLikeDeclaration): DetectedPattern[] {
  const name = cls.name?.text ?? 'class';
  const found: DetectedPattern[] = [];
  const members = cls.members;
  const staticOfOwnType = members.find(
    (m) => ts.isPropertyDeclaration(m) && hasModifier(m, ts.SyntaxKind.StaticKeyword) && ((m.type && m.type.getText().split('|')[0].trim() === name) || (m.initializer && ts.isNewExpression(m.initializer) && m.initializer.expression.getText() === name)),
  );
  const privateConstructor = members.some((m) => ts.isConstructorDeclaration(m) && hasModifier(m, ts.SyntaxKind.PrivateKeyword));
  if (staticOfOwnType || privateConstructor) {
    found.push(describe(cls, 'Singleton', staticOfOwnType ? `${name} keeps its one instance in static ${nameOf(staticOfOwnType)}` : `${name} has a private constructor`));
  }
  const fluent = members.filter((m) => ts.isMethodDeclaration(m) && m.body && returnsOf(m.body).some((e) => unwrap(e).kind === ts.SyntaxKind.ThisKeyword));
  const build = members.find((m) => ts.isMethodDeclaration(m) && nameOf(m) === 'build');
  if (fluent.length >= 2 && build) {
    found.push(describe(cls, 'Builder', `${name}: ${fluent.length} methods return this, then build()`));
  }
  // A collection of callbacks that one method adds to and another loops over and calls.
  const collections = members.filter((m) => ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrayLiteralExpression(m.initializer) || (ts.isNewExpression(m.initializer) && /^(Set|Map)$/.test(m.initializer.expression.getText()))));
  for (const collection of collections) {
    const field = nameOf(collection);
    const adds = members.some((m) => ts.isMethodDeclaration(m) && m.body && calls(m.body, (c) => /^(push|add|set)$/.test(calleeName(c) ?? '') && c.expression.getText().includes(`this.${field}`)).length > 0);
    const notifies = members.find((m) => ts.isMethodDeclaration(m) && m.body && calls(m.body, (c) => /^(forEach)$/.test(calleeName(c) ?? '') && c.expression.getText().includes(`this.${field}`)).length > 0 || (ts.isMethodDeclaration(m) && m.body && /for\s*\(\s*const\s+\w+\s+of\s+this\./.test(m.body.getText()) && m.body.getText().includes(`this.${field}`)));
    if (adds && notifies) {
      found.push(describe(cls, 'Observer', `${name} registers callbacks in ${field} and calls them in ${nameOf(notifies)}()`));
      break;
    }
  }
  if (/(Repository|Repo|Store|Dao)$/.test(name) || ['find', 'save', 'delete'].filter((verb) => members.some((m) => ts.isMethodDeclaration(m) && new RegExp(`^${verb}`, 'i').test(nameOf(m) ?? ''))).length >= 2) {
    found.push(describe(cls, 'Repository', `${name} wraps data access (${members.filter((m) => ts.isMethodDeclaration(m) && /^(find|get|save|delete|remove|update|insert)/i.test(nameOf(m) ?? '')).map((m) => `${nameOf(m)}()`).slice(0, 3).join(', ')})`));
  }
  const constructor = members.find(ts.isConstructorDeclaration);
  const injected = constructor?.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, constructor) && p.type && ts.isTypeReferenceNode(p.type)) ?? [];
  if (injected.length >= 1) {
    found.push(describe(constructor!, 'Dependency injection', `${name} receives ${injected.map((p) => p.type!.getText()).join(', ')} in its constructor`));
  }
  return found.map((p) => ({ ...p, subject: name }));
}

/** Design patterns and architecture recognizable in the file, each with the node that shows it. */
export function detectPatterns(sourceFile: ts.SourceFile): DetectedPattern[] {
  const found: DetectedPattern[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) {
      found.push(...classPatterns(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const { name, fn } of namedFunctions(sourceFile)) {
    const body = fn.body;
    if (!body) {
      continue;
    }
    // A returned local counts as what it was initialized to: `const order = new Order(); return order;`.
    const locals = new Map<string, ts.Expression>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        locals.set(node.name.text, unwrap(node.initializer));
      }
      if (!ts.isFunctionLike(node)) {
        ts.forEachChild(node, collect);
      }
    };
    collect(body);
    const returned = returnsOf(body)
      .map(unwrap)
      .map((e) => (ts.isIdentifier(e) && locals.has(e.text) ? locals.get(e.text)! : e));
    const created = returned.filter((e) => ts.isNewExpression(e) || ts.isObjectLiteralExpression(e));
    if (/^(create|make|build|new)[A-Z]/.test(name) && created.length > 0 && !(ts.isMethodDeclaration(fn) && returned.some((e) => e.kind === ts.SyntaxKind.ThisKeyword))) {
      const what = created.find(ts.isNewExpression)?.expression.getText();
      found.push(describe(fn, 'Factory', `${name}() returns ${what ? `new ${what}(…)` : 'a new object'}`));
    }
    // (state, action) with a switch on action.type returning a new state.
    const [first, second] = fn.parameters;
    if (first && second && ts.isIdentifier(first.name) && ts.isIdentifier(second.name) && /state/i.test(first.name.text) && /action/i.test(second.name.text) && body.getText().includes(`${second.name.text}.type`)) {
      found.push(describe(fn, 'Reducer', `${name}(${first.name.text}, ${second.name.text}) returns a new state for each ${second.name.text}.type`));
    }
    const text = body.getText();
    const cache = /(\w+(?:\.\w+)?)\.has\(/.exec(text);
    if (cache && text.includes(`${cache[1]}.get(`) && text.includes(`${cache[1]}.set(`)) {
      found.push(describe(fn, 'Memoization', `${name}() returns ${cache[1]}.get(…) when cached, else computes and stores it`));
    }
    const chain = calls(body, (c) => /^(map|filter|reduce|flatMap|sort)$/.test(calleeName(c) ?? '') && ts.isPropertyAccessExpression(c.expression) && ts.isCallExpression(c.expression.expression) && /^(map|filter|reduce|flatMap|sort|slice)$/.test(calleeName(c.expression.expression) ?? ''));
    if (chain.length > 0) {
      found.push(describe(chain[0], 'Pipeline', `${name}() chains ${chain[0].getText().match(/\.(map|filter|reduce|flatMap|sort|slice)\(/g)?.map((m) => m.slice(1, -1)).join(' → ')}`));
    }
    if (/^use[A-Z]/.test(name) || (containsJsx(body) && calls(body, (c) => /^use[A-Z]/.test(calleeName(c) ?? '')).length > 0)) {
      const hooks = [...new Set(calls(body, (c) => /^use[A-Z]/.test(calleeName(c) ?? '')).map((c) => calleeName(c)))];
      if (hooks.length) {
        found.push(describe(fn, 'React component with hooks', `${name} uses ${hooks.slice(0, 3).join(', ')}`));
      }
    }
    // Takes a function and returns a function: a wrapper around behavior.
    const takesFunction = fn.parameters.some((p) => p.type && (ts.isFunctionTypeNode(p.type) || /=>/.test(p.type.getText())));
    if (takesFunction && returned.some((e) => ts.isArrowFunction(e) || ts.isFunctionExpression(e))) {
      found.push(describe(fn, 'Higher-order function', `${name}() takes a function and returns a wrapped one`));
    }
  }

  // Module-level `let` reassigned or changed inside functions.
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Let) {
      for (const declaration of statement.declarationList.declarations) {
        const variable = nameOf(declaration);
        if (variable && namedFunctions(sourceFile).some(({ fn }) => fn.body && new RegExp(`\\b${variable}\\s*(=[^=]|\\+=|-=|\\+\\+|--)`).test(fn.body.getText()))) {
          found.push(describe(declaration, 'Shared module state', `module variable ${variable} is changed by its functions`));
        }
      }
    }
  }

  // Several classes implementing one interface, each with the same method: interchangeable strategies or commands.
  const implementers = new Map<string, ts.ClassLikeDeclaration[]>();
  visitClasses(sourceFile, (cls) => {
    for (const clause of cls.heritageClauses ?? []) {
      for (const type of clause.types) {
        const base = type.expression.getText();
        implementers.set(base, [...(implementers.get(base) ?? []), cls]);
      }
    }
  });
  for (const [base, classes] of implementers) {
    if (classes.length >= 2) {
      const execute = classes.every((c) => c.members.some((m) => nameOf(m) === 'execute'));
      found.push(describe(classes[0], execute ? 'Command' : 'Strategy', `${classes.map((c) => c.name?.text ?? 'class').join(', ')} are interchangeable ${base}s`, base));
    }
  }
  return found;
}

function visitClasses(node: ts.Node, visit: (cls: ts.ClassLikeDeclaration) => void): void {
  if (ts.isClassLike(node)) {
    visit(node);
  }
  ts.forEachChild(node, (child) => visitClasses(child, visit));
}

const layers: [RegExp, string][] = [
  [/(^|\/)(controllers?|routes?|handlers?|api)\//i, 'controllers'],
  [/(^|\/)(services?|use-?cases?|domain)\//i, 'services'],
  [/(^|\/)(repositor(y|ies)|data|dal|db|stores?)\//i, 'repositories'],
  [/(^|\/)(models?|entities)\//i, 'models'],
  [/(^|\/)(components?|views?|pages?)\//i, 'views'],
];

/** Folders named after layers (controllers, services, repositories…) among the files a value passes through. */
export function detectLayers(fileNames: readonly string[], root?: string): string[] {
  const relative = fileNames.map((f) => (root ? path.relative(root, f) : f).replace(/\\/g, '/'));
  return layers.filter(([pattern]) => relative.some((f) => pattern.test(`/${f}`))).map(([, layer]) => layer);
}

export function patternMeaning(name: string): string {
  return meanings[name] ?? '';
}

/** Detect Design Patterns: every pattern in the files, grouped by pattern, with what each means. */
export function patternsReport(files: readonly ts.SourceFile[], root?: string): Report {
  const builder = new ReportBuilder('patterns', 'Design patterns');
  const byName = new Map<string, DetectedPattern[]>();
  for (const file of files) {
    for (const pattern of detectPatterns(file)) {
      byName.set(pattern.name, [...(byName.get(pattern.name) ?? []), pattern]);
    }
  }
  const relative = (f: string) => (root ? path.relative(root, f) : path.basename(f)).replace(/\\/g, '/');
  const roots: ReportNode[] = [...byName]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, found]) => ({
      label: name,
      description: plural(found.length, 'place'),
      tooltip: `**${name}**: ${meanings[name]}`,
      icon: 'symbol-namespace',
      expanded: byName.size <= 4,
      children: found.map((p) => ({ label: p.evidence, description: `${relative(p.node.getSourceFile().fileName)}:${p.node.getSourceFile().getLineAndCharacterOfPosition(p.node.getStart()).line + 1}`, location: builder.at(p.node) })),
    }));
  const layered = detectLayers(files.map((f) => f.fileName), root);
  if (layered.length >= 2) {
    roots.push({ label: 'Layered architecture', description: layered.join(' → '), tooltip: `**Layered architecture**: ${meanings['Layered architecture']}`, icon: 'layers' });
  }
  if (roots.length === 0) {
    builder.warnings.push(`No design patterns recognized in ${plural(files.length, 'file')}.`);
  }
  return builder.finish(roots, `${plural(roots.length, 'pattern')} in ${plural(files.length, 'file')}`);
}
