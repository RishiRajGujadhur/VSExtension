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

catalog.push({
  name: 'Event bus',
  meaning: 'Named events: listeners subscribe to an event name and every emit of that name reaches them.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const map = fieldsOf(cls).find((f) => /Map<\s*string/.test(f.type + f.init) || /Record<\s*string/.test(f.type));
      const emits = map && methodsOf(cls).find((m) => text(m.body).includes(`this.${map.name}`) && /forEach\(|for \(const/.test(text(m.body)));
      return map && emits ? [{ node: cls, evidence: `${className(cls)} keeps listeners per event name in ${map.name} and ${nameOf(emits)}() calls them`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Chain of responsibility',
  meaning: 'A request is passed along a chain of handlers until one of them deals with it.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const own = [className(cls), ...heritage(cls, ts.SyntaxKind.ImplementsKeyword)];
      const next = fieldsOf(cls).find((f) => own.includes(f.type.replace(/\s*\|\s*(undefined|null)/g, '')));
      const passes = next && methodsOf(cls).some((m) => new RegExp(`this\\.${next.name}\\??\\.`).test(text(m.body)));
      return next && passes ? [{ node: cls, evidence: `${className(cls)} passes requests on to this.${next.name}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Composite',
  meaning: 'A tree of objects where a group is treated like a single item: calls recurse into children.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const own = [className(cls), ...heritage(cls, ts.SyntaxKind.ImplementsKeyword)];
      const children = fieldsOf(cls).find((f) => own.some((o) => f.type === `${o}[]` || f.type === `Array<${o}>`));
      const recursive = children && methodsOf(cls).find((m) => text(m.body).includes(`this.${children.name}`) && text(m.body).includes(`.${nameOf(m)}(`));
      return children && recursive ? [{ node: cls, evidence: `${className(cls)}.${nameOf(recursive)}() recurses into its ${children.name}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Visitor',
  meaning: 'Operations live in a visitor object; each element calls the visitor method for its own type.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const accept = methodsOf(cls).find((m) => nameOf(m) === 'accept' && m.parameters.length > 0 && new RegExp(`${text(m.parameters[0].name)}\\.visit\\w*\\(`).test(text(m.body)));
      return accept ? [{ node: accept, evidence: `${className(cls)}.accept() hands itself to the visitor`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Iterator',
  meaning: 'Values are produced one at a time on demand, by a generator or a [Symbol.iterator] method.',
  detect: (sf) =>
    functionsIn(sf)
      .filter(({ fn }) => !!fn.asteriskToken)
      .map(({ name, fn }): Found => ({ node: fn, evidence: `${name}() is a generator that yields values on demand` }))
      .concat(
        classesIn(sf).flatMap((cls) =>
          cls.members.filter((m) => ts.isMethodDeclaration(m) && text(m.name).includes('Symbol.iterator')).map((m) => ({ node: m, evidence: `${className(cls)} can be iterated with for…of`, subject: className(cls) })),
        ),
      ),
});

catalog.push({
  name: 'Prototype',
  meaning: 'New objects are made by copying an existing one rather than built from scratch.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const clone = methodsOf(cls).find((m) => /^(clone|copy)$/.test(nameOf(m) ?? '') && returnsOf(m.body).some((e) => (ts.isNewExpression(unwrap(e)) && text((unwrap(e) as ts.NewExpression).expression) === className(cls)) || /Object\.create|structuredClone|\{\s*\.\.\.this/.test(text(e))));
      return clone ? [{ node: clone, evidence: `${className(cls)}.${nameOf(clone)}() returns a copy of itself`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Object pool',
  meaning: 'Expensive objects are reused: taken from a pool and given back instead of created each time.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const pool = fieldsOf(cls).find((f) => /\[\]|Array</.test(f.type + f.init) && methodsOf(cls).some((m) => text(m.body).includes(`this.${f.name}.pop(`)) && methodsOf(cls).some((m) => text(m.body).includes(`this.${f.name}.push(`)));
      return pool ? [{ node: cls, evidence: `${className(cls)} hands out and takes back objects in ${pool.name}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Lazy initialization',
  meaning: 'A value is created the first time it is needed and reused after that.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) =>
      cls.members
        .filter((m) => (ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) && !!m.body)
        .filter((m) => {
          const body = text((m as ts.MethodDeclaration).body);
          const field = /this\.(\w+)\s*\?\?=/.exec(body)?.[1] ?? /if\s*\(\s*!this\.(\w+)\s*\)/.exec(body)?.[1];
          return !!field && body.includes(`return this.${field}`);
        })
        .map((m) => ({ node: m, evidence: `${className(cls)}.${nameOf(m)} creates its value on first use`, subject: className(cls) })),
    ),
});

catalog.push({
  name: 'Middleware',
  meaning: 'Each function handles a request and calls next() to pass it on, forming a pipeline (Express, Koa, Redux).',
  detect: (sf) =>
    functionsIn(sf)
      .filter(({ fn }) => fn.parameters.length >= 2 && text(fn.parameters[fn.parameters.length - 1].name) === 'next' && text(fn.body).includes('next('))
      .map(({ name, fn }) => ({ node: fn, evidence: `${name}(…, next) handles the request and passes it on with next()` })),
});

catalog.push({
  name: 'Retry',
  meaning: 'A failing operation is tried again, usually waiting longer between attempts.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => {
      let found = false;
      walk(fn.body ?? fn, (node) => {
        if ((ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && /try\s*\{[\s\S]*await[\s\S]*\}\s*catch/.test(text(node.statement))) {
          found = true;
        }
      });
      return found ? [{ node: fn, evidence: `${name}() tries again in a loop when the awaited call fails` }] : [];
    }),
});

catalog.push({
  name: 'Debounce or throttle',
  meaning: 'Calls are delayed or dropped so a burst of events runs the work once.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => {
      const inner = returnsOf(fn.body).map(unwrap).find((e) => ts.isArrowFunction(e) || ts.isFunctionExpression(e));
      const body = text(inner);
      const kind = /clearTimeout/.test(body) && /setTimeout/.test(body) ? 'debounces' : /Date\.now\(\)|performance\.now\(\)/.test(body) && /return;|return\s*$/m.test(body) ? 'throttles' : undefined;
      return inner && kind ? [{ node: fn, evidence: `${name}() ${kind} the function it wraps` }] : [];
    }),
});

catalog.push({
  name: 'Circuit breaker',
  meaning: 'After repeated failures, calls are refused for a while instead of hitting a broken service.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const body = text(cls);
      return /['"]open['"]/.test(body) && /['"](closed|half-open)['"]/.test(body) && /fail\w*/i.test(body) ? [{ node: cls, evidence: `${className(cls)} opens after failures and refuses calls while open`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Context provider',
  meaning: 'A React context provides a value to every component below it without passing props.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && /(^|\.)createContext$/.test(text(node.expression))) {
        const context = ts.isVariableDeclaration(node.parent) ? nameOf(node.parent) : undefined;
        found.push({ node, evidence: `${context ?? 'a context'} provides a value to the components below its Provider`, subject: context });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Higher-order component',
  meaning: 'A function takes a component and returns a new component that renders it with extra props or behavior.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => {
      const component = fn.parameters.map((p) => text(p.name)).find((p) => /^[A-Z]/.test(p));
      const returned = returnsOf(fn.body).map(unwrap).find((e) => ts.isArrowFunction(e) || ts.isFunctionExpression(e));
      return component && returned && new RegExp(`<${component}[\\s/>]`).test(text(returned)) ? [{ node: fn, evidence: `${name}() wraps ${component} in a new component` }] : [];
    }),
});

catalog.push({
  name: 'Render props',
  meaning: 'A component receives a function that decides what to render, sharing its logic with the caller.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && (ts.isArrowFunction(node.initializer.expression) || ts.isFunctionExpression(node.initializer.expression)) && containsJsx(node.initializer.expression)) {
        found.push({ node, evidence: `the ${text(node.name)} prop is a function that renders` });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Custom hook',
  meaning: 'Reusable stateful logic in a use… function that other components call.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => {
      if (!/^use[A-Z]/.test(name)) return [];
      const hooks = new Set<string>();
      walk(fn.body ?? fn, (node) => {
        if (ts.isCallExpression(node) && /^use[A-Z]/.test(text(node.expression).replace(/^React\./, ''))) hooks.add(text(node.expression));
      });
      return hooks.size ? [{ node: fn, evidence: `${name}() packages ${[...hooks].slice(0, 3).join(', ')} for reuse` }] : [];
    }),
});
