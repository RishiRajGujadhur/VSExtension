import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { CallDirection, callGraphControls } from '../navigate/callGraph';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import { Usage, UsageKind, isTestPath, usageReport } from '../structure/usageReport';
import { Token, code, isWord, tokenize } from './lexer';
import { Routine, isStarter, routines } from './parser';

/**
 * Find usages and Callers and calls for T-SQL, across the workspace's .sql files: by name (tables, views, columns,
 * procedures, functions), case-insensitive and with or without [brackets] and schema; @variables within their routine.
 * The answers come from the code alone, without a database: two different tables with the same name in different
 * schemas are told apart only when the code writes the schema.
 */

export interface SqlFile {
  file: string;
  text: string;
}

/** Words that are never a table, column or routine name. */
const keywords = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'AS', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'APPLY', 'GROUP', 'BY', 'ORDER', 'HAVING', 'TOP', 'DISTINCT', 'INTO', 'VALUES', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'EXISTS', 'BETWEEN', 'LIKE', 'UNION', 'ALL', 'TABLE', 'PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'VIEW', 'BEGIN', 'RETURNS',
  'INT', 'BIGINT', 'VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'BIT', 'DECIMAL', 'NUMERIC', 'MONEY', 'DATE', 'DATETIME', 'DATETIME2',
  'OUTPUT', 'WITH', 'NOLOCK', 'ASC', 'DESC', 'OVER', 'PARTITION', 'SET', 'DECLARE', 'EXEC', 'EXECUTE', 'INSERT', 'UPDATE', 'DELETE',
]);
const isKeyword = (t: Token) => t.kind === 'word' && (keywords.has(t.value) || isStarter(t));

/** The comparable name of a token: upper case, without brackets. */
const keyOf = (t: Token) => (t.kind === 'name' ? t.value : t.text).toUpperCase();

function positions(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: offset - starts[low] };
  };
}

class Indexed {
  readonly tokens: Token[];
  readonly routines: Routine[];
  private readonly at: ReturnType<typeof positions>;
  constructor(readonly source: SqlFile) {
    this.tokens = code(tokenize(source.text));
    this.routines = routines(source.text);
    this.at = positions(source.text);
  }
  location(t: Token): ReportLocation {
    const a = this.at(t.start);
    const b = this.at(t.end);
    return { file: this.source.file, line: a.line, character: a.character, endLine: b.line, endCharacter: b.character };
  }
  lineOf(t: Token): string {
    const start = this.source.text.lastIndexOf('\n', t.start - 1) + 1;
    const end = this.source.text.indexOf('\n', t.end);
    return this.source.text.slice(start, end < 0 ? undefined : end).trim();
  }
  routineAt(offset: number): Routine | undefined {
    return this.routines.find((r) => offset >= r.start && offset <= r.end);
  }
}

/** What a name's use does, from the words before it. */
function classifyName(tokens: Token[], i: number): UsageKind {
  // Skip back over the schema part of a qualified name (dbo.Orders): the words before the whole name count.
  let first = i;
  while (tokens[first - 1]?.text === '.' && tokens[first - 2] && (tokens[first - 2].kind === 'word' || tokens[first - 2].kind === 'name')) first -= 2;
  const before = tokens[first - 1];
  const before2 = tokens[first - 2];
  const after = tokens[i + 1];
  if (isWord(before, 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW', 'TYPE') && (isWord(before2, 'CREATE', 'ALTER') || isWord(before2, 'ALTER') || isWord(tokens[first - 3], 'OR'))) return 'definition';
  if (isWord(before, 'TABLE') && isWord(before2, 'CREATE')) return 'definition';
  if (isWord(before, 'EXEC', 'EXECUTE') || (before?.text === '=' && before2?.kind === 'variable' && isWord(tokens[first - 3], 'EXEC', 'EXECUTE'))) return 'call';
  if (after?.text === '(' && first !== i) return 'call';
  if (isWord(before, 'INTO') && isWord(before2, 'INSERT', 'MERGE')) return 'write';
  if (isWord(before, 'INSERT', 'MERGE', 'UPDATE')) return 'write';
  if (isWord(before, 'FROM') && isWord(before2, 'DELETE')) return 'write';
  if (isWord(before, 'DELETE')) return 'write';
  if (isWord(before, 'TABLE') && isWord(before2, 'TRUNCATE')) return 'write';
  // A column given a value: UPDATE … SET Total = …, SET a = 1, b = 2.
  if (after?.text === '=' && (isWord(before, 'SET') || before?.text === ',')) {
    for (let j = first - 1; j >= 0; j--) {
      if (isWord(tokens[j], 'SET')) return isWord(tokens.slice(0, j).reverse().find((t) => isStarter(t)), 'UPDATE') ? 'write' : 'read';
      if (isStarter(tokens[j]) || tokens[j].text === '(') break;
    }
  }
  return 'read';
}

/** What a @variable's use does. */
function classifyVariable(tokens: Token[], i: number, routine: Routine | undefined): UsageKind {
  const t = tokens[i];
  const before = tokens[i - 1];
  const after = tokens[i + 1];
  if (isWord(before, 'DECLARE') || (before?.text === ',' && tokens.slice(0, i).reverse().find((x) => isStarter(x))?.value === 'DECLARE')) return 'definition';
  if (routine?.parameters.some((p) => p.toUpperCase() === t.value) && t.start < (routine.body[0]?.start ?? Infinity)) return 'definition';
  if (isWord(before, 'SET') || (after && /^([-+*/%&|^]?=)$/.test(after.text) && (isWord(before, 'SELECT') || before?.text === ','))) return 'write';
  if (isWord(after, 'OUTPUT', 'OUT')) return 'write';
  if (isWord(before, 'INTO') || (before?.text === ',' && tokens.slice(0, i).reverse().find((x) => isWord(x, 'INTO', 'FETCH', 'SELECT'))?.value === 'INTO')) return 'write';
  return 'read';
}

/** The name token at an offset, and its routine. */
function subjectAt(index: Indexed, offset: number): Token {
  const t = index.tokens.find((x) => offset >= x.start && offset <= x.end);
  if (!t || (t.kind !== 'word' && t.kind !== 'name' && t.kind !== 'variable') || isKeyword(t) || t.text.startsWith('@@')) {
    throw new AnalysisError('Put the cursor on a table, column, procedure, function or @variable name.');
  }
  return t;
}

export function tsqlUsages(files: SqlFile[], file: string, offset: number, folderOf: (file: string) => string = () => ''): Report {
  const indexes = files.map((f) => new Indexed(f));
  const here = indexes.find((x) => x.source.file === file) ?? new Indexed({ file, text: '' });
  const subject = subjectAt(here, offset);
  const usages: Usage[] = [];
  const hashes: Record<string, string> = {};
  const add = (index: Indexed, t: Token, kind: UsageKind) => {
    hashes[index.source.file] ??= hashText(index.source.text);
    usages.push({ kind, location: index.location(t), line: index.lineOf(t), where: index.routineAt(t.start)?.name, atCursor: index === here && t === subject });
  };
  if (subject.kind === 'variable') {
    // A @variable lives in its routine.
    const routine = here.routineAt(subject.start);
    here.tokens.forEach((t, i) => {
      if (t.kind === 'variable' && t.value === subject.value && (!routine || (t.start >= routine.start && t.end <= routine.end))) add(here, t, classifyVariable(here.tokens, i, routine));
    });
    return usageReport(subject.text, usages, folderOf, hashes);
  }
  const key = keyOf(subject);
  for (const index of indexes) {
    index.tokens.forEach((t, i) => {
      if ((t.kind === 'word' || t.kind === 'name') && keyOf(t) === key && index.tokens[i + 1]?.text !== '.' && !isKeyword(t)) add(index, t, classifyName(index.tokens, i));
    });
  }
  return usageReport(subject.kind === 'name' ? subject.value : subject.text, usages, folderOf, hashes);
}

interface RoutineEntry {
  routine: Routine;
  index: Indexed;
  /** The routines it calls, by key, with the call tokens. */
  calls: Map<string, Token[]>;
}

/** The procedures and functions each routine calls: EXEC name, and schema.fn(…) for known functions. */
function callIndex(indexes: Indexed[]): RoutineEntry[] {
  const entries: RoutineEntry[] = [];
  const named = new Set<string>();
  for (const index of indexes) for (const r of index.routines) if (r.key) named.add(r.key);
  for (const index of indexes) {
    for (const routine of index.routines) {
      const calls = new Map<string, Token[]>();
      const tokens = index.tokens.filter((t) => t.start >= routine.start && t.end <= routine.end);
      tokens.forEach((t, i) => {
        if (!(t.kind === 'word' || t.kind === 'name') || tokens[i + 1]?.text === '.' || isKeyword(t)) return;
        if (t.start >= routine.nameStart && t.end <= routine.nameEnd) return;
        const kind = classifyName(tokens, i);
        const key = keyOf(t);
        if (kind === 'call' || (tokens[i + 1]?.text === '(' && named.has(key))) calls.set(key, [...(calls.get(key) ?? []), t]);
      });
      entries.push({ routine, index, calls });
    }
  }
  return entries;
}

const maxPerLevel = 25;

export function tsqlCallGraph(files: SqlFile[], file: string, offset: number, options: { depth: number; direction: CallDirection }): Report {
  const indexes = files.map((f) => new Indexed(f));
  const entries = callIndex(indexes);
  const here = indexes.find((x) => x.source.file === file);
  // The routine at the cursor, or the one named there (EXEC dbo.Save → Save).
  const token = here?.tokens.find((t) => offset >= t.start && offset <= t.end);
  const byKey = new Map(entries.filter((e) => e.routine.key).map((e) => [e.routine.key, e]));
  const named = token && (token.kind === 'word' || token.kind === 'name') ? byKey.get(keyOf(token)) : undefined;
  const root = named ?? entries.find((e) => e.index === here && offset >= e.routine.start && offset <= e.routine.end && e.routine.key);
  if (!root) throw new AnalysisError('Put the cursor in a T-SQL procedure, function or trigger, or on a call to one.');
  const hashes: Record<string, string> = {};
  let omitted = 0;
  const node = (e: RoutineEntry, count: number, children: ReportNode[] | undefined): ReportNode => {
    hashes[e.index.source.file] ??= hashText(e.index.source.text);
    const nameToken = e.index.tokens.find((t) => t.start >= e.routine.nameStart && t.text !== '.') ?? e.index.tokens[0];
    const where = e.index.location(nameToken);
    return {
      label: e.routine.name,
      description: `${e.routine.kind} · ${e.index.source.file.split(/[\\/]/).pop()}:${where.line + 1}${count > 1 ? ` · ${count} calls` : ''}${isTestPath(e.index.source.file) ? ' · test' : ''}`,
      icon: e.routine.kind === 'function' ? 'symbol-function' : e.routine.kind === 'trigger' ? 'zap' : 'symbol-method',
      location: where,
      expanded: true,
      children,
    };
  };
  const walk = (e: RoutineEntry, level: number, seen: Set<string>, incoming: boolean): ReportNode[] => {
    const next: [RoutineEntry | undefined, number, string][] = incoming
      ? entries.filter((c) => c.calls.has(e.routine.key)).map((c) => [c, c.calls.get(e.routine.key)!.length, c.routine.key || c.routine.name])
      : [...e.calls].map(([key, tokens]) => [byKey.get(key), tokens.length, key]);
    const shown = next.slice(0, maxPerLevel);
    omitted += next.length - shown.length;
    const out: ReportNode[] = [];
    for (const [other, count, key] of shown) {
      if (!other) {
        // A procedure not in the workspace's .sql files (a system procedure, another database).
        out.push({ label: key.toLowerCase(), description: 'not in this workspace', icon: 'library', tone: 'info' });
        continue;
      }
      const id = `${other.index.source.file}#${other.routine.start}`;
      const again = seen.has(id);
      const deeper = !again && level < options.depth ? walk(other, level + 1, new Set([...seen, id]), incoming) : undefined;
      const n = node(other, count, deeper?.length ? deeper : undefined);
      if (again) n.description += ' · shown above';
      out.push(n);
    }
    return out;
  };
  const start = new Set([`${root.index.source.file}#${root.routine.start}`]);
  const roots: ReportNode[] = [];
  const summary: string[] = [];
  if (options.direction !== 'callees') {
    const callers = walk(root, 1, start, true);
    roots.push({ label: 'Called by', description: callers.length ? plural(callers.length, 'caller') : 'nothing in the workspace calls it', icon: 'call-incoming', expanded: true, children: callers });
    summary.push(plural(callers.length, 'caller'));
  }
  if (options.direction !== 'callers') {
    const callees = walk(root, 1, start, false);
    roots.push({ label: 'Calls', description: callees.length ? plural(callees.length, 'routine') : 'no procedures or functions', icon: 'call-outgoing', expanded: true, children: callees });
    summary.push(plural(callees.length, 'callee'));
  }
  const rootNode = node(root, 1, undefined);
  return {
    kind: 'callGraph',
    title: `Call graph of ${root.routine.name}`,
    description: [...summary, plural(options.depth, 'level')].join(', '),
    roots,
    warnings: omitted ? [`${plural(omitted, 'call')} left out: only the first ${maxPerLevel} are listed at each step.`] : [],
    fileHashes: hashes,
    subject: rootNode.location,
    controls: callGraphControls(options.depth, options.direction),
  };
}
