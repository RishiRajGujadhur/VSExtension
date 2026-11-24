import type { Node as SyntaxNode } from 'web-tree-sitter';
import { AnalysisError } from '../analysis/types';
import { hashText } from '../analysis/paths';
import { Report, ReportNode, plural } from '../structure/report';
import type { CSharpSource } from './charts';
import { functionName, functionTypes } from './flow';
import { parseCSharp } from './parser';

/**
 * Search by shape in C#, from the bundled parser: a piece of C# with placeholders such as `$x$` is parsed, and every
 * piece of code in the workspace's C# files with the same syntax tree is found. A placeholder stands for any one
 * expression, name or statement; the same placeholder twice must stand for the same code. Spaces, line breaks and
 * comments do not matter. As for TypeScript (src/search/structuralSearch.ts), but by syntax only: there are no type
 * constraints, and replacing is left to the TypeScript search.
 */

const PLACEHOLDER = /\$([A-Za-z_]\w*)\$/g;
const prefix = '__xray_';
const kids = (n: SyntaxNode): SyntaxNode[] => n.namedChildren.filter((c): c is SyntaxNode => !!c && c.type !== 'comment');

/** The pattern's syntax: an expression, a statement or several, or a member, whichever it parses as cleanly. */
async function patternTree(pattern: string): Promise<{ nodes: SyntaxNode[]; free: () => void }> {
  const code = pattern.trim().replace(PLACEHOLDER, (_, name: string) => `${prefix}${name}`);
  if (!code) throw new AnalysisError('Type the code to look for, with $name$ for any part, such as $list$.Count == 0.');
  const tries: [string, (root: SyntaxNode) => SyntaxNode[] | undefined][] = [
    // A statement or statements, in a method body.
    [`class ${prefix}P { void ${prefix}M() { ${/[;}]$/.test(code) ? code : `${code};`} } }`, (root) => {
      const block = root.descendantsOfType('block')[0];
      const statements = block ? kids(block) : [];
      if (statements.length === 1 && statements[0].type === 'expression_statement' && !/;$/.test(code)) return kids(statements[0]).slice(0, 1);
      return statements.length ? statements : undefined;
    }],
    // An expression that is not a statement on its own (`a == b`): as a value.
    [`class ${prefix}P { void ${prefix}M() { var ${prefix}v = ${code}; } }`, (root) => {
      const declarator = root.descendantsOfType('variable_declarator')[0];
      const value = declarator ? kids(declarator).filter((c) => c.type !== 'identifier' || !c.text.startsWith(`${prefix}v`)) : [];
      const expression = value[0]?.type === 'equals_value_clause' ? kids(value[0])[0] : value[0];
      return expression ? [expression] : undefined;
    }],
    // A member: a method, property or field.
    [`class ${prefix}P { ${code} }`, (root) => {
      const list = root.descendantsOfType('declaration_list')[0];
      return list ? kids(list) : undefined;
    }],
  ];
  for (const [wrapped, pick] of tries) {
    const tree = await parseCSharp(wrapped);
    if (!tree.rootNode.hasError) {
      const nodes = pick(tree.rootNode);
      if (nodes?.length) return { nodes, free: () => tree.delete() };
    }
    tree.delete();
  }
  throw new AnalysisError('That is not C# the parser can read. Write an expression, statements or a member, with $name$ for any part.');
}

const placeholderOf = (n: SyntaxNode) => {
  const id = n.type === 'identifier' ? n : n.type === 'expression_statement' && kids(n).length === 1 && kids(n)[0].type === 'identifier' ? kids(n)[0] : undefined;
  return id && id.text.startsWith(prefix) ? id.text.slice(prefix.length) : undefined;
};
const flat = (text: string) => text.replace(/\s+/g, '');

/** Whether the code node has the pattern node's shape; placeholders bind to the code they stand for. */
function matches(pattern: SyntaxNode, code: SyntaxNode, bound: Map<string, string>): boolean {
  const name = placeholderOf(pattern);
  if (name) {
    const before = bound.get(name);
    if (before !== undefined) return flat(before) === flat(code.text);
    bound.set(name, code.text.replace(/\s+/g, ' ').trim());
    return true;
  }
  if (pattern.type !== code.type) return false;
  const p = kids(pattern);
  const c = kids(code);
  if (!p.length) return pattern.text === code.text;
  if (p.length !== c.length) return false;
  // Operators and keywords are unnamed children: they must be the same too (== against !=).
  const tokens = (n: SyntaxNode) => n.children.filter((x): x is SyntaxNode => !!x && !x.isNamed).map((x) => x.text).join(' ');
  if (tokens(pattern) !== tokens(code)) return false;
  return p.every((child, i) => matches(child, c[i], bound));
}

export interface CSharpShapeMatch {
  file: string;
  start: number;
  end: number;
  line: number;
  text: string;
  bindings: Record<string, string>;
  within: string;
}

/** Every piece of code in the files with the pattern's shape. */
export async function searchCSharpShape(sources: CSharpSource[], pattern: string): Promise<CSharpShapeMatch[]> {
  const { nodes: wanted, free } = await patternTree(pattern);
  const found: CSharpShapeMatch[] = [];
  try {
    for (const s of sources) {
      const tree = await parseCSharp(s.text);
      try {
        const visit = (n: SyntaxNode) => {
          // A run of statements: each place in a block where they follow each other.
          const children = kids(n);
          if (wanted.length > 1) {
            for (let i = 0; i + wanted.length <= children.length; i++) {
              const bound = new Map<string, string>();
              if (wanted.every((w, k) => matches(w, children[i + k], bound))) record(children[i], children[i + wanted.length - 1], bound);
            }
          } else {
            const bound = new Map<string, string>();
            if (n.parent && matches(wanted[0], n, bound)) record(n, n, bound);
          }
          for (const c of children) visit(c);
        };
        const record = (from: SyntaxNode, to: SyntaxNode, bound: Map<string, string>) => {
          let fn: SyntaxNode | null = from.parent;
          while (fn && !functionTypes.has(fn.type)) fn = fn.parent;
          found.push({ file: s.file, start: from.startIndex, end: to.endIndex, line: from.startPosition.row, text: s.text.slice(from.startIndex, to.endIndex), bindings: Object.fromEntries(bound), within: fn ? functionName(fn) : 'class level' });
        };
        visit(tree.rootNode);
      } finally {
        tree.delete();
      }
    }
  } finally {
    free();
  }
  return found;
}

/** The matches as a report: by file, each with what the placeholders stood for. */
export async function csharpShapeReport(sources: CSharpSource[], pattern: string, root?: string): Promise<Report> {
  const found = await searchCSharpShape(sources, pattern);
  const byFile = new Map<string, CSharpShapeMatch[]>();
  for (const m of found) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  const text = new Map(sources.map((s) => [s.file, s.text]));
  const relative = (file: string) => (root && file.toLowerCase().startsWith(root.toLowerCase()) ? file.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : (file.split(/[\\/]/).pop() ?? file));
  const position = (file: string, offset: number) => {
    const t = text.get(file) ?? '';
    return { line: t.slice(0, offset).split('\n').length - 1, character: offset - (t.lastIndexOf('\n', offset - 1) + 1) };
  };
  const roots: ReportNode[] = [...byFile].map(([file, matches]) => ({
    label: file.split(/[\\/]/).pop() ?? file,
    description: `${relative(file)} · ${matches.length}`,
    icon: 'file-code',
    expanded: byFile.size <= 5,
    children: matches.map((m) => {
      const from = position(file, m.start);
      const to = position(file, m.end);
      const bound = Object.entries(m.bindings).map(([k, v]) => `$${k}$ = ${v.length > 30 ? `${v.slice(0, 29)}…` : v}`).join(', ');
      return {
        label: m.text.replace(/\s+/g, ' ').trim().slice(0, 90),
        description: [`line ${m.line + 1}`, m.within, bound].filter(Boolean).join(' · '),
        icon: 'search',
        location: { file, line: from.line, character: from.character, endLine: to.line, endCharacter: to.character },
      };
    }),
  }));
  const fileHashes: Record<string, string> = {};
  for (const file of byFile.keys()) fileHashes[file] = hashText(text.get(file) ?? '');
  return {
    kind: 'structuralSearch',
    title: `Search by shape: ${pattern.trim()}`,
    description: found.length ? `${plural(found.length, 'match', 'matches')} in ${plural(byFile.size, 'file')}` : 'no matches',
    roots,
    warnings: found.length ? [] : [`Nothing in ${plural(sources.length, 'C# file')} has that shape.`],
    fileHashes,
  };
}
