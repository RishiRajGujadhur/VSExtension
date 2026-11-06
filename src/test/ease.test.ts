import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as ts from 'typescript';
import { test } from 'node:test';
import { FixLedger, RowFix, countFixes, fixesUnder, mergeEdits } from '../structure/fixes';
import { fileSymbols, symbolAt } from '../structure/symbols';
import { publicTagEdit } from '../inspect/deadExports';
import { filterReport } from '../structure/markdown';
import { ReportNode } from '../structure/report';
import { mutationReport } from '../inspect/effects';
import { describeIntroduceParameter } from '../refactor/introduceParameter';
import { fixtures, offsetIn, virtualProject } from './helpers';

const apply = (text: string, edits: { start: number; end: number; text: string }[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

test('a fix computed before earlier fixes in the same file is moved past them', () => {
  const original = 'load(); save(); send();';
  const fix = (start: number): RowFix => ({ file: '/a.ts', hash: 'h0', edits: [{ start, end: start, text: 'await ' }], title: 'Add await' });
  const ledger = new FixLedger();
  const first = ledger.rebase(fix(0), 'h0')!;
  const afterFirst = apply(original, first);
  ledger.record('/a.ts', first, 'h0', 'h1');
  const second = ledger.rebase(fix(16), 'h1')!;
  const afterSecond = apply(afterFirst, second);
  ledger.record('/a.ts', second, 'h1', 'h2');
  assert.equal(afterSecond, 'await load(); save(); await send();');
  // The file's fix-all, also computed before both, only adds what is not done yet.
  const all: RowFix = { file: '/a.ts', hash: 'h0', edits: [0, 8, 16].map((start) => ({ start, end: start, text: 'await ' })), title: 'Fix all' };
  assert.equal(apply(afterSecond, ledger.rebase(all, 'h2')!), 'await load(); await save(); await send();');
  // A change made elsewhere, outside the ledger, makes the fix unsafe to place.
  assert.equal(ledger.rebase(fix(8), 'other'), undefined);
});

test('a fix that overlaps an earlier one is refused', () => {
  const ledger = new FixLedger();
  ledger.record('/a.ts', [{ start: 0, end: 4, text: 'x' }], 'h0', 'h1');
  assert.equal(ledger.rebase({ file: '/a.ts', hash: 'h0', edits: [{ start: 2, end: 6, text: 'y' }], title: '' }, 'h1'), undefined);
});

test('fixes under a group are merged per file, and a file row stands for its findings', () => {
  const fix = (file: string, start: number) => ({ kind: 'applyFix', file, hash: 'h', edits: [{ start, end: start, text: 'void ' }], title: 'fix' });
  const group: ReportNode = {
    label: 'missingAwait',
    children: [
      { label: 'a.ts', action: { ...fix('/a.ts', 0), edits: [{ start: 0, end: 0, text: 'void ' }, { start: 9, end: 9, text: 'void ' }] }, children: [{ label: 'one', action: fix('/a.ts', 0) }, { label: 'two', action: fix('/a.ts', 9) }] },
      { label: 'b.ts', children: [{ label: 'three', action: fix('/b.ts', 4) }, { label: 'four', action: fix('/b.ts', 4) }] },
    ],
  };
  const fixes = fixesUnder(group);
  assert.deepEqual(
    fixes.map((f) => [f.file, f.edits.map((e) => e.start)]),
    [
      ['/a.ts', [0, 9]],
      ['/b.ts', [4]],
    ],
  );
  assert.equal(countFixes(group), 4);
  assert.equal(countFixes(group, (n) => n.label === 'b.ts'), 2, 'rows already done are not counted');
  assert.deepEqual(mergeEdits([{ start: 5, end: 8, text: 'a' }, { start: 0, end: 1, text: 'b' }, { start: 6, end: 7, text: 'c' }]).map((e) => e.text), ['b', 'a']);
});

test('file symbols name what each analysis can start from', () => {
  const source = ts.createSourceFile(
    'a.ts',
    `import { load } from './load';
export async function save(order: Order) { const total = 1; }
class Cart { items = []; add(item: string) {} }
interface Order { id: string }
const send = () => 1;`,
    ts.ScriptTarget.Latest,
    true,
  );
  const symbols = fileSymbols(source);
  assert.deepEqual(
    symbols.map((s) => `${s.kind} ${s.name}${s.container ? ` in ${s.container}` : ''}${s.async ? ' async' : ''}${s.callable ? ' callable' : ''}`),
    ['import load', 'function save async', 'parameter order in save()', 'variable total in save()', 'class Cart', 'member items in Cart', 'member add in Cart callable', 'parameter item in Cart.add()', 'interface Order', 'member id in Order', 'function send'],
  );
  assert.equal(symbolAt(source, source.text.indexOf('total') + 2)?.name, 'total');
  assert.equal(symbolAt(source, source.text.indexOf('= 1')), undefined);
});

test('@public goes into the JSDoc of the declaration, or on a line of its own', () => {
  const at = (text: string, name: string) => {
    const source = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true);
    const edit = publicTagEdit(source, text.indexOf(name))!;
    return text.slice(0, edit.offset) + edit.text + text.slice(edit.offset);
  };
  assert.equal(at('const a = 1;\n  export function total() {}\n', 'total'), 'const a = 1;\n  /** @public */\n  export function total() {}\n');
  assert.equal(at('/** Sums. */\nexport function total() {}\n', 'total'), '/** Sums. @public */\nexport function total() {}\n');
  assert.equal(at('/**\n * Sums.\n */\nexport const total = 1;\n', 'total'), '/**\n * Sums.\n * @public\n */\nexport const total = 1;\n');
});

test('file: in the results filter keeps rows in matching files', () => {
  const at = (file: string) => ({ file, line: 0, character: 0, endLine: 0, endCharacter: 1 });
  const roots: ReportNode[] = [{ label: 'Calls', children: [{ label: 'cart call', location: at('C:\\repo\\src\\cart.ts') }, { label: 'main call', location: at('/repo/src/main.ts') }] }];
  assert.deepEqual(filterReport(roots, 'file:src/cart').map((r) => r.children?.map((c) => c.label)), [['cart call']]);
  assert.deepEqual(filterReport(roots, 'main').map((r) => r.children?.map((c) => c.label)), [['main call']]);
});

test('mutation tracking selects the function around the cursor', () => {
  const file = path.join(fixtures, 'inspect/src/effects.ts');
  const program = virtualProject('inspect', 'src/effects.ts').program();
  const report = mutationReport(program, file, offsetIn(file, 'addItem(li|st, name)'));
  const focused = byLabel(report, 'Functions that mutate state').filter((f) => f.focus);
  assert.deepEqual(focused.map((f) => f.label), ['track']);
  // Module state can be looked up by its usages from its row.
  const cache = byLabel(report, 'Shared state and who changes it').find((c) => c.label === 'cache');
  assert.equal(cache?.action?.command, 'tsStructure.semanticUsages');
});

test('introduce parameter lists the names the new parameter must not reuse', () => {
  const pricing = path.join(fixtures, 'introduce/src/pricing.ts');
  const source = ts.sys.readFile(pricing)!;
  const start = source.indexOf('(1 + 0.2)');
  const info = describeIntroduceParameter(virtualProject('introduce', 'src/pricing.ts'), pricing, start, start + '(1 + 0.2)'.length);
  assert.deepEqual(info.usedNames.sort(), ['base', 'qty', 'subtotal']);
});

/** The rows of a mutation report's group. */
function byLabel(report: { roots: { label: string; children?: any[] }[] }, label: string): any[] {
  return report.roots.find((r) => r.label === label)!.children!;
}
