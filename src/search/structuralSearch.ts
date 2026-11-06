import * as path from 'path';
import * as ts from 'typescript';
import { pathKey } from '../analysis/paths';
import { projectSourceFiles } from '../analysis/referenceIndex';
import { introducedErrors } from '../refactor/common';
import { RefactorError, RefactorResult } from '../refactor/types';
import { VirtualProject } from '../refactor/virtualProject';
import { typeText } from '../structure/util';
import { Report, ReportBuilder, ReportNode, plural, shorten } from '../structure/report';

/** Limits on what a placeholder may match. Regular expressions are tested against the node's text or type. */
export interface PlaceholderConstraint {
  name: string;
  /** Tested against the matched expression's type, such as `^Promise<` or `string|number`. */
  type?: string;
  /** Tested against the matched source text. */
  text?: string;
  /** Inverts both tests. */
  negate?: boolean;
}

export interface SearchSpec {
  pattern: string;
  constraints?: PlaceholderConstraint[];
}

export interface CompiledPattern {
  /** One node for expression and single-statement patterns, several for statement sequences. */
  nodes: readonly ts.Node[];
  kind: 'expression' | 'statements';
  placeholders: { name: string; list: boolean }[];
  constraints: Map<string, { type?: RegExp; text?: RegExp; negate: boolean }>;
}

export interface Match {
  sourceFile: ts.SourceFile;
  start: number;
  end: number;
  nodes: readonly ts.Node[];
  bindings: Map<string, readonly ts.Node[]>;
}

type Bindings = Map<string, readonly ts.Node[]>;

const placeholderSyntax = /\$([A-Za-z_][\w]*)(\*?)\$/g;
const prefix = '__ss_';
const listSuffix = '__list';

/** Placeholders in a pattern, in order of appearance, as `$name$` or `$name*$` for lists. */
export function placeholdersIn(pattern: string): { name: string; list: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const match of pattern.matchAll(placeholderSyntax)) {
    if (!seen.has(match[1])) {
      seen.set(match[1], match[2] === '*');
    }
  }
  return [...seen].map(([name, list]) => ({ name, list }));
}

function parseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/** Parses a pattern such as `$a$.forEach($fn$)` or `if ($c$) { $body*$ }` into a syntax tree to match against. */
export function compilePattern(spec: SearchSpec): CompiledPattern {
  const source = spec.pattern.trim();
  if (!source) {
    throw new RefactorError('Enter a search pattern, for example $list$.forEach($callback$).');
  }
  const replaced = source.replace(placeholderSyntax, (_, name: string, list: string) => `${prefix}${name}${list ? listSuffix : ''}`);
  const constraints = new Map<string, { type?: RegExp; text?: RegExp; negate: boolean }>();
  for (const c of spec.constraints ?? []) {
    try {
      constraints.set(c.name, { type: c.type ? new RegExp(c.type) : undefined, text: c.text ? new RegExp(c.text) : undefined, negate: !!c.negate });
    } catch (error) {
      throw new RefactorError(`Invalid regular expression for $${c.name}$: ${(error as Error).message}`);
    }
  }
  const placeholders = placeholdersIn(source);

  // An expression first, wrapped so object literals are not read as blocks.
  if (!/;\s*$/.test(source)) {
    const asExpression = ts.createSourceFile('pattern.tsx', `(${replaced}\n);`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const statement = asExpression.statements[0];
    if (parseDiagnostics(asExpression).length === 0 && asExpression.statements.length === 1 && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)) {
      const expression = statement.expression.expression;
      if (placeholderOf(expression)) {
        throw new RefactorError('A lone placeholder matches everything. Add code around it.');
      }
      return { nodes: [expression], kind: 'expression', placeholders, constraints };
    }
  }
  const asStatements = ts.createSourceFile('pattern.tsx', replaced, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = parseDiagnostics(asStatements);
  if (errors.length > 0) {
    throw new RefactorError(`Invalid pattern: ${ts.flattenDiagnosticMessageText(errors[0].messageText, ' ')}`);
  }
  if (asStatements.statements.length === 0) {
    throw new RefactorError('The pattern is empty.');
  }
  return { nodes: asStatements.statements, kind: 'statements', placeholders, constraints };
}

interface Placeholder {
  name: string;
  list: boolean;
}

function placeholderOf(node: ts.Node): Placeholder | undefined {
  let current = node;
  if (ts.isExpressionStatement(current)) {
    current = current.expression;
  }
  if (ts.isSpreadElement(current) || ts.isSpreadAssignment(current)) {
    current = current.expression;
  }
  if (ts.isShorthandPropertyAssignment(current)) {
    current = current.name;
  }
  if (ts.isParameter(current) && !current.type && !current.initializer && ts.isIdentifier(current.name)) {
    current = current.name;
  }
  if (ts.isTypeReferenceNode(current) && !current.typeArguments && ts.isIdentifier(current.typeName)) {
    current = current.typeName;
  }
  if (!ts.isIdentifier(current) || !current.text.startsWith(prefix)) {
    return undefined;
  }
  const raw = current.text.slice(prefix.length);
  return raw.endsWith(listSuffix) ? { name: raw.slice(0, -listSuffix.length), list: true } : { name: raw, list: false };
}

const ignoredKeys = new Set([
  'parent', 'pos', 'end', 'flags', 'kind', 'modifierFlagsCache', 'transformFlags', 'id', 'symbol', 'localSymbol', 'locals',
  'nextContainer', 'flowNode', 'endFlowNode', 'returnFlowNode', 'emitNode', 'original', 'jsDoc', 'jsDocCache', 'jsDocComment',
  'escapedText', 'text', 'rawText', 'hasExtendedUnicodeEscape', 'numericLiteralFlags', 'templateFlags', 'identifierFlags',
  'resolvedSymbol', 'contextualType', 'inferenceContext', 'autoGenerate', 'singleQuote', 'isUnterminated', 'hasTrailingComma',
  // Formatting, not structure.
  'multiLine',
]);

/** Optional parts that a pattern may leave out and still match: `const $x$ = $v$` matches annotated declarations. */
const lenientKeys = new Set(['type', 'typeArguments', 'typeParameters', 'exclamationToken', 'asteriskToken', 'modifiers', 'questionToken']);

function isNode(value: unknown): value is ts.Node {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as ts.Node).kind === 'number' && typeof (value as ts.Node).pos === 'number';
}

function isNodeArray(value: unknown): value is ts.NodeArray<ts.Node> {
  return Array.isArray(value) && 'pos' in value;
}

function normalized(nodes: readonly ts.Node[]): string {
  return nodes.map((n) => n.getText().replace(/\s+/g, ' ')).join(', ');
}

/** Matches pattern trees against code, with typed and textual constraints on placeholders. */
export class Matcher {
  constructor(
    private readonly compiled: CompiledPattern,
    private readonly checker?: ts.TypeChecker,
  ) {}

  private bind(placeholder: Placeholder, nodes: readonly ts.Node[], bindings: Bindings): boolean {
    const constraint = this.compiled.constraints.get(placeholder.name);
    if (constraint) {
      for (const node of nodes) {
        let ok = true;
        if (constraint.text && !constraint.text.test(node.getText())) {
          ok = false;
        }
        if (ok && constraint.type) {
          if (!this.checker) {
            ok = false;
          } else {
            const type = this.checker.getTypeAtLocation(node);
            ok = constraint.type.test(typeText(this.checker, type, node)) || constraint.type.test(typeText(this.checker, this.checker.getBaseTypeOfLiteralType(type), node));
          }
        }
        if (ok === constraint.negate) {
          return false;
        }
      }
    }
    if (placeholder.name === '_') {
      return true;
    }
    const existing = bindings.get(placeholder.name);
    if (existing) {
      return normalized(existing) === normalized(nodes);
    }
    bindings.set(placeholder.name, nodes);
    return true;
  }

  matchNode(pattern: ts.Node, target: ts.Node, bindings: Bindings): boolean {
    const placeholder = placeholderOf(pattern);
    if (placeholder && !placeholder.list) {
      // `$s$;` as a statement matches any statement; otherwise the target must be an expression-like node.
      if (ts.isExpressionStatement(pattern) && !ts.isStatement(target)) {
        return false;
      }
      const bound = ts.isExpressionStatement(pattern) && ts.isExpressionStatement(target) ? target.expression : target;
      return this.bind(placeholder, [bound], bindings);
    }
    if (pattern.kind !== target.kind) {
      if (ts.isParenthesizedExpression(target) && !ts.isParenthesizedExpression(pattern)) {
        return this.matchNode(pattern, target.expression, bindings);
      }
      return false;
    }
    if (ts.isIdentifier(pattern) || ts.isPrivateIdentifier(pattern) || ts.isStringLiteralLike(pattern) || ts.isNumericLiteral(pattern) || ts.isBigIntLiteral(pattern) || ts.isRegularExpressionLiteral(pattern)) {
      return (pattern as ts.Identifier).text === (target as ts.Identifier).text;
    }
    if (ts.isVariableDeclarationList(pattern) && (pattern.flags & ts.NodeFlags.BlockScoped) !== (target.flags & ts.NodeFlags.BlockScoped)) {
      return false;
    }
    const keys = new Set([...Object.keys(pattern), ...Object.keys(target)]);
    for (const key of keys) {
      if (ignoredKeys.has(key)) {
        continue;
      }
      const p = (pattern as unknown as Record<string, unknown>)[key];
      const t = (target as unknown as Record<string, unknown>)[key];
      if (p === undefined && t === undefined) {
        continue;
      }
      if (p === undefined) {
        if (lenientKeys.has(key) && (isNode(t) || isNodeArray(t))) {
          continue;
        }
        if (isNode(t) || isNodeArray(t)) {
          return false;
        }
        continue;
      }
      if (isNodeArray(p)) {
        if (!isNodeArray(t) || !this.matchList(p, t, bindings)) {
          return false;
        }
      } else if (isNode(p)) {
        if (!isNode(t) || !this.matchNode(p, t, bindings)) {
          return false;
        }
      } else if (typeof p !== 'object' && typeof p !== 'function' && p !== t && key !== 'isTypeOnly') {
        return false;
      }
    }
    return true;
  }

  /** Matches lists, where `$name*$` placeholders take any number of consecutive items. */
  matchList(patterns: readonly ts.Node[], targets: readonly ts.Node[], bindings: Bindings, i = 0, j = 0): boolean {
    if (i === patterns.length) {
      return j === targets.length;
    }
    const placeholder = placeholderOf(patterns[i]);
    if (placeholder?.list) {
      for (let k = j; k <= targets.length; k++) {
        const snapshot = new Map(bindings);
        if (this.bind(placeholder, targets.slice(j, k), bindings) && this.matchList(patterns, targets, bindings, i + 1, k)) {
          return true;
        }
        restore(bindings, snapshot);
      }
      return false;
    }
    if (j >= targets.length) {
      return false;
    }
    const snapshot = new Map(bindings);
    if (this.matchNode(patterns[i], targets[j], bindings) && this.matchList(patterns, targets, bindings, i + 1, j + 1)) {
      return true;
    }
    restore(bindings, snapshot);
    return false;
  }

  /** All matches in a file, outermost first within each position. */
  search(sourceFile: ts.SourceFile): Match[] {
    const matches: Match[] = [];
    const { nodes, kind } = this.compiled;
    const single = nodes.length === 1 ? nodes[0] : undefined;
    const visit = (node: ts.Node) => {
      if (single) {
        const bindings: Bindings = new Map();
        if ((kind === 'expression' ? ts.isExpression(node) : ts.isStatement(node)) && this.matchNode(single, node, bindings)) {
          matches.push({ sourceFile, start: node.getStart(sourceFile), end: node.end, nodes: [node], bindings });
        }
      } else if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        this.searchSequence(sourceFile, node.statements, matches);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return matches;
  }

  private searchSequence(sourceFile: ts.SourceFile, statements: readonly ts.Statement[], matches: Match[]): void {
    for (let start = 0; start < statements.length; start++) {
      for (let end = start + 1; end <= statements.length; end++) {
        const slice = statements.slice(start, end);
        const bindings: Bindings = new Map();
        if (this.matchList(this.compiled.nodes, slice, bindings)) {
          matches.push({ sourceFile, start: slice[0].getStart(sourceFile), end: slice[slice.length - 1].end, nodes: slice, bindings });
          start = end - 1;
          break;
        }
      }
    }
  }
}

function restore(bindings: Bindings, snapshot: Bindings): void {
  bindings.clear();
  snapshot.forEach((value, key) => bindings.set(key, value));
}

export interface SearchScope {
  /** Only these files; otherwise every project source file. */
  files?: readonly string[];
  isExcluded?: (fileName: string) => boolean;
  /** Only matches inside this range of offsets, such as the editor's selection; used with a single file. */
  range?: { start: number; end: number };
}

/** Structural Search across a project. */
export function structuralSearch(program: ts.Program, spec: SearchSpec, scope: SearchScope = {}): Match[] {
  const compiled = compilePattern(spec);
  const matcher = new Matcher(compiled, program.getTypeChecker());
  const only = scope.files ? new Set(scope.files.map(pathKey)) : undefined;
  return projectSourceFiles(program)
    .filter((sf) => (!only || only.has(pathKey(sf.fileName))) && !scope.isExcluded?.(sf.fileName))
    .flatMap((sf) => matcher.search(sf))
    .filter((m) => !scope.range || (scope.range.start <= m.start && m.end <= scope.range.end));
}

/** Matches as a report, grouped by file, with each match's placeholder bindings. */
export function searchReport(matches: readonly Match[], spec: SearchSpec, root?: string): Report {
  const builder = new ReportBuilder('structuralSearch', `Matches of ${shorten(spec.pattern.trim().replace(/\s+/g, ' '), 50)}`);
  const byFile = new Map<ts.SourceFile, Match[]>();
  for (const match of matches) {
    byFile.set(match.sourceFile, [...(byFile.get(match.sourceFile) ?? []), match]);
  }
  const roots: ReportNode[] = [...byFile].map(([sourceFile, list]) => ({
    label: path.basename(sourceFile.fileName),
    description: `${root ? path.relative(root, path.dirname(sourceFile.fileName)).replace(/\\/g, '/') || '.' : ''} · ${list.length}`,
    icon: 'file-code',
    expanded: byFile.size <= 10,
    children: list.map((m) => ({
      label: shorten(sourceFile.text.slice(m.start, m.end).replace(/\s+/g, ' '), 80),
      description: bindingSummary(m),
      icon: 'search',
      location: builder.span(sourceFile, m.start, m.end),
    })),
  }));
  return builder.finish(roots, `${plural(matches.length, 'match', 'matches')} in ${plural(byFile.size, 'file')}`);
}

export function bindingSummary(match: Match): string {
  return [...match.bindings]
    .map(([name, nodes]) => `$${name}$ = ${shorten(nodes.map((n) => n.getText().replace(/\s+/g, ' ')).join(', ') || '∅', 30)}`)
    .join('  ');
}

/** The replacement text for a match: `$name$` takes the matched code, `$name*$` the whole matched list. */
export function instantiate(template: string, match: Match): string {
  return template.replace(placeholderSyntax, (whole, name: string) => {
    const nodes = match.bindings.get(name);
    if (!nodes) {
      throw new RefactorError(`The replacement uses $${name}$, which the search pattern does not define.`);
    }
    if (nodes.length === 0) {
      return '';
    }
    const sourceFile = match.sourceFile;
    return sourceFile.text.slice(nodes[0].getStart(sourceFile), nodes[nodes.length - 1].end);
  });
}

/** Matches that do not lie inside an earlier match, so replacements never overlap. */
export function outermost(matches: readonly Match[]): Match[] {
  const sorted = [...matches].sort((a, b) => a.sourceFile.fileName.localeCompare(b.sourceFile.fileName) || a.start - b.start || b.end - a.end);
  const kept: Match[] = [];
  for (const match of sorted) {
    const last = kept[kept.length - 1];
    if (last && last.sourceFile === match.sourceFile && match.start < last.end) {
      continue;
    }
    kept.push(match);
  }
  return kept;
}

/** Type-Safe Structural Replace: rewrites every match, then type-checks the result against the original. */
/** One rewrite of a structural replace, for previewing before anything is written. */
export interface Replacement {
  file: string;
  line: number;
  before: string;
  after: string;
  /** Offsets of the matched code, to replace just this match later. */
  start: number;
  end: number;
}

export function structuralReplace(project: VirtualProject, spec: SearchSpec, template: string, scope: SearchScope = {}): RefactorResult & { matches: number; replacements: Replacement[] } {
  const program = project.program();
  const matches = outermost(structuralSearch(program, spec, scope));
  const byFile = new Map<string, Match[]>();
  for (const match of matches) {
    byFile.set(match.sourceFile.fileName, [...(byFile.get(match.sourceFile.fileName) ?? []), match]);
  }
  // Compute every replacement before changing any text: matches hold nodes of the original program.
  const edits = [...byFile].map(([file, list]) => ({ file, text: list[0].sourceFile.text, replacements: list.map((m) => ({ start: m.start, end: m.end, text: instantiate(template, m) })) }));
  const syntaxErrors = (file: string) => program.getSyntacticDiagnostics(project.sourceFile(file)).length;
  const before = new Map(edits.map((e) => [e.file, syntaxErrors(e.file)]));
  for (const { file, text, replacements } of edits) {
    let result = text;
    for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
      result = result.slice(0, r.start) + r.text + result.slice(r.end);
    }
    project.setText(file, result);
  }
  // A replacement that does not parse would leave broken files behind; refuse it, saying where.
  for (const { file } of edits) {
    const after = project.program().getSyntacticDiagnostics(project.sourceFile(file));
    if (after.length > before.get(file)!) {
      const first = after[0];
      const line = first.file && first.start !== undefined ? first.file.getLineAndCharacterOfPosition(first.start).line + 1 : 0;
      throw new RefactorError(`Invalid replacement at ${path.basename(file)}:${line}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`);
    }
  }
  const replacements = matches.map((m) => ({
    file: m.sourceFile.fileName,
    line: m.sourceFile.getLineAndCharacterOfPosition(m.start).line + 1,
    before: m.sourceFile.text.slice(m.start, m.end),
    after: instantiate(template, m),
    start: m.start,
    end: m.end,
  }));
  const label = `Replace ${spec.pattern.trim().split('\n')[0]}`;
  return { label: label.length > 60 ? `${label.slice(0, 59)}…` : label, changes: project.changes(), conflicts: introducedErrors(project, [], 20), matches: matches.length, replacements };
}
