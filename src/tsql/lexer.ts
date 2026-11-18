/**
 * A T-SQL tokenizer: words and keywords, [bracketed] and "quoted" names, @variables, strings (N'…' with '' inside),
 * numbers, operators and punctuation. Comments (-- and nested block comments) are kept as tokens of their own so callers can
 * skip them. Positions are character offsets into the text.
 */

export type TokenKind = 'word' | 'name' | 'variable' | 'string' | 'number' | 'operator' | 'punct' | 'comment';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Upper case for words, the bare name for [bracketed] and "quoted" names: what comparisons use. */
  value: string;
  start: number;
  end: number;
}

const wordStart = /[A-Za-z_#À-￿]/;
const wordPart = /[A-Za-z0-9_#$@À-￿]/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, value?: string) => tokens.push({ kind, text: text.slice(start, end), value: value ?? text.slice(start, end), start, end });
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comments nest in T-SQL.
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      push('comment', start, i);
      continue;
    }
    if (c === "'" || ((c === 'N' || c === 'n') && next === "'")) {
      i += c === "'" ? 1 : 2;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i++;
          break;
        } else i++;
      }
      push('string', start, i);
      continue;
    }
    if (c === '[') {
      i++;
      while (i < text.length) {
        if (text[i] === ']' && text[i + 1] === ']') i += 2;
        else if (text[i] === ']') {
          i++;
          break;
        } else i++;
      }
      push('name', start, i, text.slice(start + 1, i - 1).replace(/]]/g, ']'));
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      i++;
      push('name', start, i, text.slice(start + 1, i - 1));
      continue;
    }
    if (c === '@') {
      i++;
      while (i < text.length && wordPart.test(text[i])) i++;
      push('variable', start, i, text.slice(start, i).toUpperCase());
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      while (i < text.length && /[0-9.eE]/.test(text[i])) i++;
      push('number', start, i);
      continue;
    }
    if (wordStart.test(c)) {
      while (i < text.length && wordPart.test(text[i])) i++;
      push('word', start, i, text.slice(start, i).toUpperCase());
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['<>', '!=', '>=', '<=', '!<', '!>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::'].includes(two)) {
      i += 2;
      push('operator', start, i);
      continue;
    }
    i++;
    push('=<>+-*/%&|^~!'.includes(c) ? 'operator' : 'punct', start, i);
  }
  return tokens;
}

/** The tokens without comments. */
export const code = (tokens: Token[]): Token[] => tokens.filter((t) => t.kind !== 'comment');

/** A word token with this keyword value. */
export const isWord = (t: Token | undefined, ...words: string[]): boolean => !!t && t.kind === 'word' && words.includes(t.value);
