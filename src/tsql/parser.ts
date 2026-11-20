import { Token, code, isWord, tokenize } from './lexer';

/**
 * T-SQL statements and routines from tokens. T-SQL needs no semicolons, so a statement ends where the next one starts:
 * a statement keyword at the top level (not inside parentheses or CASE … END), except where the keyword continues
 * the statement (INSERT … SELECT, … UNION SELECT, UPDATE … SET, WITH cte AS (…) SELECT, CURSOR FOR SELECT, MERGE …;).
 * Blocks are BEGIN … END, BEGIN TRY … END TRY BEGIN CATCH … END CATCH, IF … ELSE and WHILE.
 */

export type StatementKind = 'simple' | 'block' | 'if' | 'while' | 'try' | 'return' | 'throw' | 'break' | 'continue' | 'goto' | 'label';

export interface Statement {
  kind: StatementKind;
  /** The statement's own tokens: all of a simple statement, the condition of IF and WHILE, the value of RETURN. */
  tokens: Token[];
  /** Where the whole statement is, body included. */
  start: number;
  end: number;
  /** IF and WHILE: the statement that runs. */
  body?: Statement;
  /** IF: the ELSE statement. */
  otherwise?: Statement;
  /** BEGIN … END, and the TRY part of a TRY … CATCH. */
  statements?: Statement[];
  /** TRY … CATCH: the CATCH part. */
  handler?: Statement[];
  /** GOTO target, or a label's name. */
  label?: string;
}

export interface Routine {
  kind: 'procedure' | 'function' | 'trigger' | 'script';
  /** As written without brackets, with its schema: dbo.SaveOrder. */
  name: string;
  /** The name's last part, upper case, for matching: SAVEORDER. */
  key: string;
  nameStart: number;
  nameEnd: number;
  parameters: string[];
  body: Statement[];
  start: number;
  end: number;
}

/** Words that start a statement. */
const starters = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SET', 'DECLARE', 'EXEC', 'EXECUTE', 'IF', 'WHILE', 'BEGIN', 'RETURN', 'THROW',
  'RAISERROR', 'PRINT', 'BREAK', 'CONTINUE', 'GOTO', 'WAITFOR', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'OPEN', 'FETCH', 'CLOSE',
  'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVE', 'WITH', 'USE', 'GRANT', 'DENY', 'REVOKE', 'BULK', 'DBCC', 'KILL', 'CHECKPOINT',
  'BACKUP', 'RESTORE', 'ENABLE', 'DISABLE', 'END', 'ELSE', 'GO',
]);
const dml = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

export const isStarter = (t: Token | undefined): boolean => !!t && t.kind === 'word' && starters.has(t.value);

/** Splits the tokens into batches at GO on a line of its own. */
export function batches(text: string, tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const t of tokens) {
    const lineStart = text.lastIndexOf('\n', t.start - 1) + 1;
    if (isWord(t, 'GO') && !text.slice(lineStart, t.start).trim()) {
      out.push([]);
      continue;
    }
    out[out.length - 1].push(t);
  }
  return out.filter((b) => b.some((t) => t.kind !== 'comment'));
}

class Reader {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  get done() { return this.i >= this.tokens.length; }
  peek(offset = 0) { return this.tokens[this.i + offset]; }
  next() { return this.tokens[this.i++]; }
  /** Skips stray semicolons. */
  skipSemicolons() { while (this.peek()?.text === ';') this.i++; }
}

/** Statements until the reader ends or one of the stop words (END, END TRY…) comes up. */
function statementList(r: Reader, stop: (r: Reader) => boolean): Statement[] {
  const list: Statement[] = [];
  for (;;) {
    r.skipSemicolons();
    if (r.done || stop(r)) return list;
    const before = r.i;
    const s = statement(r);
    if (s) list.push(s);
    if (r.i === before) r.i++;
  }
}

/** A condition: tokens up to the statement that follows it. */
function condition(r: Reader): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let cases = 0;
  while (!r.done) {
    const t = r.peek()!;
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (isWord(t, 'CASE')) cases++;
    if (isWord(t, 'END') && cases > 0) cases--;
    else if (depth === 0 && cases === 0 && out.length && isStarter(t)) break;
    out.push(r.next()!);
  }
  return out;
}

/** A plain statement: up to where the next one starts. */
function simple(r: Reader): Statement {
  const first = r.peek()!;
  const out: Token[] = [];
  let depth = 0;
  let cases = 0;
  let sawSet = false;
  let continued = 0;
  const lead = first.value;
  // The statement's verb so far: WITH cte AS (…) UPDATE … makes it UPDATE, so its SET belongs to it.
  let verb = lead;
  while (!r.done) {
    const t = r.peek()!;
    if (t.text === ';' && depth === 0) {
      r.next();
      break;
    }
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (isWord(t, 'CASE')) cases++;
    // A label (name:) starts a statement of its own.
    if (out.length && depth === 0 && t.kind === 'word' && !starters.has(t.value) && r.peek(1)?.text === ':' && r.peek(2)?.text !== ':') break;
    // Inside CASE … END, WHEN, THEN, ELSE and END belong to the expression.
    if (out.length && depth === 0 && cases === 0 && isStarter(t)) {
      const previous = out[out.length - 1];
      const continues =
        lead === 'MERGE' ||
        (dml.has(t.value) && previous && isWord(previous, 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'FOR', 'AS')) ||
        (lead === 'INSERT' && isWord(t, 'SELECT', 'EXEC', 'EXECUTE', 'WITH') && continued === 0) ||
        (verb === 'UPDATE' && t.value === 'SET' && !sawSet) ||
        (lead === 'WITH' && dml.has(t.value) && continued === 0) ||
        (lead === 'DECLARE' && t.value === 'SELECT' && previous && isWord(previous, 'FOR'));
      if (!continues) break;
      if (t.value === 'SET') sawSet = true;
      else {
        continued++;
        if (dml.has(t.value)) verb = t.value;
      }
    }
    if (isWord(t, 'END') && cases > 0) cases--;
    out.push(r.next()!);
  }
  return { kind: 'simple', tokens: out, start: out[0]?.start ?? first.start, end: out[out.length - 1]?.end ?? first.end };
}

function statement(r: Reader): Statement | undefined {
  const t = r.peek();
  if (!t) return undefined;
  const start = t.start;
  const endOf = (s: { end: number } | undefined, fallback: Token) => s?.end ?? fallback.end;

  // A label: name followed by a colon at the start of a statement.
  if (t.kind === 'word' && !starters.has(t.value) && r.peek(1)?.text === ':' && r.peek(2)?.text !== ':') {
    r.i += 2;
    return { kind: 'label', tokens: [t], start, end: t.end + 1, label: t.value };
  }
  if (isWord(t, 'BEGIN')) {
    const after = r.peek(1);
    if (isWord(after, 'TRY')) {
      r.i += 2;
      const tryList = statementList(r, (x) => isWord(x.peek(), 'END') && isWord(x.peek(1), 'TRY'));
      r.i += 2;
      let handler: Statement[] = [];
      if (isWord(r.peek(), 'BEGIN') && isWord(r.peek(1), 'CATCH')) {
        r.i += 2;
        handler = statementList(r, (x) => isWord(x.peek(), 'END') && isWord(x.peek(1), 'CATCH'));
        r.i += 2;
      }
      return { kind: 'try', tokens: [t], start, end: r.tokens[r.i - 1]?.end ?? t.end, statements: tryList, handler };
    }
    if (isWord(after, 'TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION')) return simple(r);
    r.next();
    const list = statementList(r, (x) => isWord(x.peek(), 'END'));
    const endToken = r.next();
    return { kind: 'block', tokens: [t], start, end: endToken?.end ?? t.end, statements: list };
  }
  if (isWord(t, 'IF')) {
    r.next();
    const test = condition(r);
    const body = statement(r);
    r.skipSemicolons();
    let otherwise: Statement | undefined;
    if (isWord(r.peek(), 'ELSE')) {
      r.next();
      otherwise = statement(r);
    }
    return { kind: 'if', tokens: test, start, end: endOf(otherwise ?? body, test[test.length - 1] ?? t), body, otherwise };
  }
  if (isWord(t, 'WHILE')) {
    r.next();
    const test = condition(r);
    const body = statement(r);
    return { kind: 'while', tokens: test, start, end: endOf(body, test[test.length - 1] ?? t), body };
  }
  if (isWord(t, 'RETURN', 'THROW')) {
    const s = simple(r);
    return { ...s, kind: t.value === 'RETURN' ? 'return' : 'throw' };
  }
  if (isWord(t, 'BREAK', 'CONTINUE')) {
    r.next();
    return { kind: t.value === 'BREAK' ? 'break' : 'continue', tokens: [t], start, end: t.end };
  }
  if (isWord(t, 'GOTO')) {
    r.next();
    const target = r.next();
    return { kind: 'goto', tokens: [t, ...(target ? [target] : [])], start, end: target?.end ?? t.end, label: target?.value };
  }
  if (isWord(t, 'END', 'ELSE')) {
    // A stray END or ELSE (unbalanced code): skip it rather than loop.
    r.next();
    return undefined;
  }
  return simple(r);
}

/** The bare name tokens make: dbo.[Save Order] → "dbo.Save Order". */
const nameOf = (parts: Token[]) => parts.filter((p) => p.text !== '.').map((p) => (p.kind === 'name' ? p.value : p.text)).join('.');

/** Reads a possibly qualified name at the reader: a.b.c. */
function qualifiedName(r: Reader): Token[] {
  const parts: Token[] = [];
  while (!r.done && (r.peek()!.kind === 'word' || r.peek()!.kind === 'name')) {
    parts.push(r.next()!);
    if (r.peek()?.text !== '.') break;
    parts.push(r.next()!);
  }
  return parts;
}

/**
 * The routines of a script: CREATE / ALTER / CREATE OR ALTER PROCEDURE, FUNCTION and TRIGGER, and, for the code of a
 * batch that is none of those, a script routine of its own.
 */
export function routines(text: string): Routine[] {
  const all: Routine[] = [];
  const list = batches(text, tokenize(text));
  list.forEach((batch, index) => {
    const tokens = code(batch);
    const r = new Reader(tokens);
    const head = r.peek();
    const createAt = isWord(head, 'CREATE', 'ALTER') ? 1 : -1;
    let kindWord = createAt > 0 ? r.peek(createAt) : undefined;
    let skip = 1;
    if (isWord(kindWord, 'OR') && isWord(r.peek(2), 'ALTER')) {
      kindWord = r.peek(3);
      skip = 3;
    }
    if (createAt > 0 && isWord(kindWord, 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER')) {
      r.i = skip + 1;
      const nameParts = qualifiedName(r);
      const kind = kindWord!.value === 'FUNCTION' ? 'function' : kindWord!.value === 'TRIGGER' ? 'trigger' : 'procedure';
      // The header runs to the AS that starts the body: one at the top level, not `@p AS int` or `EXECUTE AS OWNER`.
      const parameters: string[] = [];
      let depth = 0;
      while (!r.done) {
        const t = r.peek()!;
        if (t.text === '(') depth++;
        if (t.text === ')') depth--;
        const previous = r.peek(-1);
        if (t.kind === 'variable' && previous && (previous.text === '(' || previous.text === ',' || nameParts.includes(previous))) parameters.push(t.text);
        if (depth === 0 && isWord(t, 'AS') && previous?.kind !== 'variable' && !isWord(previous, 'EXECUTE', 'EXEC') && (isStarter(r.peek(1)) || r.peek(1)?.text === '(' || r.peek(1) === undefined)) {
          r.next();
          break;
        }
        r.next();
      }
      // An inline table function: AS RETURN (SELECT …) or AS RETURN SELECT ….
      const body = statementList(r, () => false);
      const last = nameParts.filter((p) => p.text !== '.').pop();
      all.push({
        kind,
        name: nameOf(nameParts),
        key: (last?.kind === 'name' ? last.value : last?.text ?? '').toUpperCase(),
        nameStart: nameParts[0]?.start ?? head!.start,
        nameEnd: nameParts[nameParts.length - 1]?.end ?? head!.end,
        parameters,
        body,
        start: batch[0].start,
        end: batch[batch.length - 1].end,
      });
    } else {
      const body = statementList(r, () => false);
      all.push({ kind: 'script', name: list.length > 1 ? `script (batch ${index + 1})` : 'script', key: '', nameStart: tokens[0].start, nameEnd: tokens[0].start, parameters: [], body, start: batch[0].start, end: batch[batch.length - 1].end });
    }
  });
  return all;
}

/** The routine around an offset. */
export function routineAt(text: string, offset: number): Routine | undefined {
  return routines(text).find((r) => offset >= r.start && offset <= r.end);
}
