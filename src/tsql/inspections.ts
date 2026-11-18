import type { Severity } from '../inspect/inspection';
import { Token, code, isWord, tokenize } from './lexer';
import { Statement, routines } from './parser';

/**
 * Inspections for T-SQL, from the tokens and statements: patterns that are wrong (or risky) wherever they appear, so
 * they can be reported without knowing the database's schema. Each finding is a character range in the file.
 */

export interface TsqlFinding {
  inspection: string;
  message: string;
  severity: Severity;
  start: number;
  end: number;
}

export const tsqlInspections: { id: string; title: string; severity: Severity }[] = [
  { id: 'tsqlUpdateWithoutWhere', title: 'UPDATE or DELETE without WHERE (T-SQL)', severity: 'warning' },
  { id: 'tsqlNullComparison', title: '= NULL instead of IS NULL (T-SQL)', severity: 'warning' },
  { id: 'tsqlEmptyCatch', title: 'Empty CATCH block (T-SQL)', severity: 'warning' },
  { id: 'tsqlNoLock', title: 'NOLOCK or READ UNCOMMITTED (T-SQL)', severity: 'warning' },
  { id: 'tsqlIdentity', title: '@@IDENTITY instead of SCOPE_IDENTITY() (T-SQL)', severity: 'warning' },
  { id: 'tsqlSelectStar', title: 'SELECT * (T-SQL)', severity: 'info' },
  { id: 'tsqlTopWithoutOrderBy', title: 'TOP without ORDER BY (T-SQL)', severity: 'info' },
  { id: 'tsqlDeprecatedType', title: 'ntext or image type (T-SQL)', severity: 'info' },
  { id: 'tsqlNoCount', title: 'Procedure without SET NOCOUNT ON (T-SQL)', severity: 'hint' },
];
const severityOf = new Map(tsqlInspections.map((i) => [i.id, i.severity]));

/** Each simple statement's tokens, wherever it is nested, and the empty CATCH blocks. */
function walk(statements: Statement[], simple: Token[][], emptyCatches: Statement[]): void {
  for (const s of statements) {
    if (s.kind === 'simple' || s.kind === 'return' || s.kind === 'throw') simple.push(s.tokens);
    if (s.kind === 'if' || s.kind === 'while') simple.push(s.tokens);
    if (s.kind === 'try' && !s.handler?.length) emptyCatches.push(s);
    walk([...(s.statements ?? []), ...(s.handler ?? []), ...(s.body ? [s.body] : []), ...(s.otherwise ? [s.otherwise] : [])], simple, emptyCatches);
  }
}

/** The tokens at the top level of a statement (outside parentheses), with their index. */
const topLevel = (tokens: Token[]) => {
  let depth = 0;
  return tokens.filter((t) => {
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    return depth === 0 && t.text !== ')';
  });
};

export function inspectTsql(text: string): TsqlFinding[] {
  const findings: TsqlFinding[] = [];
  const report = (inspection: string, from: Token, to: Token, message: string) =>
    findings.push({ inspection, message, severity: severityOf.get(inspection) ?? 'warning', start: from.start, end: to.end });
  const tokens = code(tokenize(text));

  // Whole-file patterns.
  tokens.forEach((t, i) => {
    if (t.kind === 'variable' && t.value === '@@IDENTITY') report('tsqlIdentity', t, t, '@@IDENTITY can return an id made by a trigger. Use SCOPE_IDENTITY() (or OUTPUT INSERTED.Id).');
    if (isWord(t, 'NOLOCK', 'READUNCOMMITTED') && tokens[i - 1]?.text !== '.') report('tsqlNoLock', t, t, `${t.text} reads uncommitted data: rows can be missed, read twice or rolled back later.`);
    if (isWord(t, 'UNCOMMITTED') && isWord(tokens[i - 1], 'READ')) report('tsqlNoLock', tokens[i - 1], t, 'READ UNCOMMITTED reads uncommitted data: rows can be missed, read twice or rolled back later.');
    if (isWord(t, 'NTEXT', 'IMAGE') && tokens[i - 1]?.text !== '.' && tokens[i + 1]?.text !== '(') report('tsqlDeprecatedType', t, t, `${t.text} is deprecated: use ${t.value === 'NTEXT' ? 'nvarchar(max)' : 'varbinary(max)'}.`);
    // = NULL is never true: the comparison is unknown.
    if ((t.text === '=' || t.text === '<>' || t.text === '!=') && isWord(tokens[i + 1], 'NULL')) {
      let depth = 0;
      let clause: Token | undefined;
      for (let j = i - 1; j >= 0; j--) {
        const b = tokens[j];
        if (b.text === ')') depth++;
        if (b.text === '(') {
          if (depth === 0) break;
          depth--;
        }
        if (depth === 0 && (isWord(b, 'WHERE', 'ON', 'WHEN', 'HAVING', 'AND', 'OR', 'IF', 'WHILE', 'SET', 'SELECT', 'VALUES', 'DECLARE', 'UPDATE') || b.text === ',')) {
          clause = b;
          break;
        }
      }
      if (t.text !== '=' || isWord(clause, 'WHERE', 'ON', 'WHEN', 'HAVING', 'AND', 'OR', 'IF', 'WHILE')) {
        report('tsqlNullComparison', t, tokens[i + 1], `${t.text} NULL is never true: use ${t.text === '=' ? 'IS NULL' : 'IS NOT NULL'}.`);
      }
    }
  });

  for (const routine of routines(text)) {
    const simple: Token[][] = [];
    const emptyCatches: Statement[] = [];
    walk(routine.body, simple, emptyCatches);
    for (const s of emptyCatches) {
      const at = tokens.find((t) => t.start >= s.start && isWord(t, 'CATCH'));
      if (at) report('tsqlEmptyCatch', at, at, 'Empty CATCH block: the error is swallowed. Handle it, log it, or THROW it again.');
    }
    if (routine.kind === 'procedure') {
      const all = tokens.filter((t) => t.start >= routine.start && t.end <= routine.end);
      if (!all.some((t, i) => isWord(t, 'NOCOUNT') && isWord(all[i - 1], 'SET'))) {
        const name = tokens.find((t) => t.start >= routine.nameStart && t.end <= routine.nameEnd && t.text !== '.') ?? all[0];
        report('tsqlNoCount', name, tokens.find((t) => t.end === routine.nameEnd) ?? name, 'No SET NOCOUNT ON: each statement sends a "rows affected" message, which some clients misread as a result.');
      }
    }
    for (const statement of simple) {
      const first = statement[0];
      const top = topLevel(statement);
      // UPDATE … / DELETE … with no WHERE changes every row (table variables and temp tables excepted).
      if (isWord(first, 'UPDATE', 'DELETE') && !top.some((t) => isWord(t, 'WHERE')) && !top.some((t, i) => isWord(t, 'CURRENT') && isWord(top[i + 1], 'OF'))) {
        const target = statement.find((t, i) => i > 0 && !isWord(t, 'FROM', 'TOP') && t.text !== '(' && t.kind !== 'number' && t.text !== ')');
        if (target && target.kind !== 'variable' && !target.text.startsWith('#')) report('tsqlUpdateWithoutWhere', first, target, `${first.value} without WHERE changes every row of ${target.kind === 'name' ? target.value : target.text}.`);
      }
      // SELECT * and SELECT t.* (not inside EXISTS (…) or COUNT(*)).
      statement.forEach((t, i) => {
        if (!isWord(t, 'SELECT')) return;
        let j = i + 1;
        while (isWord(statement[j], 'DISTINCT', 'ALL')) j++;
        if (isWord(statement[j], 'TOP')) {
          j++;
          if (statement[j]?.text === '(') while (j < statement.length && statement[j].text !== ')') j++;
          j++;
          while (isWord(statement[j], 'PERCENT', 'WITH', 'TIES')) j++;
        }
        const star = statement[j]?.text === '*' ? statement[j] : statement[j + 1]?.text === '.' && statement[j + 2]?.text === '*' ? statement[j + 2] : undefined;
        const inExists = isWord(statement[i - 2], 'EXISTS') && statement[i - 1]?.text === '(';
        if (star && !inExists) report('tsqlSelectStar', t, star, 'SELECT * returns whatever columns the table has today: name the columns this code needs.');
      });
      // TOP without ORDER BY returns any rows, not the first ones.
      const topAt = top.findIndex((t) => isWord(t, 'TOP'));
      if (topAt >= 0 && isWord(top[0], 'SELECT') && !top.some((t, i) => isWord(t, 'ORDER') && isWord(top[i + 1], 'BY'))) {
        report('tsqlTopWithoutOrderBy', top[topAt], top[topAt], 'TOP without ORDER BY returns any rows, in no particular order.');
      }
    }
  }
  return findings.sort((a, b) => a.start - b.start);
}
