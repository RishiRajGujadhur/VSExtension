import * as ts from 'typescript';

/** What a catalog detector found: the node that shows the pattern and how. */
export interface Found {
  node: ts.Node;
  evidence: string;
  /** The type the pattern is about, so Data Flow can relate it to a value of that type. */
  subject?: string;
}

/** One design pattern: what it means for code and how to recognize it from the code's shape. */
export interface CatalogEntry {
  name: string;
  meaning: string;
  detect(sourceFile: ts.SourceFile): Found[];
}

/** The patterns beyond the core set of patterns.ts, each recognized by its own detector. */
export const catalog: CatalogEntry[] = [];

export const nameOf = (node: ts.Node | undefined): string | undefined => {
  const name = node && (node as ts.NamedDeclaration).name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
};

const text = (node: ts.Node | undefined): string => node?.getText() ?? '';

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function classesIn(sourceFile: ts.SourceFile): ts.ClassLikeDeclaration[] {
  const found: ts.ClassLikeDeclaration[] = [];
  walk(sourceFile, (node) => ts.isClassLike(node) && found.push(node));
  return found;
}

/** Named functions: declarations, methods and functions assigned to a name. */
function functionsIn(sourceFile: ts.SourceFile): { name: string; fn: ts.FunctionLikeDeclaration }[] {
  const found: { name: string; fn: ts.FunctionLikeDeclaration }[] = [];
  walk(sourceFile, (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && nameOf(node)) {
      found.push({ name: nameOf(node)!, fn: node });
    } else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && nameOf(node)) {
      found.push({ name: nameOf(node)!, fn: node.initializer });
    }
  });
  return found;
}

/** Fields of a class, including constructor parameter properties, with their declared type or initializer text. */
function fieldsOf(cls: ts.ClassLikeDeclaration): { name: string; type: string; init: string; node: ts.Node; readonly: boolean }[] {
  const fields: { name: string; type: string; init: string; node: ts.Node; readonly: boolean }[] = [];
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && nameOf(member)) {
      fields.push({ name: nameOf(member)!, type: text(member.type), init: text(member.initializer), node: member, readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword) });
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const p of member.parameters) {
        if (ts.isParameterPropertyDeclaration(p, member) && nameOf(p)) {
          fields.push({ name: nameOf(p)!, type: text(p.type), init: '', node: p, readonly: hasModifier(p, ts.SyntaxKind.ReadonlyKeyword) });
        }
      }
    }
  }
  return fields;
}

const methodsOf = (cls: ts.ClassLikeDeclaration): ts.MethodDeclaration[] => cls.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body);

/** The names after `implements` (or `extends`) in the class heading. */
const heritage = (cls: ts.ClassLikeDeclaration, token: ts.SyntaxKind): string[] =>
  (cls.heritageClauses ?? []).filter((h) => h.token === token).flatMap((h) => h.types.map((t) => t.expression.getText()));

const className = (cls: ts.ClassLikeDeclaration): string => cls.name?.text ?? 'class';

function returnsOf(body: ts.Node | undefined): ts.Expression[] {
  const found: ts.Expression[] = [];
  if (!body) {
    return found;
  }
  if (!ts.isBlock(body) && ts.isExpression(body)) {
    return [body];
  }
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      found.push(node.expression);
    }
    if (!ts.isFunctionLike(node)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(body);
  return found;
}

const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e);

function containsJsx(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    found ||= ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
  });
  return found;
}

catalog.push({
  name: 'Adapter',
  meaning: 'Calls go through a class that translates one interface into another: values are converted on the way in and out.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const [iface] = heritage(cls, ts.SyntaxKind.ImplementsKeyword);
      if (!iface) return [];
      const adaptee = fieldsOf(cls).find((f) => f.type && f.type !== iface && methodsOf(cls).filter((m) => text(m.body).includes(`this.${f.name}.`)).length >= 2);
      return adaptee ? [{ node: cls, evidence: `${className(cls)} adapts ${adaptee.type} to ${iface}`, subject: iface }] : [];
    }),
});

catalog.push({
  name: 'Facade',
  meaning: 'One simple method coordinates several collaborators, hiding how they work together.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const collaborators = fieldsOf(cls).filter((f) => /^[A-Z]/.test(f.type));
      const method = methodsOf(cls).find((m) => collaborators.filter((f) => text(m.body).includes(`this.${f.name}.`)).length >= 3);
      return method ? [{ node: method, evidence: `${className(cls)}.${nameOf(method)}() coordinates ${collaborators.filter((f) => text(method.body).includes(`this.${f.name}.`)).map((f) => f.name).join(', ')}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Proxy',
  meaning: 'Access to an object goes through a stand-in that can intercept reads, writes or calls.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isNewExpression(node) && text(node.expression) === 'Proxy') {
        found.push({ node, evidence: `new Proxy(${text(node.arguments?.[0]).slice(0, 30)}, …) intercepts access` });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Decorator',
  meaning: 'An object wraps another of the same interface and adds behavior around its calls.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const interfaces = heritage(cls, ts.SyntaxKind.ImplementsKeyword);
      const inner = fieldsOf(cls).find((f) => interfaces.includes(f.type));
      const wraps = inner && methodsOf(cls).some((m) => text(m.body).includes(`this.${inner.name}.${nameOf(m)}(`));
      return inner && wraps ? [{ node: cls, evidence: `${className(cls)} wraps another ${inner.type} and adds to its calls`, subject: inner.type }] : [];
    }),
});

catalog.push({
  name: 'Template method',
  meaning: 'A base class fixes the steps of an algorithm and subclasses fill in the abstract ones.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const abstract = cls.members.filter((m) => ts.isMethodDeclaration(m) && hasModifier(m, ts.SyntaxKind.AbstractKeyword)).map(nameOf);
      const template = methodsOf(cls).find((m) => abstract.some((a) => text(m.body).includes(`this.${a}(`)));
      return template ? [{ node: template, evidence: `${className(cls)}.${nameOf(template)}() calls the abstract ${abstract.filter((a) => text(template.body).includes(`this.${a}(`)).join(', ')}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'State',
  meaning: 'Behavior changes with the object’s current state object: each state class handles the calls its own way.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const state = fieldsOf(cls).find((f) => /state/i.test(f.name) && /^[A-Z]\w*$/.test(f.type));
      const delegating = state ? methodsOf(cls).filter((m) => new RegExp(`this\\.${state.name}\\.\\w+\\(`).test(text(m.body))) : [];
      return state && delegating.length >= 2 ? [{ node: cls, evidence: `${className(cls)} delegates ${delegating.map((m) => `${nameOf(m)}()`).join(', ')} to its ${state.type}`, subject: className(cls) }] : [];
    }),
});
