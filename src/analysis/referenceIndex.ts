import * as ts from 'typescript';

/**
 * Maps each declaration in the project to the places that reference it at runtime.
 *
 * Keyed by declaration node rather than symbol so that references through aliases, re-exports,
 * union-type members and instantiated generics, which surface as different symbol objects,
 * all land on the same entry.
 */
export class ReferenceIndex {
  private readonly references = new Map<ts.Node, ts.Node[]>();
  readonly filesIndexed: number;

  constructor(program: ts.Program, private readonly checker: ts.TypeChecker) {
    const files = projectSourceFiles(program);
    for (const sourceFile of files) {
      this.indexFile(sourceFile);
    }
    this.filesIndexed = files.length;
  }

  referencesTo(declaration: ts.Node): readonly ts.Node[] {
    return this.references.get(declaration) ?? [];
  }

  private add(symbol: ts.Symbol | undefined, site: ts.Node): void {
    if (!symbol) {
      return;
    }
    const resolved = resolveAlias(this.checker, symbol);
    for (const declaration of resolved.declarations ?? []) {
      const sourceFile = declaration.getSourceFile();
      if (sourceFile.isDeclarationFile) {
        continue;
      }
      let sites = this.references.get(declaration);
      if (!sites) {
        sites = [];
        this.references.set(declaration, sites);
      }
      sites.push(site);
    }
  }

  private indexFile(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (isTypeOnly(node)) {
        return;
      }
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        this.indexIdentifier(node);
        return;
      }
      const specifier = moduleSpecifierOf(node);
      if (specifier) {
        // Importing a module runs its top-level code.
        this.add(this.checker.getSymbolAtLocation(specifier), node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private indexIdentifier(node: ts.Identifier | ts.PrivateIdentifier): void {
    const parent = node.parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      this.add(this.checker.getShorthandAssignmentValueSymbol(parent), node);
      return;
    }
    // `export default foo` is resolved through the default import's alias, like other re-exports.
    if (isDeclarationName(node) || (ts.isExportAssignment(parent) && parent.expression === node)) {
      return;
    }
    this.add(this.checker.getSymbolAtLocation(node), node);
  }
}

export function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  for (let i = 0; i < 20 && current.flags & ts.SymbolFlags.Alias; i++) {
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) {
      break;
    }
    current = next;
  }
  return current;
}

export function projectSourceFiles(program: ts.Program): ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        !program.isSourceFileFromExternalLibrary(sf) &&
        !program.isSourceFileDefaultLibrary(sf) &&
        !/[\\/]node_modules[\\/]/.test(sf.fileName),
    );
}

function moduleSpecifierOf(node: ts.Node): ts.Expression | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) {
      return undefined;
    }
    if (ts.isExportDeclaration(node) && node.isTypeOnly) {
      return undefined;
    }
    return node.moduleSpecifier;
  }
  if (ts.isExternalModuleReference(node)) {
    return node.expression;
  }
  // require('x') and import('x')
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    return node.arguments[0];
  }
  return undefined;
}

/** Type annotations, interfaces and type aliases do not run; `class X extends Y` does. */
function isTypeOnly(node: ts.Node): boolean {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return true;
  }
  if (ts.isHeritageClause(node)) {
    return node.token === ts.SyntaxKind.ImplementsKeyword;
  }
  if (ts.isExpressionWithTypeArguments(node)) {
    // Its expression is a value reference; only the type arguments are types.
    return false;
  }
  if (ts.isImportDeclaration(node)) {
    return !!node.importClause?.isTypeOnly;
  }
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    return node.isTypeOnly;
  }
  return ts.isTypeNode(node);
}

const declarationKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

/**
 * Names that declare rather than use a symbol. Import and export specifiers are skipped too:
 * every use of an imported name is resolved through the alias to the original declaration.
 */
function isDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  if (!declarationKinds.has(parent.kind)) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent)) {
    return parent.name === node || parent.propertyName === node;
  }
  return (parent as ts.NamedDeclaration).name === node || (parent as ts.BreakOrContinueStatement).label === node;
}
