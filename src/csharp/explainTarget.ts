import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { FunctionFacts, FunctionInput } from '../explain/functionFacts';
import { csharpFunctionAt, functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';

/**
 * "Explain this code" in C#: what a highlight is about, from the bundled parser. A method's name, where it is
 * declared or called, means the whole method; so does its header or most of it. For the whole method it works out
 * what Explain shows for TypeScript: its signature, what it takes, what it gives back and what it changes outside
 * itself, from the syntax alone.
 */
export interface CSharpTarget {
  /** Where the function starts, for its flowchart. */
  offset: number;
  /** As charted: "OrderService.PlaceOrderAsync". */
  chartName: string;
  /** Its own name: "PlaceOrderAsync". */
  name: string;
  /** "method", "constructor", "local function", "property", "lambda". */
  kind: string;
  /** Its header on one line, up to the body: "public async Task<decimal> PlaceOrderAsync(string customer, string? coupon)". */
  head: string;
  /** Its code, for the purpose rules. */
  lines: string[];
  facts: FunctionFacts;
  /** "PlaceOrderAsync is an async method that takes the customer and the coupon and returns a decimal, once it finishes." */
  summary: string;
}

export type CSharpHighlight =
  | { whole: CSharpTarget }
  /** A name called here but declared in no function of this file: look for it elsewhere. */
  | { elsewhere: string }
  /** Some lines (in a function, when there is one). */
  | { lines: true; within?: string };

const declarationTypes = new Set(['method_declaration', 'local_function_statement', 'constructor_declaration']);

export async function csharpHighlight(code: string, start: number, end: number): Promise<CSharpHighlight> {
  const tree = await parseCSharp(code);
  try {
    const root = tree.rootNode;
    const selected = code.slice(start, end);
    const at = start + (selected.length - selected.trimStart().length);
    const word = selected.trim();
    // A name: the method it names.
    if (/^@?[A-Za-z_]\w*$/.test(word)) {
      const id = root.descendantForIndex(at, at + word.length);
      const named = id && (id.type === 'identifier' ? id : null);
      if (named) {
        const own = named.parent && declarationTypes.has(named.parent.type) && named.parent.childForFieldName('name')?.id === named.id ? named.parent : undefined;
        // A declaration with no body (an interface member, an abstract or partial method): its implementation.
        if (own && bodyOf(own)) return { whole: targetOf(own, code) };
        if (own) {
          const implementation = declarationNamed(root, named.text);
          return implementation ? { whole: targetOf(implementation, code) } : { elsewhere: named.text };
        }
        if (isCalled(named)) {
          const found = declarationNamed(root, named.text, named);
          return found ? { whole: targetOf(found, code) } : { elsewhere: named.text };
        }
      }
    }
    const fn = csharpFunctionAt(root, at);
    if (!fn) return { lines: true };
    const body = bodyOf(fn);
    const fnStart = fn.startIndex;
    const header = start >= fnStart && end <= (body?.startIndex ?? fn.endIndex);
    const most = (end - start) / Math.max(1, fn.endIndex - fnStart) >= 0.6;
    if (header || most || start <= fnStart + 1) return { whole: targetOf(fn, code) };
    return { lines: true, within: functionName(fn) };
  } finally {
    tree.delete();
  }
}

/** The offset of the method or local function with this name in the code, for a name found in another file. */
export async function csharpDeclarationOf(code: string, name: string): Promise<number | undefined> {
  if (!code.includes(name)) return undefined;
  const tree = await parseCSharp(code);
  try {
    const found = declarationNamed(tree.rootNode, name);
    return found?.childForFieldName('name')?.startIndex;
  } finally {
    tree.delete();
  }
}

/** The name is called: `Save(…)`, `cart.Price()`, `await SaveAsync(…)`, or passed as a method group. */
function isCalled(id: SyntaxNode): boolean {
  let n: SyntaxNode = id;
  if (n.parent?.type === 'member_access_expression' && n.parent.childForFieldName('name')?.id === n.id) n = n.parent;
  if (n.parent?.type === 'generic_name') n = n.parent;
  return n.parent?.type === 'invocation_expression' && n.parent.childForFieldName('function')?.id === n.id;
}

/** The method or local function named so: the one in the same class as `near` first, then any in the file. */
function declarationNamed(root: SyntaxNode, name: string, near?: SyntaxNode): SyntaxNode | undefined {
  const all = [...root.descendantsOfType('method_declaration'), ...root.descendantsOfType('local_function_statement')].filter((m): m is SyntaxNode => !!m && m.childForFieldName('name')?.text === name && !!bodyOf(m));
  if (!all.length) return undefined;
  const classOf = (n: SyntaxNode | null) => {
    for (let p = n; p; p = p.parent) if (/^(class|struct|record|interface)_declaration$/.test(p.type)) return p.id;
    return undefined;
  };
  const home = near ? classOf(near) : undefined;
  return all.find((m) => classOf(m) === home) ?? all[0];
}

function bodyOf(fn: SyntaxNode): SyntaxNode | undefined {
  return fn.childForFieldName('body') ?? fn.namedChildren.find((c) => c?.type === 'block' || c?.type === 'arrow_expression_clause') ?? undefined;
}

const oneLine = (text: string, max = 110) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function targetOf(fn: SyntaxNode, code: string): CSharpTarget {
  const body = bodyOf(fn);
  const chartName = functionName(fn);
  const name = fn.childForFieldName('name')?.text ?? chartName.replace(/^.*\./, '');
  const kind = fn.type === 'constructor_declaration' ? 'constructor' : fn.type === 'local_function_statement' ? 'local function' : fn.type === 'method_declaration' ? 'method' : /lambda|anonymous/.test(fn.type) ? 'lambda' : 'property';
  const head = oneLine(code.slice(fn.startIndex, body?.startIndex ?? fn.endIndex).replace(/\[[^\]]*\]\s*/g, ''));
  const facts = factsOf(fn, body);
  return { offset: fn.childForFieldName('name')?.startIndex ?? fn.startIndex, chartName, name, kind, head, lines: code.slice(fn.startIndex, fn.endIndex).split('\n'), facts, summary: summaryOf(fn, name, kind, facts) };
}

// ---------------------------------------------------------------------------------------------------------------
// Facts

function inputsOf(fn: SyntaxNode): FunctionInput[] {
  const list = fn.childForFieldName('parameters') ?? fn.namedChildren.find((c) => c?.type === 'parameter_list');
  if (!list) return [];
  return list.namedChildren
    .filter((p): p is SyntaxNode => p?.type === 'parameter')
    .map((p) => {
      const modifiers = p.namedChildren.filter((c) => c?.type === 'modifier' || c?.type === 'parameter_modifier').map((c) => c!.text);
      const type = p.childForFieldName('type')?.text;
      const name = p.childForFieldName('name')?.text ?? p.namedChildren.filter((c) => c?.type === 'identifier').pop()?.text ?? '?';
      const fallback = p.namedChildren.find((c) => c?.type === 'equals_value_clause')?.namedChildren[0]?.text ?? (/=\s*(.+)$/.exec(p.text)?.[1]?.trim());
      const passing = modifiers.filter((m) => ['ref', 'out', 'in', 'this'].includes(m));
      return {
        name,
        ...(type ? { type: [...passing, type].join(' ') } : {}),
        ...(fallback ? { defaultValue: oneLine(fallback, 30) } : {}),
        optional: !!fallback,
        rest: modifiers.includes('params'),
      };
    });
}

/** Task<T> and ValueTask<T> give T later; Task and ValueTask give nothing, later. */
function outputOf(fn: SyntaxNode, body: SyntaxNode | undefined): FunctionFacts['output'] {
  const declared = fn.childForFieldName('returns')?.text ?? fn.childForFieldName('type')?.text;
  const isAsync = fn.namedChildren.some((c) => c?.type === 'modifier' && c.text === 'async');
  let type = declared;
  let later = isAsync;
  const task = declared ? /^(?:System\.Threading\.Tasks\.)?(Value)?Task(?:<(.+)>)?$/.exec(declared) : null;
  if (task) {
    later = true;
    type = task[2];
  }
  const values: string[] = [];
  if (body?.type === 'arrow_expression_clause') {
    const expression = body.namedChildren[0];
    if (expression) values.push(oneLine(expression.text.replace(/^await\s+/, ''), 60));
  } else if (body) {
    const visit = (n: SyntaxNode) => {
      if (n.id !== fn.id && functionTypes.has(n.type)) return;
      if (n.type === 'return_statement' && n.namedChildren[0]) values.push(oneLine(n.namedChildren[0].text, 60));
      for (const c of n.namedChildren) if (c) visit(c);
    };
    visit(body);
  }
  const nothing = fn.type === 'constructor_declaration' || type === 'void' || (task !== null && !type) || (!type && !values.length);
  return { ...(type && type !== 'void' ? { type } : {}), later, values: nothing ? [] : [...new Set(values)].slice(0, 4), nothing };
}

/** What .NET's own types reach, by the start of a call: "Console.WriteLine" → "writes to the console". */
const BUILT_INS: [RegExp, string][] = [
  [/^Console\./, 'writes to the console'],
  [/^(File|Directory|Path|FileInfo|DirectoryInfo|StreamWriter|StreamReader)\b/, 'uses the file system'],
  [/(HttpClient|\b_?http\w*\.)|\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync|GetStringAsync|GetFromJsonAsync|PostAsJsonAsync)$/i, 'makes a network request'],
  [/\.SaveChanges(Async)?$/, 'saves to the database'],
  [/^(Task\.Delay|Thread\.Sleep)$/, 'waits'],
  [/^(DateTime\.(Now|UtcNow|Today)|DateTimeOffset\.(Now|UtcNow)|Stopwatch\.)/, 'reads the current time'],
  [/^(Random|Guid\.NewGuid)/, 'produces random values'],
  [/^Environment\./, 'reads the environment'],
  [/^Process\.Start$/, 'runs another program'],
  [/^(Debug|Trace)\.|\.(LogInformation|LogWarning|LogError|LogDebug|LogTrace|LogCritical|Log)$/, 'writes to the log'],
];

/** Methods that change the collection they are called on. */
const CHANGING = new Set(['Add', 'AddRange', 'Insert', 'InsertRange', 'Remove', 'RemoveAt', 'RemoveAll', 'RemoveRange', 'Clear', 'Push', 'Pop', 'Enqueue', 'Dequeue', 'Sort', 'Reverse', 'TryAdd', 'TryRemove', 'Append']);

function effectsOf(fn: SyntaxNode, body: SyntaxNode | undefined): string[] {
  if (!body) return [];
  // What the function owns: its parameters and the variables it declares.
  const locals = new Set<string>();
  const parameters = new Set(inputsOf(fn).map((i) => i.name));
  for (const d of body.descendantsOfType(['variable_declarator', 'foreach_statement', 'catch_declaration', 'declaration_expression'])) {
    const id = d?.childForFieldName('name') ?? d?.namedChildren.find((c) => c?.type === 'identifier');
    if (id) locals.add(id.text);
  }
  const out: string[] = [];
  const say = (what: string) => {
    if (!out.includes(what)) out.push(what);
  };
  /** The root of `a.b.c` (or `this`), and whether the function does not own it. */
  const outside = (target: SyntaxNode): boolean => {
    let root: SyntaxNode = target;
    while (root.type === 'member_access_expression' || root.type === 'element_access_expression') root = root.childForFieldName('expression') ?? root.namedChildren[0]!;
    if (root.type === 'this_expression' || root.type === 'this') return true;
    if (root.type !== 'identifier') return false;
    if (parameters.has(root.text)) return target.id !== root.id; // a parameter's member: the caller's object
    return !locals.has(root.text);
  };
  const calls: string[] = [];
  const visit = (n: SyntaxNode) => {
    if (n.id !== fn.id && (n.type === 'lambda_expression' || n.type === 'local_function_statement')) {
      for (const c of n.namedChildren) if (c) visit(c);
      return;
    }
    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left') ?? n.namedChildren[0];
      if (left && outside(left)) say(`changes ${oneLine(left.text, 40)}${parameters.has(rootName(left)) ? ' (an argument)' : ''}`);
    }
    if ((n.type === 'postfix_unary_expression' || n.type === 'prefix_unary_expression') && /\+\+|--/.test(n.text)) {
      const operand = n.namedChildren[0];
      if (operand && outside(operand)) say(`changes ${oneLine(operand.text, 40)} (${/\+\+/.test(n.text) ? '++' : '--'})`);
    }
    if (n.type === 'invocation_expression') {
      const callee = n.childForFieldName('function') ?? n.namedChildren[0];
      const text = callee ? callee.text.replace(/\s+/g, '') : '';
      const builtIn = BUILT_INS.find(([pattern]) => pattern.test(text));
      if (builtIn) say(builtIn[1]);
      else if (callee?.type === 'member_access_expression') {
        const method = callee.childForFieldName('name')?.text ?? '';
        const receiver = callee.childForFieldName('expression');
        if (CHANGING.has(method) && receiver && outside(receiver)) say(`changes ${oneLine(receiver.text, 40)} (${method})`);
      }
      // Called for what it does: its result unused.
      const statement = n.parent?.type === 'await_expression' ? n.parent.parent : n.parent;
      if (!builtIn && statement?.type === 'expression_statement' && !(callee?.type === 'member_access_expression' && CHANGING.has(callee.childForFieldName('name')?.text ?? '')) && text.length <= 40) {
        if (!calls.includes(`${text}()`)) calls.push(`${text}()`);
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(body);
  const listed = out.slice(0, calls.length ? 7 : 8);
  if (calls.length) {
    const shown = calls.length > 3 ? [...calls.slice(0, 3), `${calls.length - 3} more`] : calls;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
    listed.push(`calls ${list} for what ${calls.length > 1 ? 'they do' : 'it does'}, which may change things`);
  }
  return listed;
}

function rootName(target: SyntaxNode): string {
  let root: SyntaxNode = target;
  while (root.type === 'member_access_expression' || root.type === 'element_access_expression') root = root.childForFieldName('expression') ?? root.namedChildren[0]!;
  return root.text;
}

function factsOf(fn: SyntaxNode, body: SyntaxNode | undefined): FunctionFacts {
  return { inputs: inputsOf(fn), output: outputOf(fn, body), effects: effectsOf(fn, body) };
}

const listWords = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "PlaceOrderAsync is an async method that takes the customer and the coupon and returns a decimal, once it finishes." */
function summaryOf(fn: SyntaxNode, name: string, kind: string, facts: FunctionFacts): string {
  const isAsync = fn.namedChildren.some((c) => c?.type === 'modifier' && c.text === 'async');
  const isStatic = fn.namedChildren.some((c) => c?.type === 'modifier' && c.text === 'static');
  const takes = facts.inputs.length ? `takes ${listWords(facts.inputs.map((i) => `the ${i.name}`))}` : '';
  const type = facts.output.type;
  const gives = facts.output.nothing || !type ? '' : `returns ${/^[A-Z]\w*$/.test(type) || /^(decimal|int|long|string|bool|double|float|byte|char|short|object)$/.test(type) ? `${/^[aeiouAEIOU]/.test(type) ? 'an' : 'a'} ${type}` : type}${facts.output.later ? ', once it finishes' : ''}`;
  const what = [takes, gives].filter(Boolean).join(' and ');
  const lead = isAsync ? 'an async' : isStatic ? `a static` : /^[aeiou]/.test(kind) ? 'an' : 'a';
  return `${name} is ${lead} ${kind}${what ? ` that ${what}` : ''}.`;
}
