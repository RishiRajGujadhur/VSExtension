import * as path from 'path';
import * as ts from 'typescript';
import { ReportBuilder, ReportNode, Report, plural, shorten } from '../structure/report';
import { enclosingFunction, functionLabel } from '../structure/util';

export interface DuplicateOptions {
  /** Shortest run of statements compared. */
  minStatements: number;
  /** Smallest fragment, in syntax tokens, worth reporting. */
  minTokens: number;
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
function serialize(nodes: readonly ts.Node[]): Serialized {
  const parts: string[] = [];
  const values: string[] = [];
  const names = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (isMemberName(node)) {
        parts.push(`.${node.text}`);
      } else {
        let index = names.get(node.text);
        if (index === undefined) {
          index = names.size;
          names.set(node.text, index);
        }
        parts.push(`$${index}`);
        values.push(node.text);
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

/** Structural Duplicate Finder: runs of statements with the same shape, ignoring names and literal values. */
export function findDuplicates(sourceFiles: readonly ts.SourceFile[], options: DuplicateOptions): DuplicateGroup[] {
  const buckets = new Map<string, { tokens: number; fragments: Fragment[] }>();
  for (const sourceFile of sourceFiles) {
    for (const list of statementLists(sourceFile)) {
      const n = list.length;
      for (let i = 0; i < n; i++) {
        // Windows of at least minStatements; a whole short list counts when it is large enough.
        const shortest = Math.min(options.minStatements, n - i);
        for (let length = shortest; length <= Math.min(n - i, maxWindow); length++) {
          if (length < options.minStatements && !(i === 0 && length === n)) {
            continue;
          }
          const nodes = list.slice(i, i + length);
          const serialized = serialize(nodes);
          if (serialized.tokens < options.minTokens) {
            continue;
          }
          const bucket = buckets.get(serialized.key) ?? { tokens: serialized.tokens, fragments: [] };
          bucket.fragments.push({ sourceFile, nodes, start: nodes[0].getStart(sourceFile), end: nodes[nodes.length - 1].end, values: serialized.values });
          buckets.set(serialized.key, bucket);
        }
      }
    }
  }

  const candidates = [...buckets.values()]
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

export function duplicatesReport(sourceFiles: readonly ts.SourceFile[], options: DuplicateOptions, root?: string): Report {
  const groups = findDuplicates(sourceFiles, options);
  const builder = new ReportBuilder('duplicates', 'Structural duplicates');
  const where = (f: Fragment) => {
    const fn = enclosingFunction(f.nodes[0]);
    const file = root ? path.relative(root, f.sourceFile.fileName).replace(/\\/g, '/') : path.basename(f.sourceFile.fileName);
    return `${fn ? `${functionLabel(fn)} · ` : ''}${file}:${f.sourceFile.getLineAndCharacterOfPosition(f.start).line + 1}`;
  };
  const roots: ReportNode[] = groups.map((group, i) => ({
    label: `Duplicate ${i + 1}: ${plural(group.lines, 'line')} × ${group.fragments.length}`,
    description: shorten(group.fragments[0].nodes[0].getText().split('\n')[0], 50),
    tooltip: group.differences.length ? `Differs in: ${group.differences.join(', ')}` : 'Identical copies',
    icon: 'files',
    tone: 'warning',
    expanded: i < 5,
    action: {
      kind: 'compareDuplicates',
      copies: group.fragments.slice(0, 2).map((f) => ({ file: f.sourceFile.fileName, label: where(f), text: f.sourceFile.text.slice(f.start, f.end) })),
    },
    children: [
      ...group.fragments.map((f) => ({ label: where(f), icon: 'code', location: builder.span(f.sourceFile, f.start, f.end) })),
      {
        label: group.differences.length ? `differs in ${shorten(group.differences.join(', '), 80)}` : 'identical copies',
        icon: 'diff',
        tooltip: group.differences.join('\n'),
      },
    ],
  }));
  return builder.finish(roots, `${plural(groups.length, 'duplicate group')} in ${plural(sourceFiles.length, 'file')}`);
}
