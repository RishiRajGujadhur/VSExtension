import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import ts = require('typescript');
import { FileSymbol } from '../structure/symbols';
import { otherLanguageSelectionFit, selectionFit } from '../structure/selectionFit';

const code = `import { tax } from './tax';

export function checkout(items: number[], code?: string) {
  let total = 0;
  for (const i of items) total += i;
  if (code) {
    total = total * 0.9;
  }
  return total + tax(total);
}

export async function load(id: string) {
  const res = await fetch(id);
  return res.json();
}

export const rate = 0.2;
`;
const file = ts.createSourceFile('c:/demo/cart.ts', code, ts.ScriptTarget.Latest, true);
// What the cursor analyses say for each kind of declaration, simplified.
const forSymbol = (s: FileSymbol) => (s.kind === 'function' ? ['tsStructure.callGraph', 'tsStructure.controlFlow'] : ['tsStructure.dataFlow']);
const fit = (from: string, to: string = from, nth = 0) => {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = code.indexOf(from, start + 1);
  return selectionFit(file, start, code.indexOf(to, start) + to.length, forSymbol);
};

test('Highlighted name: the analyses of what it names, and the edits of a declaration', () => {
  const name = fit('total', 'total', 1);
  assert.equal(name?.subject, 'the name total');
  assert.ok(name!.commands.includes('tsStructure.dataFlow'));
  assert.ok(!name!.commands.includes('tsStructure.controlFlow'));
  const fn = fit('checkout');
  assert.ok(fn!.commands.includes('tsStructure.callGraph') && fn!.commands.includes('tsStructure.changeSignature') && fn!.commands.includes('tsStructure.moveMembers'), fn!.commands.join(', '));
});

test('Highlighted code in a function: the charts of the function and the range tools, not the name analyses', () => {
  const body = fit('for (const i', '}');
  assert.equal(body?.subject, 'code in checkout()');
  for (const c of ['tsStructure.controlFlow', 'tsStructure.controlFlowCompare', 'tsStructure.dependenceGraph', 'tsStructure.findDuplicates', 'tsStructure.structuralSearch', 'tsStructure.inspectCode']) assert.ok(body!.commands.includes(c), c);
  for (const c of ['tsStructure.dataFlow', 'tsStructure.callGraph', 'tsStructure.introduceParameter', 'tsStructure.promiseRejections', 'tsStructure.moveMembers']) assert.ok(!body!.commands.includes(c), c);
});

test('Highlighted expression: it can become a parameter; async code gets the async charts', () => {
  assert.ok(fit('total * 0.9')!.commands.includes('tsStructure.introduceParameter'));
  // Half an expression is not one.
  assert.ok(!fit('* 0.9;')!.commands.includes('tsStructure.introduceParameter'));
  const inLoad = fit('const res', 'res.json();');
  assert.equal(inLoad?.subject, 'code in load()');
  assert.ok(inLoad!.commands.includes('tsStructure.promiseRejections') && inLoad!.commands.includes('tsStructure.asyncTimeline'));
});

test('A whole function highlighted is that function; whole declarations can move; spaces alone are nothing', () => {
  const whole = fit('export function checkout', 'tax(total);\n}');
  assert.equal(whole?.subject, 'the function checkout()');
  assert.ok(whole!.commands.includes('tsStructure.controlFlow') && whole!.commands.includes('tsStructure.changeSignature'));
  const both = fit('export async function load', '0.2;');
  assert.equal(both?.subject, '2 declarations');
  assert.ok(both!.commands.includes('tsStructure.moveMembers') && both!.commands.includes('tsStructure.deadExports'));
  assert.ok(!both!.commands.includes('tsStructure.controlFlow'));
  assert.equal(selectionFit(file, code.indexOf('\n\nexport'), code.indexOf('\n\nexport') + 2, forSymbol), undefined);
});

test('C# and T-SQL: names get the name analyses, code the flowchart family, from the language list', () => {
  const list = ['tsStructure.controlFlow', 'tsStructure.controlFlowCompare', 'tsStructure.dependenceGraph', 'tsStructure.semanticUsages', 'tsStructure.callGraph'];
  const cs = 'var amount = cart.Price();';
  assert.deepEqual(otherLanguageSelectionFit(cs, 4, 10, list), { subject: 'the name amount', commands: ['tsStructure.semanticUsages', 'tsStructure.callGraph'] });
  assert.deepEqual(otherLanguageSelectionFit(cs, 0, cs.length, list)!.commands, ['tsStructure.controlFlow', 'tsStructure.controlFlowCompare', 'tsStructure.dependenceGraph']);
  assert.equal(otherLanguageSelectionFit('SET @total = 1', 4, 10, list)!.subject, 'the name @total');
});
