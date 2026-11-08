import ts = require('typescript');

/** What a named thing in a file is, for choosing what an analysis can start from. */
export type SymbolKind = 'variable' | 'function' | 'class' | 'interface' | 'member' | 'parameter' | 'import';

export interface FileSymbol {
  name: string;
  kind: SymbolKind;
  /** Offset of the name, where the cursor goes. */
  offset: number;
  line: number;
  /** The function, class or interface it is in, such as `checkout()` or `Cart`. */
  container?: string;
  async?: boolean;
  /** A method or accessor, as opposed to a property. */
  callable?: boolean;
}

/** Every declaration name in the file an analysis could start from, in source order. */
export function fileSymbols(sourceFile: ts.SourceFile): FileSymbol[] {
  const symbols: FileSymbol[] = [];
  const add = (name: ts.Node, kind: SymbolKind, container: string | undefined, isAsync = false, callable = false) => {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      const offset = name.getStart(sourceFile);
      symbols.push({ name: name.text, kind, offset, line: sourceFile.getLineAndCharacterOfPosition(offset).line, container, async: isAsync || undefined, callable: callable || undefined });
    }
  };
  const visit = (node: ts.Node, container: string | undefined): void => {
    let inner = container;
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name, 'function', container, isAsync(node));
      inner = `${node.name.text}()`;
    } else if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && isTypeMember(node)) {
      add(node.name, 'member', container, ts.isMethodDeclaration(node) && isAsync(node), ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node));
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        inner = `${container ? `${container}.` : ''}${node.name.text}()`;
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      add(node.name, 'class', container);
      inner = node.name.text;
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node.name, 'interface', container);
      inner = node.name.text;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fn = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.initializer : undefined;
      add(node.name, fn ? 'function' : 'variable', container, !!fn && isAsync(fn));
      if (fn) {
        inner = `${node.name.text}()`;
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text !== 'this') {
      add(node.name, 'parameter', container);
    } else if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name) {
        add(node.name, 'import', undefined);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, undefined);
  return symbols;
}

/** The declaration name at the offset, if the cursor is on one. */
export function symbolAt(sourceFile: ts.SourceFile, offset: number, symbols = fileSymbols(sourceFile)): FileSymbol | undefined {
  return symbols.find((s) => offset >= s.offset && offset <= s.offset + s.name.length);
}

function isAsync(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
}

function isTypeMember(node: ts.Node): boolean {
  return ts.isClassLike(node.parent) || ts.isInterfaceDeclaration(node.parent) || ts.isTypeLiteralNode(node.parent);
}
