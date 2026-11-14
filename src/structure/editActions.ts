import * as ts from 'typescript';

/**
 * Edits that fit the code a chart box points at, for the buttons on its hover card: Rename, Delete safely, Change
 * signature, Move to another file, Inline, Extract, or the editor's own refactorings. Worked out from the file's text
 * alone, so it is quick enough to run on every hover; the edit itself runs with the cursor put on the right name.
 */
export interface EditAction {
  /** The command run with the cursor at `line`/`character`. */
  command: string;
  /** Arguments for the command, such as the kind of code action to offer. */
  args?: unknown[];
  label: string;
  icon: string;
  /** Where the cursor goes first (0-based), usually the declaration's name. */
  line: number;
  character: number;
  /** Where it goes on the card: the Edit row, the File row, or apart as a destructive edit. */
  group?: 'edit' | 'file' | 'danger';
  /** Shown in the ▾ menu of the File row's Move button rather than as a button of its own. */
  underMove?: boolean;
  /** The end of the code to select first, for Extract. */
  endLine?: number;
  endCharacter?: number;
}

type Named = ts.Declaration & { name?: ts.Node };

const functionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  (ts.isVariableDeclaration(n) && !!n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)));

const declarationKinds = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Parameter,
]);

/** A top-level statement: what Move to another file can move. */
const topLevel = (n: ts.Node): boolean => {
  const statement = ts.isVariableDeclaration(n) ? n.parent?.parent : n;
  return !!statement && ts.isSourceFile(statement.parent);
};

const sourceCache = new Map<string, { text: string; file: ts.SourceFile }>();

/** The file parsed once per text: hovering box after box in one file parses it once. */
function parse(fileName: string, text: string): ts.SourceFile {
  const hit = sourceCache.get(fileName);
  if (hit && hit.text === text) return hit.file;
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.m?js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  if (sourceCache.size > 20) sourceCache.delete(sourceCache.keys().next().value as string);
  sourceCache.set(fileName, { text, file });
  return file;
}

/** The innermost node at an offset. */
function nodeAt(file: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = file;
  const visit = (n: ts.Node): void => {
    if (offset >= n.getStart(file) && offset < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(file, visit);
  return found;
}

/** The declaration a box is about: the one whose name is at the spot, or one declared on the spot's line. */
function declarationAt(file: ts.SourceFile, offset: number, line: number): Named | undefined {
  const spot = nodeAt(file, offset);
  // On a name that refers to something declared elsewhere: that is what the box is about, not this line's declaration.
  const onReference = ts.isIdentifier(spot) && !(declarationKinds.has(spot.parent.kind) && (spot.parent as Named).name === spot);
  if (onReference) return undefined;
  for (let n: ts.Node | undefined = spot; n && !ts.isSourceFile(n); n = n.parent) {
    if (!declarationKinds.has(n.kind)) continue;
    const name = (n as Named).name;
    if (!name || !ts.isIdentifier(name)) continue;
    // The box's spot is on the name, or the declaration starts on the box's line (a box for "function walk").
    const onName = offset >= name.getStart(file) && offset <= name.getEnd();
    if (onName || file.getLineAndCharacterOfPosition(name.getStart(file)).line === line) return n as Named;
  }
  // The spot is at the start of a line that declares something: `export async function f`.
  let lineDeclaration: Named | undefined;
  const visit = (n: ts.Node): void => {
    if (lineDeclaration) return;
    const name = (n as Named).name;
    if (declarationKinds.has(n.kind) && name && ts.isIdentifier(name) && file.getLineAndCharacterOfPosition(name.getStart(file)).line === line) lineDeclaration = n as Named;
    else ts.forEachChild(n, visit);
  };
  visit(file);
  return lineDeclaration;
}

const shortName = (name: string): string => (name.length > 18 ? `${name.slice(0, 17)}…` : name);

/** Edits that fit the code at a 0-based line and character of a file. */
export function editActionsAt(fileName: string, text: string, line: number, character: number): EditAction[] {
  if (!/\.[cm]?[jt]sx?$/i.test(fileName) || /\.d\.[cm]?ts$/i.test(fileName)) return [];
  const file = parse(fileName, text);
  if (line < 0 || line >= file.getLineStarts().length) return [];
  const offset = Math.min(file.getPositionOfLineAndCharacter(line, 0) + character, file.getEnd());
  const declaration = declarationAt(file, offset, line);
  const actions: EditAction[] = [];
  if (declaration?.name) {
    const at = file.getLineAndCharacterOfPosition(declaration.name.getStart(file));
    const add = (command: string, label: string, icon: string, args?: unknown[]) => actions.push({ command, label, icon, line: at.line, character: at.character, ...(args ? { args } : {}) });
    add('editor.action.rename', 'Rename', 'edit');
    if (!ts.isParameter(declaration) || !ts.isConstructorDeclaration(declaration.parent)) add('tsStructure.safeDelete', 'Delete safely', 'trash');
    if (functionLike(declaration)) add('tsStructure.changeSignature', 'Change signature', 'symbol-parameter');
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && !functionLike(declaration)) {
      add('editor.action.codeAction', 'Inline', 'fold-up', [{ kind: 'refactor.inline', apply: 'ifSingle' }]);
    }
    if (topLevel(declaration)) add('tsStructure.moveMembers', 'Move to a file', 'file-symlink-file');
    return actions;
  }
  // Code that declares nothing, such as a call or a condition: extract it, or the editor's refactorings there.
  const node = nodeAt(file, offset);
  const statement = ts.findAncestor(node, (n) => ts.isExpressionStatement(n) || ts.isReturnStatement(n) || ts.isIfStatement(n) || ts.isVariableStatement(n) || ts.isThrowStatement(n));
  if (!statement || ts.isSourceFile(node)) return actions;
  const at = file.getLineAndCharacterOfPosition(Math.max(offset, statement.getStart(file)));
  if (ts.isIdentifier(node)) {
    const name = file.getLineAndCharacterOfPosition(node.getStart(file));
    actions.push({ command: 'editor.action.rename', label: `Rename ‘${shortName(node.text)}’`, icon: 'edit', line: name.line, character: name.character });
  }
  // Extract works on a selection: the statement's expression (the call, the returned value, the condition).
  const expression = ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) || ts.isThrowStatement(statement) ? statement.expression : ts.isIfStatement(statement) ? statement.expression : ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  const bare = expression && ts.isIdentifier(expression) && expression.text !== 'undefined' ? expression : undefined;
  if (bare && !actions.length) {
    const name = file.getLineAndCharacterOfPosition(bare.getStart(file));
    actions.push({ command: 'editor.action.rename', label: `Rename ‘${shortName(bare.text)}’`, icon: 'edit', line: name.line, character: name.character });
  }
  // A single name or a literal is not worth extracting.
  if (expression && !ts.isIdentifier(expression) && !ts.isLiteralExpression(expression) && expression.kind !== ts.SyntaxKind.TrueKeyword && expression.kind !== ts.SyntaxKind.FalseKeyword && expression.kind !== ts.SyntaxKind.NullKeyword) {
    const start = file.getLineAndCharacterOfPosition(expression.getStart(file));
    const end = file.getLineAndCharacterOfPosition(expression.getEnd());
    actions.push({ command: 'editor.action.codeAction', args: [{ kind: 'refactor.extract' }], label: 'Extract…', icon: 'symbol-method', line: start.line, character: start.character, endLine: end.line, endCharacter: end.character });
  }
  actions.push({ command: 'editor.action.refactor', label: 'More edits…', icon: 'lightbulb', line: at.line, character: at.character });
  return actions;
}

/**
 * Sorts edits onto the card's rows: Edit (rename, signature, inline, extract, rewrites), File (move, export changes)
 * and, apart, Delete safely. Several ways to move become one Move button with the others in its ▾ menu.
 */
export function grouped(edits: EditAction[]): EditAction[] {
  const isMove = (e: EditAction) => e.command === 'tsStructure.moveMembers' || /^move to\b/i.test(e.label);
  const out = edits.map((e): EditAction => ({
    ...e,
    group: e.command === 'tsStructure.safeDelete' ? 'danger' : isMove(e) || /\bexport\b/i.test(e.label) ? 'file' : 'edit',
  }));
  // The first way to move is the button; the rest open from its ▾.
  const moves = out.filter((e) => e.group === 'file' && isMove(e));
  moves.slice(1).forEach((e) => (e.underMove = true));
  // "Move to a file" (ours) and the editor's "Move to file" do the same thing: keep ours.
  const ownMove = moves.find((e) => e.command === 'tsStructure.moveMembers');
  const duplicates = new Set(moves.filter((e) => e !== ownMove && ownMove && /^move to file$/i.test(e.label)));
  // The Edit row: renames and signature first, then the rest; "More edits…" always last.
  const order = (e: EditAction) => (e.command === 'editor.action.rename' ? 0 : e.command === 'tsStructure.changeSignature' ? 1 : e.command === 'editor.action.refactor' ? 9 : 5);
  return out.filter((e) => !duplicates.has(e)).sort((a, b) => (a.group === b.group ? order(a) - order(b) : 0));
}
