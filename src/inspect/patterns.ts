import * as path from 'path';
import ts = require('typescript');
import { Report, ReportBuilder, ReportNode, plural } from '../structure/report';
import { catalog } from './patternCatalog';
import { learnMore } from './patternLinks';
import type { Node as CSharpNode, Tree as CSharpTree } from 'web-tree-sitter';
import { parseCSharp } from '../csharp/parser';
import { hashText } from '../analysis/paths';

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
/** Patterns found per file; a file's syntax tree never changes, so Data Flow and Design Patterns share them. */
const detected = new WeakMap<ts.SourceFile, DetectedPattern[]>();

export function detectPatterns(sourceFile: ts.SourceFile): DetectedPattern[] {
  let found = detected.get(sourceFile);
  if (!found) {
    detected.set(sourceFile, (found = findPatterns(sourceFile)));
  }
  return [...found];
}

function findPatterns(sourceFile: ts.SourceFile): DetectedPattern[] {
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
    if (!/^use[A-Z]/.test(name) && (containsJsx(body) && calls(body, (c) => /^use[A-Z]/.test(calleeName(c) ?? '')).length > 0)) {
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
  // Every further pattern of the catalog, each with its own detector.
  for (const entry of catalog) {
    found.push(...entry.detect(sourceFile).map((f) => ({ name: entry.name, meaning: entry.meaning, ...f })));
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

/** Every pattern the detectors can report. */
export function patternNames(): string[] {
  return [...Object.keys(meanings), ...catalog.map((e) => e.name)];
}

export function patternMeaning(name: string): string {
  return meanings[name] ?? catalog.find((e) => e.name === name)?.meaning ?? '';
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
      description: `${plural(found.length, 'place')}${new Set(found.map((p) => p.node.getSourceFile().fileName)).size > 1 ? ` in ${plural(new Set(found.map((p) => p.node.getSourceFile().fileName)).size, 'file')}` : ''}`,
      tooltip: `**${name}**: ${patternMeaning(name)}${learnMore(name)}`,
      icon: 'symbol-namespace',
      action: { kind: 'explainPattern', name },
      expanded: byName.size <= 4,
      children: [...found].sort((a, b) => a.node.getSourceFile().fileName.localeCompare(b.node.getSourceFile().fileName) || a.node.getStart() - b.node.getStart()).map((p) => ({ label: p.evidence, description: `${relative(p.node.getSourceFile().fileName)}:${p.node.getSourceFile().getLineAndCharacterOfPosition(p.node.getStart()).line + 1}`, location: builder.at(p.node) })),
    }));
  const layered = detectLayers(files.map((f) => f.fileName), root);
  if (layered.length >= 2) {
    roots.push({ label: 'Layered architecture', description: layered.join(' → '), tooltip: `**Layered architecture**: ${meanings['Layered architecture']}${learnMore('Layered architecture')}`, icon: 'layers', action: { kind: 'explainPattern', name: 'Layered architecture' } });
  }
  if (roots.length === 0) {
    builder.warnings.push(`No design patterns recognized in ${plural(files.length, 'file')}.`);
  }
  // "mostly" only when one pattern clearly leads.
  const [top, second] = [...byName].sort((a, b) => b[1].length - a[1].length);
  return builder.finish(roots, `${plural(roots.length, 'pattern')} in ${plural(files.length, 'file')}${top && second && top[1].length > second[1].length ? `, mostly ${top[0]}` : ''}`);
}

// ---------------------------------------------------------------- C#

/** A pattern in C# code, found by the bundled parser: where it is, by file and position. */
interface CSharpPattern {
  name: string;
  evidence: string;
  file: string;
  node: CSharpNode;
}

const csKids = (n: CSharpNode): CSharpNode[] => n.namedChildren.filter((c): c is CSharpNode => !!c);
const csAll = (n: CSharpNode, types: string | string[]): CSharpNode[] => n.descendantsOfType(types).filter((c): c is CSharpNode => !!c);
const csModifiers = (n: CSharpNode) => csKids(n).filter((c) => c.type === 'modifier').map((c) => c.text);
const csName = (n: CSharpNode) => n.childForFieldName('name')?.text ?? '';
/** What a method returns: its return statements' values, or its expression body. */
function csReturns(method: CSharpNode): CSharpNode[] {
  const body = method.childForFieldName('body') ?? csKids(method).find((c) => c.type === 'block' || c.type === 'arrow_expression_clause');
  if (!body) return [];
  if (body.type === 'arrow_expression_clause') return csKids(body).slice(0, 1);
  // `return this;` has no named child: this is a keyword token in the grammar.
  return csAll(body, 'return_statement').map((r) => r.children.find((c) => !!c && c.type !== 'return' && c.type !== ';')).filter((e): e is CSharpNode => !!e);
}

/** Patterns in one C# class, from its shape: members, constructors, what methods return and change. */
function csharpClassPatterns(cls: CSharpNode, file: string, implementers: Map<string, string[]>): CSharpPattern[] {
  const name = csName(cls);
  const found: CSharpPattern[] = [];
  const say = (pattern: string, evidence: string, node: CSharpNode = cls) => found.push({ name: pattern, evidence, file, node });
  const list = cls.childForFieldName('body') ?? csKids(cls).find((c) => c.type === 'declaration_list');
  const members = list ? csKids(list) : [];
  const methods = members.filter((m) => m.type === 'method_declaration');
  const fields = members.filter((m) => m.type === 'field_declaration' || m.type === 'property_declaration');
  const typeOf = (m: CSharpNode) => (m.type === 'field_declaration' ? csKids(m).find((c) => c.type === 'variable_declaration')?.childForFieldName('type')?.text : m.childForFieldName('type')?.text) ?? '';
  const fieldName = (m: CSharpNode) => (m.type === 'field_declaration' ? csAll(m, 'variable_declarator')[0]?.childForFieldName('name')?.text ?? csAll(m, 'variable_declarator')[0]?.namedChildren[0]?.text : csName(m)) ?? '';

  // Singleton: one shared instance in a static member of its own type, with no public way to make another.
  const constructors = members.filter((m) => m.type === 'constructor_declaration' && !csModifiers(m).includes('static'));
  const hidden = constructors.length > 0 && constructors.every((c) => csModifiers(c).some((m) => m === 'private' || m === 'protected'));
  const ownStatic = fields.find((m) => csModifiers(m).includes('static') && new RegExp(`^(${name}|Lazy<${name}>)\\??$`).test(typeOf(m)));
  if (ownStatic && hidden) say('Singleton', `${name} keeps its one instance in static ${fieldName(ownStatic)} and hides its constructor`, ownStatic);

  // Builder: methods that return this, then Build().
  const fluent = methods.filter((m) => csReturns(m).some((e) => e.text === 'this'));
  const build = methods.find((m) => csName(m) === 'Build');
  if (fluent.length >= 2 && build) say('Builder', `${name}: ${fluent.length} methods return this, then Build()`);

  // Observer: an event, or a list of callbacks or observers that one method adds to and another calls.
  const events = members.filter((m) => m.type === 'event_field_declaration' || m.type === 'event_declaration');
  const raised = events.length && methods.find((m) => events.some((e) => new RegExp(`\\b${csAll(e, 'variable_declarator')[0]?.childForFieldName('name')?.text ?? csName(e)}\\s*\\?\\.\\s*Invoke\\b|\\b${csAll(e, 'variable_declarator')[0]?.childForFieldName('name')?.text ?? csName(e)}\\s*\\(`).test(m.text)));
  if (events.length && raised) {
    say('Observer', `${name} raises its event ${csAll(events[0], 'variable_declarator')[0]?.childForFieldName('name')?.text ?? csName(events[0])} in ${csName(raised)}()`, events[0]);
  } else {
    for (const field of fields.filter((m) => /^(List|HashSet|ICollection|IList|Collection)<(Action|Func|I\w+|EventHandler)\b/.test(typeOf(m)))) {
      const f = fieldName(field);
      const adds = methods.find((m) => new RegExp(`\\b${f}\\s*\\.\\s*Add\\s*\\(`).test(m.text));
      const notifies = methods.find((m) => new RegExp(`foreach\\s*\\([^)]*\\bin\\s+(this\\.)?${f}\\b|\\b${f}\\s*\\.\\s*ForEach\\s*\\(`).test(m.text));
      if (adds && notifies) {
        say('Observer', `${name} registers callbacks in ${f} in ${csName(adds)}() and calls them in ${csName(notifies)}()`, field);
        break;
      }
    }
  }

  // Repository: data access behind find, save and delete methods.
  const verbs = ['Find|Get', 'Add|Save|Insert|Create', 'Delete|Remove'].filter((v) => methods.some((m) => new RegExp(`^(${v})`).test(csName(m))));
  if (verbs.length >= 2 && (/(Repository|Repo|Store|Dao)$/.test(name) || fields.some((m) => /^(DbSet|DbContext|IDbConnection|SqlConnection|Dictionary|List|ConcurrentDictionary)\b|Context$/.test(typeOf(m))))) {
    say('Repository', `${name} wraps data access (${methods.filter((m) => /^(Find|Get|Add|Save|Insert|Create|Delete|Remove|Update)/.test(csName(m))).map((m) => `${csName(m)}()`).slice(0, 3).join(', ')})`);
  }

  // Dependency injection: collaborators passed to the constructor and kept in fields.
  for (const ctor of constructors) {
    const parameters = csAll(ctor, 'parameter').filter((p) => p.parent?.parent?.id === ctor.id);
    const kept = parameters.filter((p) => {
      const type = p.childForFieldName('type')?.text ?? '';
      const pname = p.childForFieldName('name')?.text ?? '';
      return /^[A-Z]/.test(type) && !/^(String|Int32|Decimal|Boolean|DateTime|Guid)$/.test(type) && new RegExp(`(this\\.)?\\w+\\s*=\\s*${pname}\\b`).test(ctor.text);
    });
    if (kept.length) {
      say('Dependency injection', `${name} receives ${kept.map((p) => p.childForFieldName('type')!.text).join(', ')} in its constructor`, ctor);
      break;
    }
  }

  // Strategy: a member typed as an interface that several classes implement.
  for (const m of [...fields, ...constructors.flatMap((c) => csAll(c, 'parameter'))]) {
    const type = (m.type === 'parameter' ? m.childForFieldName('type')?.text : typeOf(m)) ?? '';
    const impl = implementers.get(type);
    if (/^I[A-Z]/.test(type) && impl && impl.length >= 2) {
      say('Strategy', `${name} uses ${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}: ${impl.slice(0, 3).join(', ')}${impl.length > 3 ? '…' : ''} are interchangeable`, m);
      break;
    }
  }

  // Memoization: a dictionary consulted before computing, and filled after.
  for (const field of fields.filter((m) => /^(Dictionary|ConcurrentDictionary|IDictionary)</.test(typeOf(m)))) {
    const f = fieldName(field);
    const method = methods.find((m) => new RegExp(`\\b${f}\\s*\\.\\s*(TryGetValue|ContainsKey)\\s*\\(`).test(m.text) && new RegExp(`\\b${f}\\s*(\\[[^\\]]+\\]\\s*=(?!=)|\\.\\s*(Add|TryAdd)\\s*\\()`).test(m.text));
    const getOrAdd = methods.find((m) => new RegExp(`\\b${f}\\s*\\.\\s*GetOrAdd\\s*\\(`).test(m.text));
    if (method || getOrAdd) {
      say('Memoization', `${name}.${csName((method ?? getOrAdd)!)}() caches results in ${f}`, (method ?? getOrAdd)!);
      break;
    }
  }

  // Factory: a Create/Make/Build/New method that returns a new object (not this).
  for (const m of methods) {
    const returned = csReturns(m);
    const made = returned.find((e) => e.type === 'object_creation_expression' || e.type === 'implicit_object_creation_expression');
    if (/^(Create|Make|New|Build)[A-Z]?/.test(csName(m)) && made && !returned.some((e) => e.text === 'this') && csName(m) !== 'Build') {
      say('Factory', `${csName(m)}() returns new ${made.childForFieldName('type')?.text ?? 'object'}(…)`, m);
    }
  }

  // Command: Execute() on a class that implements a one-method interface.
  const execute = methods.find((m) => /^(Execute|ExecuteAsync|Undo)$/.test(csName(m)));
  const bases = csKids(cls).find((c) => c.type === 'base_list');
  if (execute && bases && /\bI\w*Command\b/.test(bases.text)) say('Command', `${name} is a command: ${bases.text.replace(/^:\s*/, '')} with ${csName(execute)}()`, execute);

  // Pipeline: three or more LINQ steps chained.
  for (const m of methods) {
    const chain = csAll(m, 'invocation_expression').find((call) => (call.text.match(/\.\s*(Where|Select|SelectMany|OrderBy|OrderByDescending|ThenBy|GroupBy|Distinct|Take|Skip|Aggregate|Join|Zip)\s*\(/g) ?? []).length >= 3 && call.parent?.type !== 'member_access_expression');
    if (chain) {
      say('Pipeline', `${csName(m)}() chains ${(chain.text.match(/\.\s*(Where|Select|SelectMany|OrderBy|OrderByDescending|ThenBy|GroupBy|Distinct|Take|Skip|Aggregate|Join|Zip)\s*\(/g) ?? []).length} LINQ steps`, chain);
      break;
    }
  }
  return found;
}

/** Pattern spotting in C#: every pattern in the files' classes, grouped by pattern, as for TypeScript. */
export async function csharpPatternsReport(sources: readonly { file: string; text: string }[], root?: string): Promise<Report> {
  const trees: { file: string; text: string; tree: CSharpTree }[] = [];
  try {
    for (const s of sources) trees.push({ ...s, tree: await parseCSharp(s.text) });
    // Which classes implement each interface, across the files: for Strategy.
    const implementers = new Map<string, string[]>();
    const classTypes = ['class_declaration', 'record_declaration', 'struct_declaration'];
    for (const t of trees) {
      for (const cls of csAll(t.tree.rootNode, classTypes)) {
        const bases = csKids(cls).find((c) => c.type === 'base_list');
        for (const base of bases ? csKids(bases) : []) {
          const type = base.text.replace(/<.*$/, '');
          implementers.set(type, [...(implementers.get(type) ?? []), csName(cls)]);
        }
      }
    }
    const found = trees.flatMap((t) => csAll(t.tree.rootNode, classTypes).flatMap((cls) => csharpClassPatterns(cls, t.file, implementers)));
    const byName = new Map<string, CSharpPattern[]>();
    for (const p of found) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    const relative = (f: string) => (root ? path.relative(root, f) : path.basename(f)).replace(/\\/g, '/');
    const roots: ReportNode[] = [...byName]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, list]) => ({
        label: name,
        description: `${plural(list.length, 'place')}${new Set(list.map((p) => p.file)).size > 1 ? ` in ${plural(new Set(list.map((p) => p.file)).size, 'file')}` : ''}`,
        tooltip: `**${name}**: ${patternMeaning(name)}${learnMore(name)}`,
        icon: 'symbol-namespace',
        action: { kind: 'explainPattern', name },
        expanded: byName.size <= 4,
        children: list.map((p) => ({
          label: p.evidence,
          description: `${relative(p.file)}:${p.node.startPosition.row + 1}`,
          location: { file: p.file, line: p.node.startPosition.row, character: p.node.startPosition.column, endLine: p.node.endPosition.row, endCharacter: p.node.endPosition.column },
        })),
      }));
    const layered = detectLayers(sources.map((s) => s.file), root);
    if (layered.length >= 2) roots.push({ label: 'Layered architecture', description: layered.join(' → '), tooltip: `**Layered architecture**: ${meanings['Layered architecture']}${learnMore('Layered architecture')}`, icon: 'layers', action: { kind: 'explainPattern', name: 'Layered architecture' } });
    const [top, second] = [...byName].sort((a, b) => b[1].length - a[1].length);
    const fileHashes: Record<string, string> = {};
    for (const t of trees) if (found.some((p) => p.file === t.file)) fileHashes[t.file] = hashText(t.text);
    return {
      kind: 'patterns',
      title: 'Design patterns',
      description: `${plural(roots.length, 'pattern')} in ${plural(sources.length, 'file')}${top && second && top[1].length > second[1].length ? `, mostly ${top[0]}` : ''}`,
      roots,
      warnings: roots.length ? [] : [`No design patterns recognized in ${plural(sources.length, 'file')}.`],
      fileHashes,
    };
  } finally {
    for (const t of trees) t.tree.delete();
  }
}
