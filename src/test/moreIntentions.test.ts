import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import ts = require('typescript');
import { applyTextEdits, intentionsAt } from '../intentions/intentions';

/** Applies the intention `id` at the `¦` in `code`, or undefined when it is not offered there. */
function apply(code: string, id: string): string | undefined {
  const position = code.indexOf('¦');
  const text = code.replace('¦', '');
  const action = intentionsAt(ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true), position).find((a) => a.id === id);
  return action && applyTextEdits(text, action.edits);
}

const lines = (...l: string[]) => l.join('\n');

test('Replace \'?:\' with \'??\'', () => {
  assert.equal(apply('const v = a != null ¦? a : 0;', 'ternaryToNullish'), 'const v = a ?? 0;');
  assert.equal(apply("const v = a.b == null ¦? 'x' : a.b;", 'ternaryToNullish'), "const v = a.b ?? 'x';");
  assert.equal(apply('const v = a != null ¦? b : 0;', 'ternaryToNullish'), undefined);
  assert.equal(apply('const v = f() != null ¦? f() : 0;', 'ternaryToNullish'), undefined);
});

test('Replace \'&&\' check with \'?.\'', () => {
  assert.equal(apply('if (user ¦&& user.name) go();', 'optionalChain'), 'if (user?.name) go();');
  assert.equal(apply('while (node ¦&& node.next()) step();', 'optionalChain'), 'while (node?.next()) step();');
  assert.equal(apply('const n = user ¦&& user.name;', 'optionalChain'), undefined);
  assert.equal(apply('if (user ¦&& user.age > 1) go();', 'optionalChain'), undefined);
});

test('Replace \'indexOf\' check with \'includes\'', () => {
  assert.equal(apply('if (list.indexOf(x) ¦!== -1) {}', 'indexOfToIncludes'), 'if (list.includes(x)) {}');
  assert.equal(apply('const missing = list.indexOf(x) ¦=== -1;', 'indexOfToIncludes'), 'const missing = !list.includes(x);');
  assert.equal(apply('if (s.indexOf("a") ¦>= 0) {}', 'indexOfToIncludes'), 'if (s.includes("a")) {}');
  assert.equal(apply('if (list.indexOf(x) ¦> 0) {}', 'indexOfToIncludes'), undefined);
});

test('Remove \'else\' after \'return\'', () => {
  assert.equal(
    apply(lines('function f(a) {', '  i¦f (a) {', '    return 1;', '  } else {', '    go();', '    return 2;', '  }', '}'), 'removeElseAfterReturn'),
    lines('function f(a) {', '  if (a) {', '    return 1;', '  }', '  go();', '  return 2;', '}'),
  );
  assert.equal(apply(lines('function f(a) {', '  i¦f (a) {', '    go();', '  } else {', '    stop();', '  }', '}'), 'removeElseAfterReturn'), undefined);
});

test('Replace \'let\' with \'const\'', () => {
  assert.equal(apply('l¦et total = 1; use(total);', 'letToConst'), 'const total = 1; use(total);');
  assert.equal(apply('l¦et n = 1; n++;', 'letToConst'), undefined);
  assert.equal(apply('l¦et n = 1; [n] = [2];', 'letToConst'), undefined);
  assert.equal(apply('for (l¦et x of xs) use(x);', 'letToConst'), 'for (const x of xs) use(x);');
});

test('Replace \'var\' with \'let\'', () => {
  assert.equal(apply('function f() { v¦ar a = 1; return a; }', 'varToLet'), 'function f() { let a = 1; return a; }');
  assert.equal(apply('function f(x) { if (x) { v¦ar a = 1; } return a; }', 'varToLet'), undefined);
  assert.equal(apply('function f() { use(a); v¦ar a = 1; }', 'varToLet'), undefined);
});

test('Convert arrow function to function declaration', () => {
  assert.equal(apply('c¦onst add = (a: number, b: number) => a + b;', 'arrowToFunction'), lines('function add(a: number, b: number) {', '  return a + b;', '}'));
  assert.equal(apply('export c¦onst load = async (): Promise<void> => { await go(); };', 'arrowToFunction'), 'export async function load(): Promise<void> { await go(); }');
  assert.equal(apply('c¦onst f = () => this.x;', 'arrowToFunction'), undefined);
  assert.equal(apply('c¦onst f: Handler = () => 1;', 'arrowToFunction'), undefined);
});

test('Use property shorthand', () => {
  assert.equal(apply('const o = { a¦: a, b: 1 };', 'objectShorthand'), 'const o = { a, b: 1 };');
  assert.equal(apply('const o = { a¦: b };', 'objectShorthand'), undefined);
});

test('Expand property shorthand', () => {
  assert.equal(apply('const o = { ¦a };', 'expandShorthand'), 'const o = { a: a };');
});

test('Replace template literal with \'+\'', () => {
  assert.equal(apply('const s = `Hi ${n¦ame}!`;', 'templateToConcat'), "const s = 'Hi ' + name + '!';");
  assert.equal(apply('const s = `${a}${¦b}`;', 'templateToConcat'), "const s = '' + a + b;");
  assert.equal(apply('const n = `x${¦y}`.length;', 'templateToConcat'), "const n = ('x' + y).length;");
  assert.equal(apply('const s = `it\'s ${¦a}`;', 'templateToConcat'), "const s = 'it\\'s ' + a;");
});

test('Replace \'hasOwnProperty\' with \'Object.hasOwn\'', () => {
  assert.equal(apply('if (o.hasOwn¦Property(k)) {}', 'hasOwn'), 'if (Object.hasOwn(o, k)) {}');
  assert.equal(apply('if (Object.prototype.hasOwnProperty.ca¦ll(o, k)) {}', 'hasOwn'), 'if (Object.hasOwn(o, k)) {}');
});

test('Replace \'switch\' with \'if\' chain', () => {
  assert.equal(
    apply(lines('s¦witch (k) {', '  case 1:', '    a();', '    break;', '  case 2:', '  case 3:', '    b();', '    break;', '  default:', '    c();', '}'), 'switchToIfChain'),
    lines('if (k === 1) {', '  a();', '} else if (k === 2 || k === 3) {', '  b();', '} else {', '  c();', '}'),
  );
  assert.equal(apply(lines('s¦witch (k) {', '  case 1:', '    a();', '  case 2:', '    b();', '}'), 'switchToIfChain'), undefined);
  assert.equal(apply(lines('s¦witch (f()) {', '  case 1:', '    a();', '}'), 'switchToIfChain'), undefined);
});

test('Replace \'x = x + y\' with \'x += y\'', () => {
  assert.equal(apply('t¦otal = total + price;', 'compoundAssignment'), 'total += price;');
  assert.equal(apply('this.n = this.n ¦* 2;', 'compoundAssignment'), 'this.n *= 2;');
  assert.equal(apply('x = x - y ¦+ z;', 'compoundAssignment'), undefined);
});

test('Replace \'x += y\' with \'x = x + y\'', () => {
  assert.equal(apply('total ¦+= price * 2;', 'expandCompoundAssignment'), 'total = total + price * 2;');
  assert.equal(apply('a ¦*= b + c;', 'expandCompoundAssignment'), 'a = a * (b + c);');
  assert.equal(apply('f().x ¦+= 1;', 'expandCompoundAssignment'), undefined);
});

test('Remove unnecessary parentheses', () => {
  assert.equal(apply('const x = ¦(a * b) + c;', 'removeParentheses'), 'const x = a * b + c;');
  assert.equal(apply('const y = (¦a + b) * c;', 'removeParentheses'), undefined);
  assert.equal(apply('const z = (¦a?.b).c;', 'removeParentheses'), undefined);
  assert.equal(apply('const f = () => (¦{ a: 1 });', 'removeParentheses'), undefined);
});

test('Add parentheses to mixed \'&&\' and \'||\'', () => {
  assert.equal(apply('const ok = a && b ¦|| c;', 'addParentheses'), 'const ok = (a && b) || c;');
  assert.equal(apply('const ok = a ¦|| b;', 'addParentheses'), undefined);
});

test('Replace \'if\' returning true/false with \'return\'', () => {
  assert.equal(apply('function f(a) { i¦f (a > 1) { return true; } else { return false; } }', 'booleanReturn'), 'function f(a) { return a > 1; }');
  assert.equal(apply('function f(a) { i¦f (a) return false; return true; }', 'booleanReturn'), 'function f(a) { return !a; }');
  assert.equal(apply('function f(a) { i¦f (a) return true; return false; }', 'booleanReturn'), 'function f(a) { return !!a; }');
});

test('Replace \'c ? true : false\' with \'c\'', () => {
  assert.equal(apply('const b = x > 1 ¦? true : false;', 'ternaryBoolean'), 'const b = x > 1;');
  assert.equal(apply('const b = x ¦? false : true;', 'ternaryBoolean'), 'const b = !x;');
  assert.equal(apply('const b = x ¦? true : false;', 'ternaryBoolean'), 'const b = !!x;');
});

test('Join declaration and assignment', () => {
  assert.equal(apply(lines('l¦et x;', 'x = compute();'), 'joinDeclaration'), 'let x = compute();');
  assert.equal(apply(lines('l¦et x: number;', 'x = 1;'), 'joinDeclaration'), 'let x: number = 1;');
  assert.equal(apply(lines('l¦et x;', 'y = 1;'), 'joinDeclaration'), undefined);
});

test('Replace \'===\' chain with \'includes\'', () => {
  assert.equal(apply("if (k === 'a' ¦|| k === 'b' || k === 'c') {}", 'equalityChainToIncludes'), "if (['a', 'b', 'c'].includes(k)) {}");
  assert.equal(apply("if (k === 'a' ¦|| j === 'b') {}", 'equalityChainToIncludes'), undefined);
  assert.equal(apply("if (k == 'a' ¦|| k == 'b') {}", 'equalityChainToIncludes'), undefined);
});

test('Replace \'Object.assign\' with spread', () => {
  assert.equal(apply('const o = Object.¦assign({}, a, { b: 1 });', 'objectAssignToSpread'), 'const o = { ...a, b: 1 };');
  assert.equal(apply('Object.¦assign({}, a);', 'objectAssignToSpread'), undefined);
  assert.equal(apply('Object.¦assign(target, a);', 'objectAssignToSpread'), undefined);
});

test('Use destructuring', () => {
  assert.equal(apply('c¦onst total = order.total;', 'destructureProperty'), 'const { total } = order;');
  assert.equal(apply('c¦onst t = order.total;', 'destructureProperty'), 'const { total: t } = order;');
  assert.equal(apply('c¦onst t = order?.total;', 'destructureProperty'), undefined);
});

test('Replace \'Math.pow\' with \'**\'', () => {
  assert.equal(apply('const x = Math.¦pow(a + 1, 2);', 'mathPowToExponent'), 'const x = (a + 1) ** 2;');
  assert.equal(apply('const x = Math.¦pow(-a, 2);', 'mathPowToExponent'), 'const x = (-a) ** 2;');
  assert.equal(apply('const x = Math.¦pow(a, b).toFixed();', 'mathPowToExponent'), 'const x = (a ** b).toFixed();');
});

test('Add numeric separators', () => {
  assert.equal(apply('const n = 1000¦000;', 'addNumericSeparators'), 'const n = 1_000_000;');
  assert.equal(apply('const n = 12¦34;', 'addNumericSeparators'), undefined);
});

test('Remove numeric separators', () => {
  assert.equal(apply('const n = 1_0¦00;', 'removeNumericSeparators'), 'const n = 1000;');
});

test('Switch between single and double quotes', () => {
  assert.equal(apply("const s = 'a¦b';", 'toggleQuotes'), 'const s = "ab";');
  assert.equal(apply('const s = "say ¦\'hi\'";', 'toggleQuotes'), "const s = 'say \\'hi\\'';");
});

test('Intention: Simplify negated comparison', () => {
  assert.equal(apply('if (!(a ¦=== b)) {}', 'simplifyNegation'), 'if (a !== b) {}');
  assert.equal(apply('const x = !(a ¦!= null);', 'simplifyNegation'), 'const x = a == null;');
});

test('Intention: Remove \'!!\' in a condition', () => {
  assert.equal(apply('if (!¦!user) {}', 'removeDoubleNegation'), 'if (user) {}');
  assert.equal(apply('const b = !¦!user;', 'removeDoubleNegation'), undefined);
});

test('Intention: Replace \'x ? x : y\' with \'x || y\'', () => {
  assert.equal(apply("const v = name ¦? name : 'anon';", 'ternaryToOr'), "const v = name || 'anon';");
});

test('Intention: Replace \'.apply()\' with spread', () => {
  assert.equal(apply('f.ap¦ply(null, args);', 'applyToSpread'), 'f(...args);');
  assert.equal(apply('obj.m.ap¦ply(obj, args);', 'applyToSpread'), 'obj.m(...args);');
  assert.equal(apply('obj.m.ap¦ply(null, args);', 'applyToSpread'), undefined);
});

test('Intention: Replace \'slice.call\' with \'Array.from\'', () => {
  assert.equal(apply('const a = Array.prototype.slice.ca¦ll(arguments);', 'sliceCallToArrayFrom'), 'const a = Array.from(arguments);');
});

/** Like apply, in a .tsx file. */
function applyTsx(code: string, id: string): string | undefined {
  const position = code.indexOf('¦');
  const text = code.replace('¦', '');
  const action = intentionsAt(ts.createSourceFile('test.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), position).find((a) => a.id === id);
  return action && applyTextEdits(text, action.edits);
}

test('Intention: Replace JSX \'?: null\' with \'&&\'', () => {
  assert.equal(applyTsx('const a = <div>{open ¦=== true ? <Menu /> : null}</div>;', 'jsxTernaryToAnd'), 'const a = <div>{open === true && <Menu />}</div>;');
  assert.equal(applyTsx('const a = <div>{count ¦? <Menu /> : null}</div>;', 'jsxTernaryToAnd'), undefined);
});

test('Intention: Replace JSX \'&&\' with \'?: null\'', () => {
  assert.equal(applyTsx('const a = <div>{open ¦&& <Menu />}</div>;', 'jsxAndToTernary'), 'const a = <div>{open ? <Menu /> : null}</div>;');
});

test('Intention: Self-close empty JSX element', () => {
  assert.equal(applyTsx('const a = <Fo¦o bar="1"></Foo>;', 'jsxSelfClose'), 'const a = <Foo bar="1" />;');
  assert.equal(applyTsx('const a = <Fo¦o>x</Foo>;', 'jsxSelfClose'), undefined);
});

test('Intention: Expand self-closing JSX element', () => {
  assert.equal(applyTsx('const a = <Fo¦o bar="1" />;', 'jsxExpand'), 'const a = <Foo bar="1"></Foo>;');
});

test('Intention: Remove braces around a JSX string', () => {
  assert.equal(applyTsx('const a = <A title=¦{"Hi"} />;', 'jsxAttributeUnbrace'), 'const a = <A title="Hi" />;');
});

test('Intention: Put a JSX string in braces', () => {
  assert.equal(applyTsx('const a = <A title=¦"Hi" />;', 'jsxAttributeBrace'), 'const a = <A title={"Hi"} />;');
});

test('Intention: Surround with try/catch', () => {
  assert.equal(apply('l¦oad();', 'wrapInTryCatch'), lines('try {', '  load();', '} catch (error) {', '  throw error;', '}'));
  assert.equal(apply('const x = l¦oad();', 'wrapInTryCatch'), undefined);
});

test('Intention: Replace \'.then()\' with \'await\'', () => {
  assert.equal(apply(lines('async function f() {', '  ¦return load().then((d) => d.items);', '}'), 'thenToAwait'), lines('async function f() {', '  const d = await load();', '  return d.items;', '}'));
  assert.equal(apply(lines('function f() {', '  ¦return load().then((d) => d.items);', '}'), 'thenToAwait'), undefined);
});

test('Intention: Use method shorthand', () => {
  assert.equal(apply('const o = { sa¦ve: function (x: number) { return x; } };', 'functionPropertyToMethod'), 'const o = { save(x: number) { return x; } };');
});

test('Intention: Replace unary \'+\' with \'Number()\'', () => {
  assert.equal(apply('const n = ¦+input.value;', 'unaryPlusToNumber'), 'const n = Number(input.value);');
});

test('Intention: Split string at the cursor', () => {
  assert.equal(apply("const s = 'Hello ¦world';", 'splitString'), "const s = 'Hello ' + 'world';");
});

test('Intention: Join string literals', () => {
  assert.equal(apply("const s = 'Hello ' ¦+ 'world';", 'joinStrings'), "const s = 'Hello world';");
});

test('Intention: Invert if into an early return', () => {
  assert.equal(apply(lines('function f(a: boolean) {', '  i¦f (a) {', '    go();', '    stop();', '  }', '}'), 'guardClause'), lines('function f(a: boolean) {', '  if (!a) {', '    return;', '  }', '  go();', '  stop();', '}'));
  assert.equal(apply(lines('function f(a: boolean) {', '  i¦f (a) {', '    go();', '  }', '  more();', '}'), 'guardClause'), undefined);
});

test('Intention: Await independent calls together', () => {
  assert.equal(apply(lines('async function f() {', '  c¦onst user = await loadUser();', '  const cart = await loadCart();', '}'), 'awaitToPromiseAll'), lines('async function f() {', '  const [user, cart] = await Promise.all([loadUser(), loadCart()]);', '}'));
  assert.equal(apply(lines('async function f() {', '  c¦onst user = await loadUser();', '  const cart = await loadCart(user);', '}'), 'awaitToPromiseAll'), undefined);
});

test('Intention: Sort imported names', () => {
  assert.equal(apply("import { c, ¦a, type B } from './x';", 'sortImportSpecifiers'), "import { a, type B, c } from './x';");
});

test('Intention: Convert \'a.b\' to \'a["b"]\'', () => {
  assert.equal(apply('const n = user.na¦me;', 'propertyToElementAccess'), "const n = user['name'];");
});

test('Intention: Convert \'a["b"]\' to \'a.b\'', () => {
  assert.equal(apply("const n = user['na¦me'];", 'elementToPropertyAccess'), 'const n = user.name;');
  assert.equal(apply("const n = user['first-¦name'];", 'elementToPropertyAccess'), undefined);
});

test('Intention: Replace \'!== null && !== undefined\' with \'!= null\'', () => {
  assert.equal(apply('if (x !== null ¦&& x !== undefined) {}', 'nullCheckJoin'), 'if (x != null) {}');
  assert.equal(apply('if (x === undefined ¦|| x === null) {}', 'nullCheckJoin'), 'if (x == null) {}');
});

test('Intention: Replace \'!= null\' with explicit checks', () => {
  assert.equal(apply('if (x ¦!= null) {}', 'nullCheckExpand'), 'if (x !== null && x !== undefined) {}');
  assert.equal(apply('const ok = !(x ¦== null);', 'nullCheckExpand'), 'const ok = !(x === null || x === undefined);');
});

test('Intention: Remove redundant \'return\' at the end', () => {
  assert.equal(apply(lines('function f() {', '  go();', '  ret¦urn;', '}'), 'removeTrailingReturn'), lines('function f() {', '  go();', '}'));
});
