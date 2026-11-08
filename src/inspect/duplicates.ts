import * as path from 'path';
import ts = require('typescript');
import { ReportBuilder, ReportNode, Report, plural, shorten } from '../structure/report';
import { howToFix } from '../structure/howToFix';
import { enclosingFunction, functionLabel } from '../structure/util';
import { AnalysisError } from '../analysis/types';

export interface DuplicateOptions {
  /** Shortest run of statements compared. */
  minStatements: number;
  /** Smallest fragment, in syntax tokens, worth reporting. */
  minTokens: number;
  /** Treat property and method names like local names, so copies that use other properties still match. */
  matchRenamedProperties?: boolean;
}

export interface Fragment {
  sourceFile: ts.SourceFile;
  nodes: readonly ts.Node[];
  start: number;
  end: number;
  /** Identifier and literal texts in token order, to show what differs between copies. */
  values: string[];
}

export interface DuplicateGroup {
  fragments: Fragment[];
  tokens: number;
  lines: number;
  /** Renamed identifiers and changed literals between the first two copies, such as `total ↔ sum`. */
  differences: string[];
}

interface Serialized {
  key: string;
  tokens: number;
  values: string[];
}

/**
 * Serializes nodes to a structure fingerprint in which local names are numbered by first use and
 * literals keep only their kind, so copies with renamed variables and changed values match.
 */
function serialize(nodes: readonly ts.Node[], matchRenamedProperties = false): Serialized {
  const parts: string[] = [];
  const values: string[] = [];
  const names = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const member = isMemberName(node);
      if (member && !matchRenamedProperties) {
        parts.push(`.${node.text}`);
      } else {
        // Members are numbered apart from locals, so `x.x` keeps its shape.
        const key = member ? `.${node.text}` : node.text;
        let index = names.get(key);
        if (index === undefined) {
          index = names.size;
          names.set(key, index);
        }
        parts.push(`$${index}`);
        values.push(member ? `.${node.text}` : node.text);
      }
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)) {
      parts.push(`#${node.kind}`);
      values.push(node.getText());
      return;
    }
    if (ts.isJSDoc(node)) {
      return;
    }
    parts.push(String(node.kind));
    ts.forEachChild(node, visit);
    parts.push(')');
  };
  nodes.forEach(visit);
  return { key: parts.join(' '), tokens: parts.length, values };
}

function isMemberName(node: ts.Identifier | ts.PrivateIdentifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) &&
      parent.name === node) ||
    (ts.isJsxAttribute(parent) && parent.name === node) ||
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxClosingElement(parent) ||
    ts.isJsxSelfClosingElement(parent)
  );
}

function statementLists(sourceFile: ts.SourceFile): (readonly ts.Statement[])[] {
  const lists: (readonly ts.Statement[])[] = [sourceFile.statements];
  const visit = (node: ts.Node) => {
    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      lists.push(node.statements);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return lists;
}

const maxWindow = 40;

/** A statement's fingerprint tokens: fixed text, or a local name that is numbered per window. */
type Token = { fixed: number } | { name: string };

const fixedIds = new Map<string, number>();
const fixedId = (text: string) => {
  let id = fixedIds.get(text);
  if (id === undefined) {
    id = fixedIds.size + 1;
    fixedIds.set(text, id);
  }
  return id;
};

/** The same token sequence `serialize` produces for one statement, computed once per statement. */
function tokenize(node: ts.Node, matchRenamedProperties = false): Token[] {
  const tokens: Token[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
      const member = isMemberName(current);
      tokens.push(member && !matchRenamedProperties ? { fixed: fixedId(`.${current.text}`) } : { name: member ? `.${current.text}` : current.text });
      return;
    }
    if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) || ts.isBigIntLiteral(current) || ts.isRegularExpressionLiteral(current)) {
      tokens.push({ fixed: fixedId(`#${current.kind}`) });
      return;
    }
    if (ts.isJSDoc(current)) {
      return;
    }
    tokens.push({ fixed: fixedId(String(current.kind)) });
    ts.forEachChild(current, visit);
    tokens.push({ fixed: fixedId(')') });
  };
  visit(node);
  return tokens;
}

/** Structural Duplicate Finder: runs of statements with the same shape, ignoring names and literal values. */
export function findDuplicates(sourceFiles: readonly ts.SourceFile[], options: DuplicateOptions): DuplicateGroup[] {
  // Windows are fingerprinted incrementally: each statement is tokenized once, and extending a window by one
  // statement updates two running hashes instead of serializing the whole window again.
  const buckets = new Map<string, { tokens: number; fragments: Fragment[] }>();
  for (const sourceFile of sourceFiles) {
    for (const list of statementLists(sourceFile)) {
      const n = list.length;
      const tokenized = list.map((statement) => tokenize(statement, options.matchRenamedProperties));
      for (let i = 0; i < n; i++) {
        const names = new Map<string, number>();
        let h1 = 0x811c9dc5;
        let h2 = 0x12345678;
        let count = 0;
        for (let length = 1; length <= Math.min(n - i, maxWindow); length++) {
          for (const token of tokenized[i + length - 1]) {
            let value: number;
            if ('fixed' in token) {
              value = token.fixed;
            } else {
              let index = names.get(token.name);
              if (index === undefined) {
                index = names.size;
                names.set(token.name, index);
              }
              value = -1 - index;
            }
            h1 = Math.imul(h1 ^ value, 0x01000193) >>> 0;
            h2 = (Math.imul(h2, 31) + value + 0x9e3779b9) >>> 0;
            count++;
          }
          // Windows of at least minStatements; a whole short list counts when it is large enough.
          if ((length < options.minStatements && !(i === 0 && length === n)) || count < options.minTokens) {
            continue;
          }
          const key = `${h1}:${h2}:${count}`;
          const nodes = list.slice(i, i + length);
          const bucket = buckets.get(key) ?? { tokens: count, fragments: [] };
          bucket.fragments.push({ sourceFile, nodes, start: nodes[0].getStart(sourceFile), end: nodes[nodes.length - 1].end, values: [] });
          buckets.set(key, bucket);
        }
      }
    }
  }

  const candidates = [...buckets.values()]
    .filter((b) => b.fragments.length > 1)
    .map((b) => ({ ...b, fragments: withoutOverlaps(b.fragments) }))
    .filter((b) => b.fragments.length > 1)
    .sort((a, b) => b.tokens - a.tokens);

  // Keep only maximal duplicates: skip groups whose copies all lie inside already reported ones.
  const covered = new Map<ts.SourceFile, { start: number; end: number }[]>();
  const isCovered = (f: Fragment) => (covered.get(f.sourceFile) ?? []).some((c) => c.start <= f.start && f.end <= c.end);
  const groups: DuplicateGroup[] = [];
  for (const candidate of candidates) {
    if (candidate.fragments.every(isCovered)) {
      continue;
    }
    for (const fragment of candidate.fragments) {
      covered.set(fragment.sourceFile, [...(covered.get(fragment.sourceFile) ?? []), { start: fragment.start, end: fragment.end }]);
      fragment.values = serialize(fragment.nodes, options.matchRenamedProperties).values;
    }
    const first = candidate.fragments[0];
    groups.push({
      fragments: candidate.fragments,
      tokens: candidate.tokens,
      lines: lineSpan(first),
      differences: differences(candidate.fragments[0], candidate.fragments[1]),
    });
  }
  return groups;
}

function withoutOverlaps(fragments: Fragment[]): Fragment[] {
  const kept: Fragment[] = [];
  for (const fragment of fragments) {
    if (!kept.some((k) => k.sourceFile === fragment.sourceFile && k.start < fragment.end && fragment.start < k.end)) {
      kept.push(fragment);
    }
  }
  return kept;
}

function lineSpan(fragment: Fragment): number {
  const { sourceFile, start, end } = fragment;
  return sourceFile.getLineAndCharacterOfPosition(end).line - sourceFile.getLineAndCharacterOfPosition(start).line + 1;
}

function differences(a: Fragment, b: Fragment): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  a.values.forEach((value, i) => {
    const other = b.values[i];
    const pair = `${value} ↔ ${other}`;
    if (other !== undefined && other !== value && !seen.has(pair)) {
      seen.add(pair);
      result.push(pair);
    }
  });
  return result;
}

/** The statements of one list that lie inside the range, such as a selection in the editor. */
function statementsIn(sourceFile: ts.SourceFile, start: number, end: number): readonly ts.Statement[] {
  let best: readonly ts.Statement[] = [];
  for (const list of statementLists(sourceFile)) {
    const inside = list.filter((statement) => statement.getStart(sourceFile) >= start && statement.end <= end);
    if (inside.length > best.length) {
      best = inside;
    }
  }
  return best;
}

/** Every run of statements with the same structure as the selected ones, including the selection itself. */
export function findCopies(sourceFiles: readonly ts.SourceFile[], sourceFile: ts.SourceFile, start: number, end: number): DuplicateGroup | undefined {
  const selected = statementsIn(sourceFile, start, end);
  if (selected.length === 0) {
    return undefined;
  }
  const target = serialize(selected);
  const fragments: Fragment[] = [];
  for (const file of sourceFiles) {
    for (const list of statementLists(file)) {
      for (let i = 0; i + selected.length <= list.length; i++) {
        const nodes = list.slice(i, i + selected.length);
        const serialized = serialize(nodes);
        if (serialized.key === target.key) {
          fragments.push({ sourceFile: file, nodes, start: nodes[0].getStart(file), end: nodes[nodes.length - 1].end, values: serialized.values });
        }
      }
    }
  }
  // The selection first, so differences read from it to each copy.
  fragments.sort((a, b) => Number(b.nodes[0] === selected[0]) - Number(a.nodes[0] === selected[0]));
  return { fragments, tokens: target.tokens, lines: lineSpan(fragments[0]), differences: fragments.length > 1 ? differences(fragments[0], fragments[1]) : [] };
}

/** Find Copies of the Selection: the selected statements and every structural copy of them. */
export function copiesReport(sourceFiles: readonly ts.SourceFile[], sourceFile: ts.SourceFile, start: number, end: number, root?: string): Report {
  const group = findCopies(sourceFiles, sourceFile, start, end);
  if (!group) {
    throw new AnalysisError('Select whole statements to find copies.');
  }
  const report = duplicatesReport(sourceFiles, { minStatements: 1, minTokens: 0 }, root, [group]);
  report.title = 'Copies of the selection';
  report.roots[0].label = `Selection and ${plural(group.fragments.length - 1, 'copy', 'copies')}: ${plural(group.lines, 'line')}`;
  if (group.fragments.length < 2) {
    report.warnings.push(`No other run of ${plural(group.fragments[0].nodes.length, 'statement')} has this structure in ${plural(sourceFiles.length, 'file')}.`);
  }
  return report;
}

export function duplicatesReport(sourceFiles: readonly ts.SourceFile[], options: DuplicateOptions, root?: string, found?: DuplicateGroup[]): Report {
  // Biggest payoff first: the lines that consolidating the copies would remove.
  const repeated = (g: DuplicateGroup) => g.lines * (g.fragments.length - 1);
  const groups = found ?? findDuplicates(sourceFiles, options).sort((a, b) => repeated(b) - repeated(a));
  const builder = new ReportBuilder('duplicates', 'Structural duplicates');
  if (groups.length === 0) {
    builder.warnings.push(
      `No run of ${plural(options.minStatements, 'statement')} and ${options.minTokens}+ syntax tokens repeats in ${plural(sourceFiles.length, 'file')}. ` +
        'Lower tsStructure.duplicates.minStatements or minTokens to find smaller copies.',
    );
  }
  const where = (f: Fragment) => {
    const fn = enclosingFunction(f.nodes[0]);
    const file = root ? path.relative(root, f.sourceFile.fileName).replace(/\\/g, '/') : path.basename(f.sourceFile.fileName);
    return `${fn ? `${functionLabel(fn)} · ` : ''}${file}:${f.sourceFile.getLineAndCharacterOfPosition(f.start).line + 1}`;
  };
  const roots: ReportNode[] = groups.map((group, i) => ({
    label: `Duplicate ${i + 1}: ${plural(group.lines, 'line')} × ${group.fragments.length}, ${repeated(group)} repeated`,
    description: shorten(group.fragments[0].nodes[0].getText().split('\n')[0], 50),
    tooltip: `${group.differences.length ? `Differs in: ${group.differences.join(', ')}` : 'Identical copies'}\n\n\`\`\`ts\n${group.fragments[0].sourceFile.text.slice(group.fragments[0].start, group.fragments[0].end).split('\n').slice(0, 8).join('\n')}\n\`\`\``,
    icon: 'files',
    tone: 'warning',
    expanded: i < 5,
    action: {
      kind: 'compareDuplicates',
      copies: group.fragments.slice(0, 20).map((f) => ({ file: f.sourceFile.fileName, label: where(f), text: f.sourceFile.text.slice(f.start, f.end) })),
    },
    children: [
      ...group.fragments.map((f) => ({ label: where(f), description: plural(group.lines, 'line'), icon: 'code', location: builder.span(f.sourceFile, f.start, f.end), action: { kind: 'refactor' } })),
      {
        label: group.differences.length ? `differs in ${shorten(group.differences.join(', '), 80)}` : 'identical copies',
        icon: 'diff',
        tooltip: group.differences.join('\n'),
      },
    ],
  }));
  if (groups.length) {
    roots.push(
      howToFix([
        'Extract the copied lines into one function, with a parameter for each difference listed under the copy.',
        'Start with the group that repeats the most lines; it is listed first.',
        'Leave copies that are expected to change separately, such as test setup; a little repetition is fine there.',
      ]),
    );
  }
  const total = groups.reduce((n, g) => n + repeated(g), 0);
  return builder.finish(roots, `${plural(groups.length, 'duplicate group')} in ${plural(sourceFiles.length, 'file')}${total ? `, ${plural(total, 'repeated line')}` : ''}`);
}
