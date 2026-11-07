/**
 * Plain-language explanations of the JavaScript, TypeScript and React terms that result rows use,
 * such as "destructured" or "?.". A row whose label (or else description) matches a term gets a ? button.
 */
export interface Term {
  /** The name shown as the explanation's title, such as "Destructuring". */
  term: string;
  /** Tested against the row's label, then its description. */
  match: RegExp;
  meaning: string;
  example?: string;
  url: string;
}

export const glossary: Term[] = [];

const mdn = (page: string) => `https://developer.mozilla.org/en-US/docs/Web/JavaScript/${page}`;
const tsHandbook = (page: string) => `https://www.typescriptlang.org/docs/handbook/${page}`;

/** The term a row is about, if any: the first entry matching its label, else its description. */
export function termFor(label: string, description = ''): Term | undefined {
  return glossary.find((t) => t.match.test(label)) ?? (description ? glossary.find((t) => t.match.test(description)) : undefined);
}

// --- Data Flow --------------------------------------------------------------------
glossary.push(
  {
    term: 'Destructuring',
    match: /^destructured\b/,
    meaning: 'The value is unpacked from an object or array into its own variable, such as badge from a component\'s props. It is undefined when the object has no such property, unless a default is given.',
    example: 'function Card({ title, badge = null }) { … }\nconst [first, second] = list;',
    url: mdn('Reference/Operators/Destructuring'),
  },
  {
    term: 'Declaration',
    match: /^declared\b/,
    meaning: 'Where the variable is created with let, const, var or as a parameter. "Declared without a value" means it starts as undefined.',
    example: 'let total = 0;\nconst user = await load();',
    url: mdn('Reference/Statements/let'),
  },
  {
    term: 'Parameter',
    match: /^parameter\b/,
    meaning: 'A name in a function\'s parameter list. Its value is whatever each caller passes, so Data Flow lists the call sites under Flows in.',
    example: 'function charge(payment: PaymentMethod) { … }',
    url: 'https://developer.mozilla.org/en-US/docs/Glossary/Parameter',
  },
  {
    term: 'Assignment',
    match: /^assigned by\b/,
    meaning: 'The variable gets a new value with =, or with a compound operator such as += that reads it and writes it back.',
    example: 'total = 0;\ntotal += item.price;',
    url: mdn('Reference/Operators/Assignment'),
  },
  {
    term: 'for…of loop',
    match: /^each item of\b/,
    meaning: 'The variable takes each item of an array, string, Map or other iterable in turn.',
    example: 'for (const item of cart.items) { … }',
    url: mdn('Reference/Statements/for...of'),
  },
  {
    term: 'delete',
    match: /^deleted\b/,
    meaning: 'The delete operator removes a property from an object; reading it afterwards gives undefined.',
    example: 'delete session.token;',
    url: mdn('Reference/Operators/delete'),
  },
  {
    term: 'Mutation',
    match: /^(mutated\b|\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)\()/,
    meaning: 'The object is changed in place, for example by push() or by setting a property. Every variable that refers to the same object sees the change.',
    example: 'cart.items.push(item);\nuser.name = "Ada";',
    url: 'https://developer.mozilla.org/en-US/docs/Glossary/Mutable',
  },
  {
    term: 'Copying a reference',
    match: /^copied to\b/,
    meaning: 'The value is assigned to another variable. For objects and arrays both names then refer to the same object, so a change through one is visible through the other.',
    example: 'const draft = order; // same object, not a copy',
    url: 'https://javascript.info/object-copy',
  },
  {
    term: 'Object property',
    match: /^object property\b/,
    meaning: 'The value is stored as a property of a new object, often with the shorthand { name } for { name: name }.',
    example: 'return { total, items };',
    url: mdn('Reference/Operators/Object_initializer'),
  },
  {
    term: 'return',
    match: /^returned from\b/,
    meaning: 'The value leaves the function as its result, so it flows on to whatever the caller does with it.',
    example: 'return receipt;',
    url: mdn('Reference/Statements/return'),
  },
  {
    term: 'Narrowing',
    match: /^checked\b/,
    meaning: 'A condition such as if (x), typeof x === "string" or x instanceof Error. Inside it TypeScript knows more about the value, for example that it is not undefined.',
    example: 'if (coupon) { apply(coupon); }',
    url: tsHandbook('2/narrowing.html'),
  },
  {
    term: 'Function call',
    match: /^called\b/,
    meaning: 'The value is a function and is called here, so what it does runs at this line.',
    example: 'onSave(order);',
    url: mdn('Guide/Functions'),
  },
  {
    term: 'Passing a prop',
    match: /^→ prop\b/,
    meaning: 'The value is passed to a React component as a prop (an attribute in JSX), so it becomes that component\'s input.',
    example: '<Card badge={badge} />',
    url: 'https://react.dev/learn/passing-props-to-a-component',
  },
  {
    term: 'Passing an argument',
    match: /^→ .*\(/,
    meaning: 'The value is passed to a function call as an argument; inside the function it becomes the matching parameter. Trace This Value follows it there.',
    example: 'saveOrder(id, total);',
    url: mdn('Guide/Functions'),
  },
);

// --- Nullability ---------------------------------------------------------------------
glossary.push(
  {
    term: 'Index lookup',
    match: /^index lookup\b/,
    meaning: 'Reading array[i] or record[key] gives undefined when there is no item at that index or key, even when the type does not say so. The noUncheckedIndexedAccess option makes TypeScript include undefined.',
    example: 'const first = items[0]; // undefined when items is empty',
    url: 'https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess',
  },
  {
    term: 'Optional property or parameter',
    match: /is an optional (property|parameter)\b|omits the argument/,
    meaning: 'A name declared with ? may be left out, and is then undefined. Callers that omit the argument, and objects without the property, produce undefined.',
    example: 'function greet(name?: string) { … }\ninterface Props { badge?: ReactNode }',
    url: 'https://www.typescriptlang.org/docs/handbook/2/objects.html',
  },
  {
    term: 'Type that includes null or undefined',
    match: /^declared as\b/,
    meaning: 'The declared type is a union with null or undefined, such as string | undefined, so TypeScript requires a check before use.',
    example: 'let user: User | null = null;',
    url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html',
  },
  {
    term: 'Declared without a value',
    match: /declared without a value|^no initializer/,
    meaning: 'A variable declared without = starts as undefined until something assigns it.',
    example: 'let total: number; // undefined here',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/let',
  },
  {
    term: 'Falsy value',
    match: /is falsy$/,
    meaning: 'false, 0, "", null, undefined and NaN count as false in a condition, so a || b uses b for all of them, not only for null and undefined.',
    example: 'count || 10 // 10 also when count is 0',
    url: 'https://developer.mozilla.org/en-US/docs/Glossary/Falsy',
  },
  {
    term: 'Nullish coalescing (??)',
    match: /\?\?/,
    meaning: 'a ?? b gives b only when a is null or undefined. Unlike ||, it keeps 0, "" and false.',
    example: 'const size = options.size ?? 10;',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing',
  },
  {
    term: 'Optional chaining (?.)',
    match: /\?\./,
    meaning: 'a?.b gives undefined instead of throwing when a is null or undefined; the rest of the chain is skipped.',
    example: 'user?.address?.city',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining',
  },
  {
    term: 'Logical OR (||)',
    match: /\|\|/,
    meaning: 'a || b gives b when a is falsy (null, undefined, 0, "", false). Use ?? to fall back only on null and undefined.',
    example: "const label = badge || 'none';",
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Logical_OR',
  },
  {
    term: 'Non-null assertion (!)',
    match: /\w!($|[.\[)])/,
    meaning: 'value! tells TypeScript the value is not null or undefined without checking. If it is, the next property access throws at run time.',
    example: 'document.getElementById("app")!.focus();',
    url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#non-null-assertion-operator-postfix-',
  },
  {
    term: 'JSX expression',
    match: /^\{.+\}$/,
    meaning: 'Curly braces in JSX insert a JavaScript value into the markup. null and undefined render nothing, which can hide a missing value.',
    example: '<span>{badge}</span>',
    url: 'https://react.dev/learn/javascript-in-jsx-with-curly-braces',
  },
);

// --- Side Effects --------------------------------------------------------------------
glossary.push(
  {
    term: 'Input/output',
    match: /^Input\/output$/,
    meaning: 'The function talks to the world outside the program: network, files, storage, the console or the DOM. Results can differ between runs, and calls may be slow or fail.',
    example: 'await fetch("/api/orders");\nlocalStorage.setItem("cart", json);',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
  },
  {
    term: 'Scheduled work',
    match: /^Schedules work$/,
    meaning: 'The function asks for code to run later with setTimeout, setInterval or requestAnimationFrame. That code runs after the function has returned.',
    example: 'setTimeout(() => save(), 500);',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout',
  },
  {
    term: 'Nondeterministic',
    match: /^Nondeterministic$/,
    meaning: 'The result can differ between calls with the same arguments, for example because of Math.random(), Date.now() or new Date(). Tests need to control these values.',
    example: 'const id = Math.random().toString(36);',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random',
  },
  {
    term: 'Global state',
    match: /^(Uses global state|Writes globals)$/,
    meaning: 'window, globalThis, document and similar objects are shared by all code on the page; reading them couples the function to that state, writing them affects everyone.',
    example: 'window.currentUser = user;',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/globalThis',
  },
  {
    term: 'Calls it could not follow',
    match: /^Calls it could not follow$/,
    meaning: 'Calls to functions whose code is not in the project or cannot be resolved, such as a callback passed in. They may have side effects of their own.',
    example: 'options.onDone(result);',
    url: 'https://en.wikipedia.org/wiki/Side_effect_%28computer_science%29',
  },
);

// --- Mutation Tracking ---------------------------------------------------------------
glossary.push(
  {
    term: 'Mutating an argument',
    match: /^Mutates arguments$/,
    meaning: 'The function changes an object a caller passed in, so the caller sees the change after the call. Returning a changed copy avoids that.',
    example: 'function addItem(cart, item) { cart.items.push(item); }',
    url: 'https://developer.mozilla.org/en-US/docs/Glossary/Mutable',
  },
  {
    term: 'Mutating the instance',
    match: /^Mutates the instance$/,
    meaning: 'A method changes a field of this, which every user of the same object sees.',
    example: 'this.count++;',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/this',
  },
  {
    term: 'Module state',
    match: /^Mutates module state$|module-level/,
    meaning: 'A variable at the top of a module is created once and shared by every function and caller that uses the module.',
    example: 'let cache = new Map();\nexport function remember(k, v) { cache.set(k, v); }',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules',
  },
  {
    term: 'Mutating an import',
    match: /^Mutates imported state$/,
    meaning: 'The function changes an object that another module exports, so every module importing it sees the change.',
    example: "import { settings } from './config';\nsettings.debug = true;",
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import',
  },
  {
    term: 'Captured variable',
    match: /^Mutates captured variables$|captured by inner functions/,
    meaning: 'An inner function (a closure) changes a variable of the function around it. Every closure created by that call shares the variable.',
    example: 'function counter() { let n = 0; return () => ++n; }',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures',
  },
);

// --- Race Conditions -----------------------------------------------------------------
glossary.push(
  {
    term: 'Lost update',
    match: /^Lost update$/,
    meaning: 'A function reads shared state, waits at an await, then writes it back. Another call that changed the state during the wait has its change overwritten. Read the value after the await instead.',
    example: 'total += await price(id); // reads total before waiting\nconst p = await price(id); total += p; // safe',
    url: 'https://en.wikipedia.org/wiki/Race_condition',
  },
  {
    term: 'Check, then act',
    match: /^Check, then act$/,
    meaning: 'A function checks shared state, awaits, then acts on the check. Two calls can both pass the check before either acts, for example loading the same thing twice. Keep the pending promise instead.',
    example: 'if (!cache) cache = await load();\n// instead: cachePromise ??= load();',
    url: 'https://en.wikipedia.org/wiki/Race_condition',
  },
  {
    term: 'Several async writers',
    match: /^Several async writers$/,
    meaning: 'Several async functions or callbacks replace the value, and they can finish in any order, so the final value depends on timing.',
    example: 'onSearch: results = await search(q); // an older search can finish last',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await',
  },
  {
    term: 'await',
    match: /^waits here:|after an await/,
    meaning: 'await pauses the async function until the promise settles. Other code, including other calls of the same function, runs during the pause.',
    example: 'const user = await loadUser(id);',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await',
  },
);

// --- Promise Rejections --------------------------------------------------------------
glossary.push(
  {
    term: 'Unhandled rejection',
    match: /^Unhandled$/,
    meaning: 'A rejected promise that nothing awaits in a try block or handles with .catch(). Node.js stops the process by default; browsers log an error and the failure is lost.',
    example: 'save(order); // not awaited, no .catch()',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event',
  },
  {
    term: '.catch()',
    match: /^\.catch\(/,
    meaning: ".catch(handler) runs the handler when the promise rejects and returns a new promise that fulfills with the handler's result, so the error stops there unless the handler rethrows.",
    example: 'load().catch((e) => report(e));',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/catch',
  },
  {
    term: 'catch block',
    match: /^catch\b|^caught in\b/,
    meaning: 'An error thrown in a try block, or a rejection awaited there, goes to its catch block. Without a rethrow, it ends there.',
    example: 'try { await save(); } catch (e) { show(e); }',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/try...catch',
  },
  {
    term: 'Rejection source',
    match: /^Rejection sources$/,
    meaning: 'What can make the promise reject: throw statements and awaited calls that can reject, outside any try/catch.',
    example: 'async function f() { await fetch(url); throw new Error(); }',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise',
  },
);
