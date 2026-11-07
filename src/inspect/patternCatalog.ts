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

catalog.push({
  name: 'Store',
  meaning: 'Application state lives in one store that components read from and dispatch changes to.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && /^(createStore|configureStore|createSlice|defineStore|makeAutoObservable|makeObservable|createSignal|writable|atom)$/.test(text(node.expression))) {
        found.push({ node, evidence: `${text(node.expression)}() creates shared application state` });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Service locator',
  meaning: 'Objects are registered under keys and looked up when needed, instead of being passed in.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const map = fieldsOf(cls).find((f) => /Map</.test(f.type + f.init));
      const registers = map && methodsOf(cls).some((m) => text(m.body).includes(`this.${map.name}.set(`));
      const resolves = map && methodsOf(cls).find((m) => new RegExp(`this\\.${map.name}\\.get\\([^)]*\\)!?\\(`).test(text(m.body)));
      return registers && resolves ? [{ node: cls, evidence: `${className(cls)} registers factories in ${map!.name} and ${nameOf(resolves)}() creates them`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Null object',
  meaning: 'A do-nothing implementation stands in for a missing object, so callers need no null checks.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const [iface] = heritage(cls, ts.SyntaxKind.ImplementsKeyword);
      const methods = methodsOf(cls);
      const empty = methods.every((m) => m.body!.statements.length === 0 || (m.body!.statements.length === 1 && ts.isReturnStatement(m.body!.statements[0]) && (!m.body!.statements[0].expression || ts.isLiteralExpression(m.body!.statements[0].expression) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(m.body!.statements[0].expression.kind))));
      return iface && methods.length >= 2 && empty ? [{ node: cls, evidence: `${className(cls)} implements ${iface} by doing nothing`, subject: iface }] : [];
    }),
});

catalog.push({
  name: 'Value object',
  meaning: 'An immutable object compared by its values, such as Money or a date range.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const fields = fieldsOf(cls);
      const equals = methodsOf(cls).find((m) => nameOf(m) === 'equals');
      return equals && fields.length >= 2 && fields.every((f) => f.readonly) ? [{ node: cls, evidence: `${className(cls)} is immutable and compared with equals()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Module pattern',
  meaning: 'A function runs once and returns an object, keeping its variables private.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callee = unwrap(node.initializer.expression);
        if ((ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) && returnsOf(callee.body).some((e) => ts.isObjectLiteralExpression(unwrap(e)))) {
          found.push({ node, evidence: `${nameOf(node)} is built by a function that runs once and keeps its variables private` });
        }
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Fluent interface',
  meaning: 'Methods return the object itself, so calls chain into readable sentences.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const fluent = methodsOf(cls).filter((m) => returnsOf(m.body).some((e) => unwrap(e).kind === ts.SyntaxKind.ThisKeyword));
      const build = methodsOf(cls).some((m) => nameOf(m) === 'build');
      return fluent.length >= 3 && !build ? [{ node: cls, evidence: `${className(cls)}: ${fluent.map((m) => `${nameOf(m)}()`).slice(0, 4).join(', ')} return this for chaining`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Promise chain',
  meaning: 'Asynchronous steps are linked with .then(), each receiving the previous result.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then' && ts.isCallExpression(node.expression.expression) && ts.isPropertyAccessExpression(node.expression.expression.expression) && node.expression.expression.expression.name.text === 'then' && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'then')) {
        found.push({ node, evidence: `${(text(node).match(/\.then\(/g) ?? []).length} steps linked with .then()` });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Mixin',
  meaning: 'A function adds methods to any class by returning a subclass of the class it is given.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => {
      const base = fn.parameters[0] && text(fn.parameters[0].name);
      const mixed = base && returnsOf(fn.body).map(unwrap).find((e) => ts.isClassExpression(e) && heritage(e, ts.SyntaxKind.ExtendsKeyword).includes(base));
      return mixed ? [{ node: fn, evidence: `${name}() adds members to any class passed as ${base}` }] : [];
    }),
});

catalog.push({
  name: 'Abstract factory',
  meaning: 'Families of related objects are created through one interface, so the concrete classes can be swapped together.',
  detect: (sf) => {
    const byInterface = new Map<string, ts.ClassLikeDeclaration[]>();
    for (const cls of classesIn(sf)) {
      const creators = methodsOf(cls).filter((m) => returnsOf(m.body).some((e) => ts.isNewExpression(unwrap(e))));
      if (creators.length < 2) continue;
      for (const iface of heritage(cls, ts.SyntaxKind.ImplementsKeyword)) byInterface.set(iface, [...(byInterface.get(iface) ?? []), cls]);
    }
    return [...byInterface].filter(([, classes]) => classes.length >= 2).map(([iface, classes]) => ({ node: classes[0], evidence: `${classes.map(className).join(', ')} each create a family of objects for ${iface}`, subject: iface }));
  },
});

catalog.push({
  name: 'Barrel module',
  meaning: 'A file that only re-exports other modules, so importers use one short path.',
  detect: (sf) => {
    const reexports = sf.statements.filter((s) => ts.isExportDeclaration(s) && !!s.moduleSpecifier);
    return reexports.length >= 2 && reexports.length === sf.statements.filter((s) => !ts.isEmptyStatement(s)).length ? [{ node: sf.statements[0], evidence: `this file re-exports ${reexports.length} modules` }] : [];
  },
});

catalog.push({
  name: 'Result type',
  meaning: 'Success and failure are values of one union type, checked by a flag instead of thrown.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (!ts.isTypeAliasDeclaration(node) || !ts.isUnionTypeNode(node.type) || node.type.types.length < 2) return;
      const flags = node.type.types.map((t) => (ts.isTypeLiteralNode(t) ? t.members.find((m) => ts.isPropertySignature(m) && /^(ok|success|isOk|isErr|kind|status)$/.test(nameOf(m) ?? '') && !!m.type && ts.isLiteralTypeNode(m.type)) : undefined));
      if (flags.every(Boolean)) found.push({ node, evidence: `${node.name.text} is a union told apart by ${nameOf(flags[0])}`, subject: node.name.text });
    });
    return found;
  },
});

catalog.push({
  name: 'Plugin registry',
  meaning: 'Plugins are registered in a list and each one is called in turn, so features can be added without changing the core.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const list = fieldsOf(cls).find((f) => /\[\]|Array</.test(f.type + f.init) && methodsOf(cls).some((m) => text(m.body).includes(`this.${f.name}.push(`)));
      const runs = list && methodsOf(cls).find((m) => new RegExp(`this\\.${list.name}\\.forEach\\(\\s*\\(?\\s*(\\w+)\\s*\\)?\\s*=>\\s*\\1\\.\\w+\\(`).test(text(m.body)) || new RegExp(`for \\(const (\\w+) of this\\.${list.name}\\)[\\s\\S]*\\1\\.\\w+\\(`).test(text(m.body)));
      return list && runs ? [{ node: cls, evidence: `${className(cls)} keeps plugins in ${list.name} and ${nameOf(runs)}() calls each one`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'API client',
  meaning: 'One class wraps the HTTP calls to a service, so the rest of the code never builds requests itself.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const calls = methodsOf(cls).filter((m) => /\b(fetch|axios(\.\w+)?|this\.(http|client|api)\.\w+|ky(\.\w+)?|got)\(/.test(text(m.body)));
      return calls.length >= 2 ? [{ node: cls, evidence: `${className(cls)} wraps ${calls.length} HTTP calls: ${calls.slice(0, 3).map((m) => `${nameOf(m)}()`).join(', ')}`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Module-level singleton',
  meaning: 'A module exports one ready-made instance that every importer shares.',
  detect: (sf) =>
    sf.statements.flatMap((s) => {
      if (!ts.isVariableStatement(s) || !s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
      return s.declarationList.declarations
        .filter((d) => d.initializer && ts.isNewExpression(d.initializer) && !/^(Map|Set|WeakMap|WeakSet|Array|Date|Error|RegExp|Promise|URL|URLSearchParams|Intl\.\w+)$/.test(text(d.initializer.expression)))
        .map((d) => ({ node: d, evidence: `${nameOf(d)} is one shared ${text((d.initializer as ts.NewExpression).expression)} for every importer`, subject: text((d.initializer as ts.NewExpression).expression) }));
    }),
});

catalog.push({
  name: 'Strategy map',
  meaning: 'An object maps keys to functions and the code picks one at run time, instead of a long if or switch.',
  detect: (sf) =>
    sf.statements.flatMap((s) => {
      if (!ts.isVariableStatement(s)) return [];
      return s.declarationList.declarations.flatMap((d) => {
        const name = nameOf(d);
        const init = d.initializer && unwrap(d.initializer);
        if (!name || !init || !ts.isObjectLiteralExpression(init)) return [];
        const functions = init.properties.filter((p) => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))));
        return functions.length >= 3 && new RegExp(`\\b${name}\\[[^\\]]+\\]\\s*\\(`).test(sf.text) ? [{ node: d, evidence: `${name} holds ${functions.length} functions chosen by key`, subject: name }] : [];
      });
    }),
});

catalog.push({
  name: 'State machine',
  meaning: 'Explicit states and the events that move between them, such as an XState machine or a transition table.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && /(^|\.)(createMachine|setup)$/.test(text(node.expression))) {
        found.push({ node, evidence: `${text(node.expression)}() defines states and transitions` });
      } else if (ts.isObjectLiteralExpression(node) && node.properties.some((p) => nameOf(p) === 'states' && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer) && /\bon\s*:/.test(text(p.initializer)))) {
        found.push({ node, evidence: 'a table of states, each with the events it handles' });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Specification',
  meaning: 'Business rules are objects with isSatisfiedBy(), combined with and, or and not.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const check = methodsOf(cls).find((m) => nameOf(m) === 'isSatisfiedBy');
      return check ? [{ node: check, evidence: `${className(cls)} is a rule checked with isSatisfiedBy()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Unit of work',
  meaning: 'Changes are collected and then saved together, or all thrown away.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const names = methodsOf(cls).map(nameOf);
      return names.includes('commit') && names.includes('rollback') ? [{ node: cls, evidence: `${className(cls)} saves its changes together with commit() or drops them with rollback()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Discriminated union',
  meaning: 'A union of object types told apart by one literal field, such as kind, so a switch on it narrows to the right shape.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (!ts.isTypeAliasDeclaration(node) || !ts.isUnionTypeNode(node.type) || node.type.types.length < 2) {
        return;
      }
      const shapes = node.type.types.filter(ts.isTypeLiteralNode);
      if (shapes.length !== node.type.types.length) {
        return;
      }
      // A field every member has, each time with a literal type.
      const literalFields = (shape: ts.TypeLiteralNode) =>
        shape.members.filter((m): m is ts.PropertySignature => ts.isPropertySignature(m) && !!m.type && ts.isLiteralTypeNode(m.type)).map((m) => text(m.name));
      const tag = literalFields(shapes[0]).find((field) => shapes.every((s) => literalFields(s).includes(field)));
      if (tag) {
        found.push({ node, evidence: `${node.name.text} is told apart by its ${tag} field`, subject: node.name.text });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Type guard',
  meaning: 'A function returning "x is T" checks a value at run time and narrows its type for the code after the check.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) =>
      fn.type && ts.isTypePredicateNode(fn.type) && !fn.type.assertsModifier && fn.type.type ? [{ node: fn, evidence: `${name}() narrows ${text(fn.type.parameterName)} to ${text(fn.type.type)}`, subject: text(fn.type.type) }] : [],
    ),
});

catalog.push({
  name: 'Assertion function',
  meaning: 'A function declared with "asserts" throws when a condition fails, so the code after the call can rely on it.',
  detect: (sf) =>
    functionsIn(sf).flatMap(({ name, fn }) => (fn.type && ts.isTypePredicateNode(fn.type) && fn.type.assertsModifier ? [{ node: fn, evidence: `${name}() throws unless ${text(fn.type.parameterName)}${fn.type.type ? ` is ${text(fn.type.type)}` : ' holds'}` }] : [])),
});

catalog.push({
  name: 'Branded type',
  meaning: 'A primitive type is combined with a marker so that, for example, a UserId cannot be passed where an OrderId is expected.',
  detect: (sf) => {
    const found: Found[] = [];
    const primitive = new Set([ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BigIntKeyword]);
    walk(sf, (node) => {
      if (ts.isTypeAliasDeclaration(node) && ts.isIntersectionTypeNode(node.type)) {
        const base = node.type.types.find((t) => primitive.has(t.kind));
        const marker = node.type.types.find((t) => ts.isTypeLiteralNode(t) || (ts.isTypeReferenceNode(t) && /brand|tag/i.test(text(t.typeName))));
        if (base && marker) {
          found.push({ node, evidence: `${node.name.text} is a ${text(base)} that only matches values marked as ${node.name.text}`, subject: node.name.text });
        }
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Constant object as enum',
  meaning: 'An object frozen with "as const" lists the allowed values, and a type derived from it accepts only those values.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isAsExpression(node.initializer) && text(node.initializer.type) === 'const' && ts.isObjectLiteralExpression(node.initializer.expression)) {
        const name = nameOf(node);
        // The derived type: typeof X[keyof typeof X].
        if (name && new RegExp(`keyof\\s+typeof\\s+${name}\\b`).test(sf.text)) {
          found.push({ node, evidence: `${name} lists the allowed values, and its type accepts only those`, subject: name });
        }
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Exhaustive check',
  meaning: 'A value is assigned to "never" where every case should be handled, so adding a case without handling it is a compile error.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && node.type?.kind === ts.SyntaxKind.NeverKeyword && node.initializer) {
        found.push({ node, evidence: `${text(node.initializer)} must be never here, so every case is handled` });
      } else if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) && node.parameters.length === 1 && node.parameters[0].type?.kind === ts.SyntaxKind.NeverKeyword) {
        const name = ts.isFunctionDeclaration(node) ? nameOf(node) : ts.isVariableDeclaration(node.parent) ? nameOf(node.parent) : undefined;
        found.push({ node, evidence: `${name ?? 'a function'}() accepts only never, so calling it marks the cases as all handled` });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Mediator',
  meaning: 'Objects talk to one coordinator instead of to each other; it decides who reacts to what.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const colleagues = fieldsOf(cls).filter((f) => /^[A-Z]/.test(f.type));
      // notify(sender, event): the colleagues report to the mediator, which routes the event.
      const notify = methodsOf(cls).find((m) => m.parameters.length >= 2 && /^(notify|mediate|send|relay)$/.test(nameOf(m) ?? ''));
      return colleagues.length >= 2 && notify ? [{ node: cls, evidence: `${className(cls)} coordinates ${colleagues.map((c) => c.name).join(', ')} through ${nameOf(notify)}()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Memento',
  meaning: 'An object can save a snapshot of its state and restore it later, as for undo, without exposing its internals.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const methods = methodsOf(cls);
      const save = methods.find((m) => /^(save|snapshot|createMemento|capture|checkpoint)$/.test(nameOf(m) ?? '') && returnsOf(m.body).length > 0);
      const restore = methods.find((m) => /^(restore|undo|rollbackTo|restoreFrom)$/.test(nameOf(m) ?? '') && m.parameters.length === 1);
      return save && restore ? [{ node: cls, evidence: `${className(cls)} saves its state with ${nameOf(save)}() and restores it with ${nameOf(restore)}()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Flyweight',
  meaning: 'Identical objects are created once and shared by key, so many uses cost one instance.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      // cache.set(key, new Glyph(...)) next to cache.get(key): one instance per key, handed out again.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set' && node.arguments.length === 2 && ts.isNewExpression(node.arguments[1])) {
        const owner = text(node.expression.expression);
        const fn = enclosing(node);
        if (fn && new RegExp(`${owner.replace(/[.$]/g, '\\$&')}\\.get\\(`).test(text(fn))) {
          found.push({ node, evidence: `${text(node.arguments[1].expression)} instances are shared by key through ${owner}`, subject: text(node.arguments[1].expression) });
        }
      }
    });
    return found;
  },
});

function enclosing(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) {
      return n as ts.FunctionLikeDeclaration;
    }
  }
  return undefined;
}

catalog.push({
  name: 'Bridge',
  meaning: 'An abstraction holds an implementation behind an interface, so both sides can have their own subclasses and vary independently.',
  detect: (sf) => {
    const classes = classesIn(sf);
    const interfaces = new Set<string>();
    walk(sf, (node) => ts.isInterfaceDeclaration(node) && interfaces.add(node.name.text));
    return classes.flatMap((cls) => {
      const name = className(cls);
      const refined = classes.filter((c) => heritage(c, ts.SyntaxKind.ExtendsKeyword).includes(name));
      const implementation = fieldsOf(cls).find((f) => interfaces.has(f.type));
      const implementors = implementation ? classes.filter((c) => heritage(c, ts.SyntaxKind.ImplementsKeyword).includes(implementation.type)) : [];
      return refined.length && implementation && implementors.length >= 2
        ? [{ node: cls, evidence: `${name} (refined by ${refined.map(className).join(', ')}) works through ${implementation.type} (${implementors.map(className).join(', ')})`, subject: name }]
        : [];
    });
  },
});

catalog.push({
  name: 'Compound components',
  meaning: 'A component exposes its parts as properties, such as Tabs.Panel, which work together through shared state.',
  detect: (sf) => {
    const components = new Set(functionsIn(sf).map((f) => f.name).filter((n) => /^[A-Z]/.test(n)));
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && /^[A-Z]/.test(node.left.name.text) && components.has(text(node.left.expression))) {
        found.push({ node, evidence: `${text(node.left)} is a part of ${text(node.left.expression)}`, subject: text(node.left.expression) });
      } else if (ts.isCallExpression(node) && text(node.expression) === 'Object.assign' && node.arguments.length === 2 && components.has(text(node.arguments[0])) && ts.isObjectLiteralExpression(node.arguments[1])) {
        found.push({ node, evidence: `${text(node.arguments[0])} carries its parts ${node.arguments[1].properties.map((p) => nameOf(p) ?? text(p)).join(', ')}`, subject: text(node.arguments[0]) });
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Error boundary',
  meaning: 'A class component catches rendering errors in the components below it and shows a fallback instead of a blank page.',
  detect: (sf) =>
    classesIn(sf).flatMap((cls) => {
      const catcher = cls.members.find((m) => /^(componentDidCatch|getDerivedStateFromError)$/.test(nameOf(m) ?? ''));
      return catcher ? [{ node: cls, evidence: `${className(cls)} catches errors from its children with ${nameOf(catcher)}()`, subject: className(cls) }] : [];
    }),
});

catalog.push({
  name: 'Controlled component',
  meaning: 'A form field shows a value from state and reports every change, so React state is the single source of truth.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && /^(input|select|textarea)$/.test(text(node.tagName))) {
        const props = node.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? text(p.name) : ''));
        const shown = props.find((p) => p === 'value' || p === 'checked');
        if (shown && props.includes('onChange')) {
          found.push({ node, evidence: `the <${text(node.tagName)}> shows ${shown} from state and reports changes through onChange` });
        }
      }
    });
    return found;
  },
});

catalog.push({
  name: 'Memoized component',
  meaning: 'A component wrapped in memo() skips re-rendering when its props have not changed.',
  detect: (sf) => {
    const found: Found[] = [];
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && /^(React\.)?memo$/.test(text(node.expression)) && node.arguments.length >= 1) {
        const name = ts.isVariableDeclaration(node.parent) ? nameOf(node.parent) : undefined;
        found.push({ node, evidence: `${name ?? text(node.arguments[0]).slice(0, 30)} re-renders only when its props change`, subject: name });
      }
    });
    return found;
  },
});
