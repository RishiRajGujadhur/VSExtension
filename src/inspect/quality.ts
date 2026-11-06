import * as ts from 'typescript';
import { Finding, Fix, Inspection, Severity } from './inspection';

/** Inspections for common slips: what is wrong in a few words and, where it is clear, the fix. */
export const qualityInspections: Inspection[] = [];

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Like walk, without entering nested functions or classes. */
function walkInScope(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) walkInScope(child, visit);
  });
}

function at(sf: ts.SourceFile, inspection: string, node: ts.Node, message: string, severity: Severity, fixes?: Fix[]): Finding {
  return { inspection, message, start: node.getStart(sf), end: node.end, severity, fixes };
}

const replace = (sf: ts.SourceFile, node: ts.Node, text: string) => ({ start: node.getStart(sf), end: node.end, text });

/** An edit that removes a statement with its line, when nothing else is on it. */
function removeStatement(sf: ts.SourceFile, statement: ts.Node): { start: number; end: number; text: string } {
  const text = sf.text;
  let start = statement.getStart(sf);
  let end = statement.end;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  if (!text.slice(lineStart, start).trim() && !text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim()) {
    start = lineStart;
    end = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return { start, end, text: '' };
}

const unparen = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);

/** A reference without side effects: `x`, `this.x`, `a.b.c`. */
function isSimple(e: ts.Expression): boolean {
  const u = unparen(e);
  return ts.isIdentifier(u) || u.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(u) && isSimple(u.expression));
}

const comparisons = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const isNegative = (kind: ts.SyntaxKind) => kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;

qualityInspections.push({
  id: 'selfAssignment',
  title: 'Self-assignment',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isSimple(node.left) && unparen(node.left).getText() === unparen(node.right).getText()) {
        out.push(at(ctx.sourceFile, 'selfAssignment', node, `${node.left.getText()} is assigned to itself, which does nothing.`, 'warning', ts.isExpressionStatement(node.parent) ? [{ title: 'Remove the assignment', edits: [removeStatement(ctx.sourceFile, node.parent)], preferred: true }] : undefined));
      }
    });
    return out;
  },
});

qualityInspections.push({
  id: 'nanComparison',
  title: 'Comparison with NaN',
  defaultSeverity: 'warning',
  run: (ctx) => {
    const out: Finding[] = [];
    walk(ctx.sourceFile, (node) => {
      if (!ts.isBinaryExpression(node) || !comparisons.has(node.operatorToken.kind)) return;
      const isNaN = (e: ts.Expression) => /^(Number\.)?NaN$/.test(unparen(e).getText());
      const other = isNaN(node.right) ? node.left : isNaN(node.left) ? node.right : undefined;
      if (!other) return;
      const negative = isNegative(node.operatorToken.kind);
      out.push(at(ctx.sourceFile, 'nanComparison', node, `Comparing with NaN is always ${negative ? 'true' : 'false'}; use Number.isNaN().`, 'warning', [{ title: 'Use Number.isNaN()', edits: [replace(ctx.sourceFile, node, `${negative ? '!' : ''}Number.isNaN(${other.getText()})`)], preferred: true }]));
    });
    return out;
  },
});
