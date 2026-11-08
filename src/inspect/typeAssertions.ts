import ts = require('typescript');
import { TextEdit } from '../intentions/intentions';
import { Finding, Inspection, InspectionContext } from './inspection';
import { containsNullish, nodeText, typeText } from '../structure/util';
import { discoverTests } from '../analysis/testDiscovery';

/**
 * Type Assertion Inspector: `as` and `!` assertions that are unnecessary, silently widen,
 * narrow without a runtime check, or bypass compatibility checks altogether.
 */
export const typeAssertions: Inspection = {
  id: 'typeAssertion',
  title: 'Type assertion',
  defaultSeverity: 'warning',
  run(context) {
    const findings: Finding[] = [];
    if (context.options?.typeAssertionIgnoreTests && discoverTests(context.sourceFile).isTestFile) {
      return findings;
    }
    const visit = (node: ts.Node) => {
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type)) {
        const finding = inspectAssertion(context, node);
        if (finding) {
          findings.push(finding);
        }
      } else if (ts.isNonNullExpression(node)) {
        const finding = inspectNonNull(context, node);
        if (finding) {
          findings.push(finding);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
    return findings;
  },
};

type Assertion = ts.AsExpression | ts.TypeAssertion;

function isTopType(type: ts.Type): boolean {
  return !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

function inspectAssertion(context: InspectionContext, node: Assertion): Finding | undefined {
  const { checker, sourceFile } = context;
  const inner = skipParens(node.expression);
  const target = checker.getTypeFromTypeNode(node.type);
  const at = (message: string, severity: Finding['severity'], extra: Partial<Finding> = {}): Finding => ({
    inspection: 'typeAssertion',
    message,
    severity,
    start: assertionStart(node, sourceFile),
    end: node.end,
    explain: valueName(inner) && { title: `Show where ${nodeText(inner)} comes from…`, command: 'tsStructure.dataFlow', offset: valueName(inner)!.getStart(sourceFile) },
    ...extra,
  });
  const targetText = node.type.getText(sourceFile);

  // The inner half of `x as unknown as T` is reported with the outer one.
  const outer = skipParensUp(node).parent;
  if ((ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer)) && isTopType(target)) {
    return undefined;
  }
  if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && isTopType(checker.getTypeFromTypeNode(inner.type))) {
    const original = checker.getTypeAtLocation(inner.expression);
    return at(
      `Double assertion from ${typeText(checker, original, node)} to ${targetText} through ${inner.type.getText(sourceFile)}: the compiler no longer checks that these types are related, so any value passes.`,
      'warning',
      { category: 'Unsafe' },
    );
  }
  if (target.flags & ts.TypeFlags.Any) {
    // `unknown` keeps the escape hatch but makes every use narrow the value first.
    return at(`'as any' turns off type checking for ${nodeText(inner)} and for everything it flows into.`, 'warning', {
      category: 'Unsafe',
      fixes: [{ title: "Use 'as unknown' and narrow where it is used", edits: [{ start: node.type.getStart(sourceFile), end: node.type.end, text: 'unknown' }] }],
    });
  }
  // Widening drops object-literal freshness, which would otherwise fail on excess properties.
  const source = ts.isObjectLiteralExpression(inner) ? checker.getWidenedType(checker.getTypeAtLocation(node.expression)) : checker.getTypeAtLocation(node.expression);
  if (source.flags & ts.TypeFlags.Any) {
    return at(`${nodeText(inner)} is 'any', so nothing verifies at runtime that it is ${targetText}. Consider validating it with a type guard or schema.`, 'info', { category: 'Unverified' });
  }
  const widens = checker.isTypeAssignableTo(source, target);
  const narrows = checker.isTypeAssignableTo(target, source);
  if (widens && narrows && typeText(checker, source, node) === typeText(checker, target, node)) {
    return at(`Unnecessary assertion: ${nodeText(inner)} is already ${targetText}.`, 'hint', {
      category: 'Unnecessary',
      unnecessary: true,
      fixes: [{ title: 'Remove unnecessary assertion', preferred: true, edits: removeAssertion(node, sourceFile) }],
    });
  }
  if (widens) {
    return at(
      `Widening assertion: ${typeText(checker, source, node)} already fits ${targetText}. A type annotation or 'satisfies ${targetText}' keeps the check without discarding type information.`,
      'info',
      {
        category: 'Widening',
        fixes: [
          {
            title: `Use 'satisfies ${targetText}'`,
            // `<T>value` becomes `(value satisfies T)`; the parentheses keep the old precedence unless some are already there.
            edits: ts.isAsExpression(node)
              ? [{ start: node.expression.end, end: node.type.getStart(sourceFile), text: ' satisfies ' }]
              : [{ start: node.getStart(sourceFile), end: node.end, text: wrap(`${node.expression.getText(sourceFile)} satisfies ${targetText}`, !ts.isParenthesizedExpression(node.parent)) }],
          },
        ],
      },
    );
  }
  if (narrows) {
    return at(`Unchecked narrowing from ${typeText(checker, source, node)} to ${targetText}: ${narrowingRisk(checker, source, target, node)} Prefer a type guard that checks at runtime.`, 'warning', { category: 'Unchecked narrowing' });
  }
  return undefined;
}

/** What the narrowing assumes without checking: removed union members or properties that may be missing. */
function narrowingRisk(checker: ts.TypeChecker, source: ts.Type, target: ts.Type, node: ts.Node): string {
  if (source.isUnion()) {
    const removed = source.types.filter((member) => !checker.isTypeAssignableTo(member, target));
    if (removed.length > 0) {
      return `it assumes the value is never ${removed.map((t) => typeText(checker, t, node)).join(' or ')}.`;
    }
  }
  const sourceProperties = new Set(checker.getPropertiesOfType(source).map((p) => p.name));
  const missing = checker
    .getPropertiesOfType(target)
    .filter((p) => !sourceProperties.has(p.name) && !(p.flags & ts.SymbolFlags.Optional))
    .map((p) => p.name);
  if (missing.length > 0) {
    return `it assumes properties ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''} exist, which the value is not known to have.`;
  }
  return 'it assumes a more specific type than the value is known to have.';
}

function inspectNonNull(context: InspectionContext, node: ts.NonNullExpression): Finding | undefined {
  const { checker, sourceFile } = context;
  // `x!` on the left of an assignment, or in a definite-assignment position, is not a read.
  if (ts.isBinaryExpression(node.parent) && node.parent.left === node) {
    return undefined;
  }
  const source = checker.getTypeAtLocation(node.expression);
  if (isTopType(source)) {
    return undefined;
  }
  const bang = { start: node.end - 1, end: node.end };
  const name = valueName(node.expression);
  if (!containsNullish(source)) {
    return {
      inspection: 'typeAssertion',
      message: `Unnecessary non-null assertion: ${nodeText(node.expression)} is ${typeText(checker, source, node)}, which is never null or undefined.`,
      severity: 'hint',
      category: 'Unnecessary',
      unnecessary: true,
      ...bang,
      fixes: [{ title: "Remove '!'", preferred: true, edits: [{ ...bang, text: '' }] }],
    };
  }
  return {
    inspection: 'typeAssertion',
    message: `Non-null assertion on ${nodeText(node.expression)}, which is ${typeText(checker, source, node)}: if it is null or undefined here, the next access throws at runtime.`,
    severity: 'hint',
    category: 'Non-null on a nullable value',
    ...bang,
    explain: name && { title: `Explain why ${nodeText(node.expression)} may be null or undefined…`, command: 'tsStructure.nullability', offset: name.getStart(sourceFile) },
    fixes: ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node ? [{ title: "Use optional chaining '?.'", edits: [{ start: node.end - 1, end: node.parent.name.getStart(sourceFile), text: '?.' }] }] : undefined,
  };
}

function removeAssertion(node: Assertion, sourceFile: ts.SourceFile): TextEdit[] {
  if (ts.isAsExpression(node)) {
    return [{ start: node.expression.end, end: node.end, text: '' }];
  }
  return [{ start: node.getStart(sourceFile), end: node.expression.getStart(sourceFile), text: '' }];
}

/** Where the assertion syntax starts: the `as` keyword, or `<` of the angle-bracket form. */
function assertionStart(node: Assertion, sourceFile: ts.SourceFile): number {
  return ts.isAsExpression(node) ? node.expression.end + /^\s*/.exec(sourceFile.text.slice(node.expression.end))![0].length : node.getStart(sourceFile);
}

/** The name an analysis can start from: `x` in `x as T`, `name` in `user.name!`. Calls and literals have none. */
function valueName(expression: ts.Expression): ts.Identifier | undefined {
  const inner = skipParens(expression);
  return ts.isIdentifier(inner) ? inner : ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name) ? inner.name : undefined;
}

function wrap(text: string, parenthesize: boolean): string {
  return parenthesize ? `(${text})` : text;
}

function skipParens(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? skipParens(node.expression) : node;
}

function skipParensUp(node: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(node.parent) ? skipParensUp(node.parent) : node;
}
