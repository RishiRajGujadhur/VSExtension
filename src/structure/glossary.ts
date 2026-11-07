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
    match: /^(mutated\b|\.\w+\()/,
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
