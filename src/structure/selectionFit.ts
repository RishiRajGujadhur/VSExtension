import ts = require('typescript');
import { FileSymbol, fileSymbols } from './symbols';

/**
 * What highlighted code can be the subject of: the actions that work with it, and how to say what it is. The Actions
 * view shows only those while code is highlighted.
 *
 * - A **name** (one identifier): the analyses of what it names, as at the cursor, and the edits of a declaration.
 * - **Code inside a function**: the charts of that function (flowchart and the like), and the tools that take a range:
 *   copies of it, inspections of it, searching by its shape, and turning an expression into a parameter.
 * - **Whole declarations** at the top of a file: moving them to another module, and the range tools; one whole
 *   function also gets its own analyses and edits.
 */
export interface SelectionFit {
  /** As shown above the buttons: "the name total", "code in checkout()", "2 declarations". */
  subject: string;
  commands: string[];
}

/** The charts that describe a function's body: they fit any code highlighted inside it. */
export const bodyCommands = ['tsStructure.controlFlow', 'tsStructure.controlFlowCompare', 'tsStructure.dependenceGraph', 'tsStructure.exceptionFlow', 'tsStructure.sideEffects'];
const asyncBodyCommands = ['tsStructure.promiseRejections', 'tsStructure.asyncTimeline'];
/** Tools that take the highlighted range itself. */
const rangeCommands = ['tsStructure.findDuplicates', 'tsStructure.structuralSearch', 'tsStructure.inspectCode'];

type FunctionLike = ts.FunctionLikeDeclaration & { body: ts.Node };

/**
 * The actions that fit the code from `start` to `end`; undefined for a selection of nothing but spaces.
 * `forSymbol` lists the analyses that fit a declaration (the same as for the cursor on its name).
 */
export function selectionFit(sourceFile: ts.SourceFile, start: number, end: number, forSymbol: (symbol: FileSymbol) => string[], symbols = fileSymbols(sourceFile)): SelectionFit | undefined {
  const text = sourceFile.text;
  // Spaces and line breaks at either end do not count.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return undefined;
  const selected = text.slice(start, end);

  if (/^[A-Za-z_$][\w$]*$/.test(selected)) {
    const symbol = declarationNamed(symbols, selected, start);
    if (symbol) return { subject: `the name ${selected}`, commands: unique([...forSymbol(symbol), ...declarationEdits(symbol), 'tsImpact.analyze']) };
  }

  const fn = enclosingFunction(sourceFile, start, end);
  // One whole function (or method) highlighted, with its name: as if the cursor were on its name.
  const whole = wholeFunction(sourceFile, start, end);
  if (whole) {
    const symbol = whole.name && symbols.find((s) => s.offset === whole.name!.getStart(sourceFile));
    return {
      subject: symbol ? `the function ${symbol.name}()` : 'a whole function',
      commands: unique([...bodyCommands, ...(isAsync(whole) ? asyncBodyCommands : []), ...(symbol ? [...forSymbol(symbol), ...declarationEdits(symbol)] : []), ...rangeCommands]),
    };
  }
  if (fn) {
    const name = functionName(fn, sourceFile);
    const expression = exactExpression(sourceFile, start, end);
    return {
      subject: name ? `code in ${name}()` : 'code in a function',
      commands: unique([
        ...bodyCommands,
        ...(isAsync(fn) ? asyncBodyCommands : []),
        ...rangeCommands,
        ...(expression ? ['tsStructure.introduceParameter'] : []),
        ...(/\bas\s|[\w)\]]!(?!=)/.test(selected) ? ['tsStructure.auditTypeAssertions'] : []),
      ]),
    };
  }
  // At the top of the file: whole declarations can move to another module.
  const declarations = sourceFile.statements.filter((s) => s.getStart(sourceFile) >= start && s.end <= end && isDeclaration(s));
  return {
    subject: declarations.length ? `${declarations.length} declaration${declarations.length === 1 ? '' : 's'}` : 'the selected code',
    commands: unique([...rangeCommands, ...(declarations.length ? ['tsStructure.moveMembers'] : []), ...(/\bexport\b/.test(selected) ? ['tsStructure.deadExports'] : []), ...(/\bas\s|[\w)\]]!(?!=)/.test(selected) ? ['tsStructure.auditTypeAssertions'] : [])]),
  };
}

/** The declaration a highlighted name refers to: the one declared there, else the nearest one above with that name. */
function declarationNamed(symbols: readonly FileSymbol[], name: string, at: number): FileSymbol | undefined {
  const named = symbols.filter((s) => s.name === name);
  return named.find((s) => s.offset === at) ?? [...named].reverse().find((s) => s.offset < at) ?? named[0];
}

/** Edits that start from a declaration's name. */
function declarationEdits(symbol: FileSymbol): string[] {
  return [
    ...((symbol.kind === 'function' || (symbol.kind === 'member' && symbol.callable)) ? ['tsStructure.changeSignature'] : []),
    ...(symbol.kind !== 'import' ? ['tsStructure.safeDelete'] : []),
    ...(!symbol.container && ['function', 'class', 'interface', 'variable'].includes(symbol.kind) ? ['tsStructure.moveMembers'] : []),
  ];
}

const hasBody = (node: ts.Node): node is FunctionLike => ts.isFunctionLike(node) && !!(node as ts.FunctionLikeDeclaration).body;

/** The innermost function whose body holds the whole range. */
function enclosingFunction(sourceFile: ts.SourceFile, start: number, end: number): FunctionLike | undefined {
  let found: FunctionLike | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) > start || node.end < end) return;
    if (hasBody(node) && node.body.getStart(sourceFile) <= start && node.body.end >= end) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A function or method highlighted from its start (or its comment) to its end, and nothing more. */
function wholeFunction(sourceFile: ts.SourceFile, start: number, end: number): FunctionLike | undefined {
  let found: FunctionLike | undefined;
  const visit = (node: ts.Node): void => {
    if (found || node.end < start || node.getFullStart() > end) return;
    const own = ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0].initializer : node;
    if (own && hasBody(own) && node.getFullStart() <= start && node.getStart(sourceFile) >= start && Math.abs(node.end - end) <= 1) {
      found = own;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function functionName(fn: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  if (fn.name) return fn.name.getText(sourceFile);
  const parent = fn.parent;
  return parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name ? parent.name.getText(sourceFile) : undefined;
}

const isAsync = (fn: ts.Node) => !!ts.getModifiers(fn as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

/** An expression that starts and ends exactly where the highlight does, such as `price * 0.2`. */
function exactExpression(sourceFile: ts.SourceFile, start: number, end: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) > start || node.end < end) return;
    if (node.getStart(sourceFile) === start && node.end === end && isExpression(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isExpression(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node) || ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
    ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) ||
    ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isConditionalExpression(node) || ts.isParenthesizedExpression(node) ||
    ts.isPrefixUnaryExpression(node) || ts.isNewExpression(node) || ts.isArrowFunction(node) || (ts.isIdentifier(node) && !ts.isDeclarationStatement(node.parent))
  );
}

function isDeclaration(statement: ts.Statement): boolean {
  return ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isVariableStatement(statement);
}

const unique = (commands: string[]) => [...new Set(commands)];

/** C# and T-SQL: the commands of the language's list that fit a highlighted name, or highlighted code. */
export function otherLanguageSelectionFit(text: string, start: number, end: number, available: readonly string[]): SelectionFit | undefined {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return undefined;
  const selected = text.slice(start, end);
  const nameCommands = ['tsStructure.semanticUsages', 'tsStructure.semanticUsagesInFile', 'tsStructure.callGraph', 'tsStructure.dataFlow', 'tsStructure.dataFlowDiagram', 'tsStructure.mutationTrackingVariable', 'tsStructure.argumentFlow', 'tsStructure.typeHierarchy', 'tsStructure.overrideImpact'];
  const codeCommands = [...bodyCommands, 'tsStructure.promiseRejections'];
  const isName = /^@?[A-Za-z_][\w$#]*$/.test(selected);
  return {
    subject: isName ? `the name ${selected}` : 'the selected code',
    commands: available.filter((c) => (isName ? nameCommands : codeCommands).includes(c)),
  };
}
