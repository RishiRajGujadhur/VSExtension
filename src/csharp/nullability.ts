import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import type { CSharpSource } from './charts';
import { bodyOf } from './explainTarget';
import { functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';

/**
 * Null checks for C#, from the bundled parser: whether a variable, parameter, field, property or a method's result
 * can be null where the cursor is, and why. It reads nullable annotations (`string?`, `int?`), the values that can be
 * null (`null`, `default`, `a?.b`, `x as T`, `FirstOrDefault()`, a call to a method declared to return `T?`, a caller
 * passing null), and the checks that rule null out before a use (`!= null`, `is not null`, `is {}`, `?? throw`,
 * `ThrowIfNull`, `string.IsNullOrEmpty`, a guard that returns or throws). The report has the shape of the TypeScript
 * one (`nullabilityReport` in src/inspect/nullability.ts).
 *
 * The parser sees syntax, not the compiler's flow analysis: types without `?` are taken as not null, as with nullable
 * reference types turned on, and names are matched as text.
 */

interface Parsed {
  file: string;
  text: string;
  tree: Tree;
}

const kids = (n: SyntaxNode): SyntaxNode[] => n.namedChildren.filter((c): c is SyntaxNode => !!c);
const oneLine = (text: string, max = 50) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const base = (file: string) => file.split(/[\\/]/).pop() ?? file;
const where = (f: Parsed, n: SyntaxNode): ReportLocation => ({ file: f.file, line: n.startPosition.row, character: n.startPosition.column, endLine: n.endPosition.row, endCharacter: n.endPosition.column });
const place = (f: Parsed, n: SyntaxNode) => `${base(f.file)}:${n.startPosition.row + 1}`;
const escape = (name: string) => name.replace(/[^\w@]/g, '');

/** Value types that are never null unless written with `?`. */
const VALUE_TYPES = /^(bool|byte|sbyte|char|decimal|double|float|int|uint|nint|nuint|long|ulong|short|ushort|DateTime|DateTimeOffset|TimeSpan|Guid)$/;
/** Library calls that give null (or default) when nothing is found. */
const OR_NULL = /^(FirstOrDefault|LastOrDefault|SingleOrDefault|ElementAtOrDefault|MinOrDefault|MaxOrDefault|DefaultIfEmpty|Find|FindLast|GetValueOrDefault|GetService|GetEnvironmentVariable|ReadLine)$/;

/** Splits a condition at its top-level `&&` or `||`, outside parentheses, strings and brackets. */
function splitTop(text: string, operator: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && text.startsWith(operator, i)) {
      parts.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** `(a)` → `a`, when the parentheses wrap the whole text. */
function unwrap(text: string): string {
  let t = text.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Whether the condition being true means the name is not null. The text is read rather than the tree because the
 * bundled grammar groups `x is not null && y` as `x is not (null && y)`.
 */
export function assertsNotNull(condition: string, name: string): boolean {
  const t = unwrap(condition);
  const ors = splitTop(t, '||');
  if (ors.length > 1) return ors.every((p) => assertsNotNull(p, name));
  const ands = splitTop(t, '&&');
  if (ands.length > 1) return ands.some((p) => assertsNotNull(p, name));
  if (/^!\s*\(/.test(t)) return assertsNull(t.replace(/^!\s*/, ''), name);
  const n = escape(name);
  return [
    new RegExp(`^${n}\\s*!=\\s*null$`),
    new RegExp(`^null\\s*!=\\s*${n}$`),
    new RegExp(`^${n}\\s+is\\s+not\\s+null$`),
    new RegExp(`^${n}\\s+is\\s+\\{`),
    new RegExp(`^${n}\\s+is\\s+(?!null\\b|not\\b)[A-Za-z_][\\w.<>,\\s]*?\\s+[A-Za-z_]\\w*$`),
    new RegExp(`^${n}\\s+is\\s+(?!null\\b|not\\b)[A-Z][\\w.<>]*$`),
    new RegExp(`^!\\s*string\\.IsNullOr(Empty|WhiteSpace)\\(\\s*${n}\\s*\\)$`),
    new RegExp(`^${n}\\?\\.\\w+(\\.\\w+)*\\s*(==\\s*true|>\\s*\\d+|>=\\s*1)$`),
    new RegExp(`^${n}\\.HasValue$`),
  ].some((r) => r.test(t));
}

/** Whether the condition being true means the name is null (so its being false rules null out). */
export function assertsNull(condition: string, name: string): boolean {
  const t = unwrap(condition);
  const ors = splitTop(t, '||');
  if (ors.length > 1) return ors.some((p) => assertsNull(p, name));
  const ands = splitTop(t, '&&');
  if (ands.length > 1) return ands.every((p) => assertsNull(p, name));
  if (/^!/.test(t) && !/^!=/.test(t)) return assertsNotNull(t.replace(/^!\s*/, ''), name);
  const n = escape(name);
  return [
    new RegExp(`^${n}\\s*==\\s*null$`),
    new RegExp(`^null\\s*==\\s*${n}$`),
    new RegExp(`^${n}\\s+is\\s+null$`),
    new RegExp(`^string\\.IsNullOr(Empty|WhiteSpace)\\(\\s*${n}\\s*\\)$`),
    new RegExp(`^!\\s*${n}\\.HasValue$`),
  ].some((r) => r.test(t));
}

/** Whether running the statement always leaves the block: return, throw, break, continue (or a block ending so). */
function jumps(statement: SyntaxNode | null | undefined): boolean {
  if (!statement) return false;
  if (/^(return|throw|break|continue|goto)_statement$/.test(statement.type)) return true;
  if (statement.type === 'expression_statement' && kids(statement)[0]?.type === 'throw_expression') return true;
  if (statement.type === 'block') return jumps(kids(statement).at(-1));
  return false;
}

export async function csharpNullChecks(sources: CSharpSource[], file: string, offset: number): Promise<Report> {
  const parsed = new Map<string, Parsed>();
  const parse = async (s: CSharpSource) => {
    let p = parsed.get(s.file);
    if (!p) parsed.set(s.file, (p = { file: s.file, text: s.text, tree: await parseCSharp(s.text) }));
    return p;
  };
  /** The files that mention a word, parsed. */
  const mentioning = async (word: string) => {
    const pattern = new RegExp(`(^|[^\\w@])@?${escape(word)}(?!\\w)`);
    const out: Parsed[] = [];
    for (const s of sources) if (pattern.test(s.text)) out.push(await parse(s));
    return out;
  };
  try {
    const source = sources.find((s) => s.file === file);
    if (!source) throw new AnalysisError('Open a C# file and put the cursor in it.');
    const home = await parse(source);
    let id: SyntaxNode | null = home.tree.rootNode.descendantForIndex(offset);
    if (id && id.type !== 'identifier') id = home.tree.rootNode.descendantForIndex(Math.max(0, offset - 1));
    if (!id || id.type !== 'identifier') throw new AnalysisError('Put the cursor on a variable, parameter, field, property or method name.');
    const name = id.text;

    /** Methods declared with this name in the workspace, by name. */
    const methodsNamed = async (method: string) => {
      const out: { file: Parsed; node: SyntaxNode }[] = [];
      for (const f of await mentioning(method)) {
        for (const m of f.tree.rootNode.descendantsOfType(['method_declaration', 'local_function_statement'])) if (m && m.childForFieldName('name')?.text === method) out.push({ file: f, node: m });
      }
      return out;
    };
    const returnType = (m: SyntaxNode) => m.childForFieldName('returns')?.text ?? m.childForFieldName('type')?.text ?? '';
    const returnsNullable = (type: string) => /\?$/.test(type) || /^(?:Value)?Task<.+\?>$/.test(type);

    /** Why an expression can be null, or undefined when it cannot (as far as the syntax shows). */
    const nullReason = async (e: SyntaxNode | null | undefined, depth = 0): Promise<string | undefined> => {
      if (!e || depth > 4) return undefined;
      switch (e.type) {
        case 'null_literal':
          return 'null';
        case 'default_expression':
          return e.text === 'default' || /\?\s*\)$/.test(e.text) || !VALUE_TYPES.test(e.text.replace(/^default\s*\(\s*|\s*\)$/g, '')) ? 'default, which is null for reference types' : undefined;
        case 'conditional_access_expression':
          return `${oneLine(kids(e)[0]?.text ?? '', 30)} may be null, so ?. gives null`;
        case 'as_expression':
          return 'as gives null when the type does not match';
        case 'parenthesized_expression':
        case 'await_expression':
          return nullReason(kids(e)[0], depth + 1);
        case 'conditional_expression': {
          const [, yes, no] = kids(e);
          return (await nullReason(yes, depth + 1)) ?? (await nullReason(no, depth + 1));
        }
        case 'binary_expression':
          return e.childForFieldName('operator')?.text === '??' ? nullReason(e.childForFieldName('right'), depth + 1) : undefined;
        case 'invocation_expression': {
          const callee = e.childForFieldName('function');
          const named = callee?.type === 'member_access_expression' ? callee.childForFieldName('name') : callee;
          const method = (named?.type === 'generic_name' ? kids(named)[0]?.text : named?.text) ?? '';
          // A method of the workspace says so in its return type; a library one by its name.
          const declared = await methodsNamed(method);
          const nullable = declared.find((m) => returnsNullable(returnType(m.node)));
          if (nullable) return `${method}() is declared to return ${returnType(nullable.node)}`;
          return !declared.length && OR_NULL.test(method) ? `${method} gives null when nothing is found` : undefined;
        }
        default:
          return undefined;
      }
    };

    // ------------------------------------------------------------------ A method: what it returns.
    const decl = id.parent;
    const calledMethod = (() => {
      let n: SyntaxNode = id;
      if (n.parent?.type === 'member_access_expression' && n.parent.childForFieldName('name')?.id === n.id) n = n.parent;
      return n.parent?.type === 'invocation_expression' && n.parent.childForFieldName('function')?.id === n.id;
    })();
    if ((decl && (decl.type === 'method_declaration' || decl.type === 'local_function_statement') && decl.childForFieldName('name')?.id === id.id) || calledMethod) {
      const target = decl && decl.childForFieldName('name')?.id === id.id && (decl.type === 'method_declaration' || decl.type === 'local_function_statement') ? { file: home, node: decl } : (await methodsNamed(name)).find((m) => bodyOf(m.node));
      if (!target) throw new AnalysisError(`${name} is not declared in the workspace's C# files.`);
      return finish(await returnsReport(target.file, target.node, nullReason, returnType, returnsNullable), parsed);
    }

    // ------------------------------------------------------------------ A value: where it is declared.
    const fn = (() => {
      for (let p = id.parent; p; p = p.parent) if (functionTypes.has(p.type)) return p;
      return undefined;
    })();
    const typeOf = (n: SyntaxNode | null | undefined) => {
      for (let p = n; p; p = p.parent) {
        if (/^(class|struct|record|interface)_declaration$/.test(p.type)) return p;
      }
      return undefined;
    };
    const isOwnName = (n: SyntaxNode) => {
      // `obj.Name` is this name only when obj is `this`.
      const parent = n.parent;
      if (parent?.type === 'member_access_expression' && parent.childForFieldName('name')?.id === n.id) return parent.childForFieldName('expression')?.text === 'this';
      if (parent?.type === 'member_binding_expression') return false;
      return true;
    };
    interface Declaration {
      file: Parsed;
      node: SyntaxNode;
      /** As written: "string?", "var", "int". */
      type: string;
      /** The value it starts with. */
      value?: SyntaxNode;
      kind: 'parameter' | 'local' | 'field' | 'property';
    }
    const declarationIn = (root: SyntaxNode, f: Parsed, local: boolean): Declaration | undefined => {
      for (const n of root.descendantsOfType(local ? ['parameter', 'variable_declarator', 'foreach_statement', 'declaration_pattern'] : ['variable_declarator', 'property_declaration', 'parameter'])) {
        if (!n) continue;
        const own = n.childForFieldName('name') ?? n.childForFieldName('left') ?? kids(n).find((c) => c.type === 'identifier');
        if (own?.text !== name) continue;
        if (n.type === 'parameter') {
          // At class level, only a record's or primary constructor's parameters.
          if (!local && n.parent?.parent && functionTypes.has(n.parent.parent.type)) continue;
          // A default value is the parameter's last child (after the type and the name).
          const last = kids(n).at(-1);
          const value = last?.type === 'equals_value_clause' ? kids(last)[0] : last && last.id !== own.id && last.id !== n.childForFieldName('type')?.id ? last : undefined;
          return { file: f, node: n, type: n.childForFieldName('type')?.text ?? 'var', value, kind: 'parameter' };
        }
        if (n.type === 'variable_declarator') {
          const field = !local || n.parent?.parent?.type === 'field_declaration';
          if (!local && n.parent?.parent?.type !== 'field_declaration') continue;
          const value = kids(n).find((c) => c.id !== own.id);
          return { file: f, node: n, type: n.parent?.childForFieldName('type')?.text ?? 'var', value: value?.type === 'equals_value_clause' ? kids(value)[0] : value, kind: field ? 'field' : 'local' };
        }
        if (n.type === 'property_declaration') {
          const value = kids(n).find((c) => c.type !== 'identifier' && c.type !== 'accessor_list' && c.type !== 'modifier' && c.id !== n.childForFieldName('type')?.id && c.type !== 'arrow_expression_clause');
          return { file: f, node: n, type: n.childForFieldName('type')?.text ?? '?', value, kind: 'property' };
        }
        return { file: f, node: n, type: n.childForFieldName('type')?.text ?? 'var', kind: 'local' };
      }
      return undefined;
    };
    let declaration = fn ? declarationIn(fn, home, true) : undefined;
    let scope: { file: Parsed; root: SyntaxNode }[] = declaration && fn ? [{ file: home, root: fn }] : [];
    if (!declaration) {
      const own = typeOf(id);
      declaration = own ? declarationIn(own, home, false) : undefined;
      if (declaration && own) scope = [{ file: home, root: own }];
    }
    if (!declaration) {
      // A member of another type: its declaration by name anywhere; its uses where the cursor is.
      for (const f of await mentioning(name)) {
        declaration = declarationIn(f.tree.rootNode, f, false);
        if (declaration) break;
      }
      scope = [{ file: home, root: fn ?? home.tree.rootNode }];
    }
    if (!declaration) throw new AnalysisError(`${name} is not declared in the workspace's C# files.`);
    const decl0 = declaration;
    const annotated = /\?$/.test(decl0.type);
    const valueType = !annotated && VALUE_TYPES.test(decl0.type);

    const occurrences = (scope.flatMap(({ file: f, root }) => root.descendantsOfType('identifier').filter((n): n is SyntaxNode => !!n && n.text === name).map((n) => ({ file: f, node: n }))))
      .filter((o) => (o.node.id === id.id || isOwnName(o.node)) && !(o.node.parent && (o.node.parent.childForFieldName('name')?.id === o.node.id || o.node.parent.childForFieldName('left')?.id === o.node.id) && /declarator|parameter|property_declaration|foreach|pattern/.test(o.node.parent.type)));
    const subjectOf = (n: SyntaxNode) => (n.parent?.type === 'member_access_expression' && n.parent.childForFieldName('name')?.id === n.id ? n.parent : n);
    const assignmentOf = (n: SyntaxNode) => {
      const s = subjectOf(n);
      return s.parent?.type === 'assignment_expression' && s.parent.childForFieldName('left')?.id === s.id ? s.parent : undefined;
    };

    // ------------------------------------------------------------------ Where null comes from.
    const sources_: ReportNode[] = [];
    if (annotated) sources_.push({ label: `declared ${decl0.type}`, description: `${decl0.kind === 'parameter' ? 'callers may pass null' : 'the type allows null'} · ${place(decl0.file, decl0.node)}`, icon: 'symbol-variable', tone: 'info', location: where(decl0.file, decl0.node) });
    const startsNull = await nullReason(decl0.value);
    if (startsNull) sources_.push({ label: `${decl0.kind === 'parameter' ? 'defaults to' : 'starts as'} ${oneLine(decl0.value!.text, 40)}`, description: `${startsNull} · ${place(decl0.file, decl0.value!)}`, icon: 'symbol-constant', tone: 'warning', location: where(decl0.file, decl0.value!) });
    for (const o of occurrences) {
      const assignment = assignmentOf(o.node);
      if (!assignment) continue;
      const operator = assignment.text.slice(subjectOf(o.node).endIndex - assignment.startIndex).trimStart().match(/^\S+/)?.[0];
      if (operator !== '=') continue;
      const reason = await nullReason(assignment.childForFieldName('right'));
      if (reason) sources_.push({ label: oneLine(assignment.text), description: `${reason} · ${place(o.file, assignment)}`, icon: 'edit', tone: 'warning', location: where(o.file, assignment) });
    }
    // A parameter: the callers that pass null for it.
    if (decl0.kind === 'parameter') {
      const method = decl0.node.parent?.parent;
      const methodName = method?.childForFieldName('name')?.text;
      const list = decl0.node.parent ? kids(decl0.node.parent).filter((p) => p.type === 'parameter') : [];
      const index = list.findIndex((p) => p.id === decl0.node.id);
      if (methodName && index >= 0) {
        for (const f of await mentioning(methodName)) {
          for (const call of f.tree.rootNode.descendantsOfType(['invocation_expression', 'object_creation_expression'])) {
            if (!call) continue;
            const callee = call.type === 'invocation_expression' ? call.childForFieldName('function') : call.childForFieldName('type');
            const calleeName = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : callee?.text;
            if (calleeName !== methodName || (call.type === 'object_creation_expression' && method?.type !== 'constructor_declaration')) continue;
            const args = kids(call.childForFieldName('arguments') ?? call).filter((a) => a.type === 'argument');
            const named = args.find((a) => a.childForFieldName('name')?.text === name || new RegExp(`^${escape(name)}\\s*:`).test(a.text));
            const arg = named ?? (args.some((a) => /^\w+\s*:/.test(a.text)) ? undefined : args[index]);
            const value = arg ? kids(arg).at(-1) : undefined;
            const reason = await nullReason(value);
            if (reason && value) sources_.push({ label: `${oneLine(call.text, 50)}`, description: `a caller passes ${reason === 'null' ? 'null' : `a value that can be null (${reason})`} · ${place(f, call)}`, icon: 'call-incoming', tone: 'warning', location: where(f, call) });
          }
        }
      }
    }
    const mayBeNull = !valueType && (annotated || sources_.some((s) => s.tone === 'warning'));

    // ------------------------------------------------------------------ What rules null out at a place.
    /** The check that rules null out at this use, or undefined when nothing does. */
    const guardAt = (use: SyntaxNode): SyntaxNode | undefined => {
      let child: SyntaxNode = use;
      for (let p = use.parent; p; child = p, p = p.parent) {
        if (functionTypes.has(p.type) || p.type === 'property_declaration') return undefined;
        if (p.type === 'binary_expression') {
          const op = p.childForFieldName('operator')?.text;
          const left = p.childForFieldName('left');
          if (left && p.childForFieldName('right')?.id === child.id) {
            if (op === '&&' && assertsNotNull(left.text, name)) return left;
            if (op === '||' && assertsNull(left.text, name)) return left;
          }
        }
        // The grammar's `x is not (null && …)`: the part after the && sees x checked.
        if (p.type === 'is_pattern_expression' && /^\s*\S+\s+is\s+not\s+null\s*&&/.test(p.text) && kids(p)[0]?.text === name && child.id !== kids(p)[0]?.id) return kids(p)[0];
        if (p.type === 'conditional_expression') {
          const [condition, yes, no] = kids(p);
          if (yes?.id === child.id && assertsNotNull(condition.text, name)) return condition;
          if (no?.id === child.id && assertsNull(condition.text, name)) return condition;
        }
        if (p.type === 'if_statement' || p.type === 'while_statement') {
          const condition = p.childForFieldName('condition');
          const yes = p.childForFieldName('consequence') ?? p.childForFieldName('body');
          const no = p.childForFieldName('alternative');
          if (condition && yes?.id === child.id && assertsNotNull(condition.text, name)) return condition;
          if (condition && no && (no.id === child.id || kids(no).some((c) => c.id === child.id)) && assertsNull(condition.text, name)) return condition;
        }
        if (p.type === 'block' || p.type === 'switch_section') {
          const before = kids(p).filter((s) => s.endIndex <= child.startIndex).reverse();
          for (const s of before) {
            const expression = s.type === 'expression_statement' ? kids(s)[0] : undefined;
            if (expression?.type === 'assignment_expression' && subjectOf(expression.childForFieldName('left') ?? expression).text.replace(/^this\./, '') === name) {
              const operator = expression.text.slice((expression.childForFieldName('left')?.endIndex ?? 0) - expression.startIndex).trimStart().match(/^\S+/)?.[0];
              if (operator === '??=') return s;
              if (operator === '=') return nullLike(expression.childForFieldName('right')) ? undefined : s;
            }
            if (expression?.type === 'invocation_expression' && /^(ArgumentNullException\.ThrowIfNull|ArgumentException\.ThrowIfNullOr\w+|Guard\.\w+)$/.test(expression.childForFieldName('function')?.text ?? '') && kids(expression.childForFieldName('arguments') ?? expression)[0]?.text === name) return s;
            if (s.type === 'if_statement' && !s.childForFieldName('alternative') && assertsNull(s.childForFieldName('condition')?.text ?? '', name) && jumps(s.childForFieldName('consequence'))) return s;
            if (s.type === 'local_declaration_statement' && new RegExp(`\\b${escape(name)}\\s*\\?\\?\\s*throw\\b`).test(s.text)) return s;
          }
        }
      }
      return undefined;
    };
    /** Without the workspace lookups: null, default, ?., as, …OrDefault. */
    const nullLike = (e: SyntaxNode | null | undefined): boolean => !!e && (e.type === 'null_literal' || e.type === 'default_expression' || e.type === 'conditional_access_expression' || e.type === 'as_expression' || /OrDefault\s*\(|\bFind\s*\(/.test(e.text));

    // ------------------------------------------------------------------ Each use.
    const assertedRows: ReportNode[] = [];
    const uses: ReportNode[] = [];
    for (const o of occurrences) {
      if (assignmentOf(o.node) && assignmentOf(o.node)!.text.slice(subjectOf(o.node).endIndex - assignmentOf(o.node)!.startIndex).trimStart().startsWith('=')) continue;
      const subject = subjectOf(o.node);
      const parent = subject.parent;
      const line = o.node.startPosition.row + 1;
      const context = parent && parent.type !== 'expression_statement' && parent.type !== 'block' ? (parent.type === 'argument' ? parent.parent?.parent ?? parent : parent) : subject;
      if (parent?.type === 'postfix_unary_expression' && parent.text.endsWith('!')) {
        assertedRows.push({ label: oneLine(parent.parent?.text ?? parent.text), description: `line ${line}`, icon: 'warning', location: where(o.file, o.node) });
        continue;
      }
      const op = parent?.type === 'binary_expression' ? parent.childForFieldName('operator')?.text : undefined;
      const check =
        (op && ['==', '!='].includes(op) && kids(parent!).some((c) => c.type === 'null_literal')) ||
        (op === '??' && parent!.childForFieldName('left')?.id === subject.id) ||
        parent?.type === 'is_pattern_expression' ||
        (parent?.type === 'conditional_access_expression' && kids(parent)[0]?.id === subject.id) ||
        (parent?.type === 'assignment_expression' && /^\s*\?\?=/.test(parent.text.slice(subject.endIndex - parent.startIndex))) ||
        (parent?.type === 'argument' && /^(string\.IsNullOr\w+|ArgumentNullException\.ThrowIfNull)$/.test(parent.parent?.parent?.childForFieldName('function')?.text ?? '')) ||
        (parent?.type === 'member_access_expression' && parent.childForFieldName('expression')?.id === subject.id && parent.childForFieldName('name')?.text === 'HasValue');
      const dereferenced =
        (parent?.type === 'member_access_expression' && parent.childForFieldName('expression')?.id === subject.id) ||
        (parent?.type === 'element_access_expression' && kids(parent)[0]?.id === subject.id) ||
        (parent?.type === 'invocation_expression' && parent.childForFieldName('function')?.id === subject.id) ||
        (parent?.type === 'foreach_statement' && parent.childForFieldName('right')?.id === subject.id);
      const guard = check ? undefined : guardAt(subject);
      const risky = mayBeNull && !check && !guard;
      uses.push({
        label: oneLine(context.text),
        description: `line ${line} · ${check ? 'check' : risky ? (dereferenced ? 'may be null' : 'may be null, passed on') : 'safe'}`,
        icon: check ? 'filter' : risky ? 'warning' : 'pass',
        tone: check ? undefined : risky && dereferenced ? 'warning' : risky ? undefined : 'ok',
        role: 'read',
        location: where(o.file, o.node),
      });
    }

    // ------------------------------------------------------------------ The report.
    const cursorGuard = mayBeNull ? guardAt(subjectOf(id)) : undefined;
    const atDeclaration = id.parent?.id === decl0.node.id;
    const nullableHere = mayBeNull && !cursorGuard;
    const roots: ReportNode[] = [
      {
        label: `${name}: ${decl0.type}`,
        description: valueType ? 'a value type: never null' : nullableHere ? 'may be null here' : mayBeNull ? 'never null here' : 'not marked nullable (?), and nothing here sets it to null',
        icon: nullableHere ? 'warning' : 'pass',
        tone: nullableHere ? 'warning' : 'ok',
        location: where(home, id),
      },
      { label: 'Declared', description: `${place(decl0.file, decl0.node)} · ${oneLine(decl0.node.text, 60)}`, icon: decl0.kind === 'parameter' ? 'symbol-parameter' : decl0.kind === 'local' ? 'symbol-variable' : 'symbol-field', location: where(decl0.file, decl0.node) },
    ];
    if (assertedRows.length) {
      roots.push({
        label: `Asserted non-null with ! (${assertedRows.length})`,
        description: mayBeNull ? 'it can still be null: a check is safer than !' : 'each one is a promise the compiler cannot check',
        icon: 'warning',
        tone: mayBeNull ? 'warning' : 'info',
        children: assertedRows,
      });
    }
    if (sources_.length && !valueType) roots.push({ label: nullableHere ? 'Paths that produce null' : 'Possible null sources before the checks', icon: 'git-merge', expanded: true, children: sources_ });
    if (cursorGuard && !atDeclaration) roots.push({ label: 'Ruled out by', icon: 'shield', expanded: true, children: [{ label: oneLine(cursorGuard.text, 60), icon: 'filter', tone: 'ok', location: where(home, cursorGuard) }] });
    if (uses.length) {
      const count = (word: string) => uses.filter((u) => u.description!.endsWith(word)).length;
      const unsafe = uses.filter((u) => u.tone === 'warning').length;
      roots.push({ label: 'Uses', description: [`${count('safe')} safe`, plural(count('check'), 'check'), `${unsafe} may be null`].join(', '), icon: 'references', children: uses, expanded: unsafe > 0 });
    }
    if (nullableHere) {
      roots.push(
        howToFix([
          'Check it before use: if (value is not null) { … }, or return early when it is null.',
          'Read through it safely with ?. (value?.Name) and give a fallback with ?? (value ?? fallback).',
          'Give it a value where it starts (an initializer, a non-null default), or drop the ? if it can never be null.',
          'If it can never be null here, show why with a check rather than the ! operator.',
        ]),
      );
    }
    const origins = sources_.filter((s) => s.tone === 'warning').length + (annotated ? 1 : 0);
    return finish(
      {
        kind: 'nullability',
        title: `Nullability of ${name}`,
        description: nullableHere ? plural(origins, 'source') : 'safe here',
        roots,
        warnings: ['Read from the code by the bundled C# parser, not the compiler: types without ? are taken as never null (nullable reference types on), and names are matched as text.'],
        fileHashes: {},
      },
      parsed,
    );
  } finally {
    for (const p of parsed.values()) p.tree.delete();
  }
}

/** What a method returns, and which of its returns give null. */
async function returnsReport(
  f: Parsed,
  method: SyntaxNode,
  nullReason: (e: SyntaxNode | null | undefined) => Promise<string | undefined>,
  returnType: (m: SyntaxNode) => string,
  returnsNullable: (type: string) => boolean,
): Promise<Report> {
  const name = functionName(method);
  const type = returnType(method);
  const body = bodyOf(method);
  const returns: SyntaxNode[] = [];
  if (body?.type === 'arrow_expression_clause') {
    const e = kids(body)[0];
    if (e) returns.push(e);
  } else if (body) {
    const visit = (n: SyntaxNode) => {
      if (n.id !== method.id && functionTypes.has(n.type)) return;
      if (n.type === 'return_statement' && kids(n)[0]) returns.push(kids(n)[0]);
      for (const c of kids(n)) visit(c);
    };
    visit(body);
  }
  const rows: ReportNode[] = [];
  for (const r of returns) {
    const reason = await nullReason(r);
    if (reason) rows.push({ label: `return ${oneLine(r.text, 50)}`, description: `${reason} · ${place(f, r)}`, icon: 'reply', tone: 'warning', location: where(f, r) });
  }
  const declared = returnsNullable(type);
  const nullable = declared || rows.length > 0;
  const roots: ReportNode[] = [
    {
      label: `${name}() returns ${type || 'a value'}`,
      description: nullable ? 'may return null' : 'never returns null',
      icon: nullable ? 'warning' : 'pass',
      tone: nullable ? 'warning' : 'ok',
      location: where(f, method.childForFieldName('name') ?? method),
    },
  ];
  if (rows.length) roots.push({ label: 'Returns that produce null', icon: 'git-merge', expanded: true, children: rows });
  if (rows.length && !declared) roots.push(howToFix([`Declare that it can return null (${type}?) so callers check, or return a value that is never null (an empty list, a default object).`]));
  return {
    kind: 'nullability',
    title: `Nullability of ${name}()`,
    description: nullable ? (rows.length ? plural(rows.length, 'nullable return') : 'declared nullable') : 'safe',
    roots,
    warnings: [],
    fileHashes: {},
  };
}

/** Fills in the hashes of the files the rows point into. */
function finish(report: Report, parsed: Map<string, Parsed>): Report {
  const used = new Set<string>();
  const visit = (rows: ReportNode[]) => rows.forEach((r) => { if (r.location) used.add(r.location.file); visit(r.children ?? []); });
  visit(report.roots);
  const fileHashes: Record<string, string> = {};
  for (const p of parsed.values()) if (used.has(p.file)) fileHashes[p.file] = hashText(p.text);
  return { ...report, fileHashes };
}
