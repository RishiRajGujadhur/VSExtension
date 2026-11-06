import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { test } from 'node:test';
import { detectLayers, detectPatterns } from '../inspect/patterns';
import { patternsAlong } from '../inspect/dataFlow';

const parse = (text: string, name = 'a.tsx') => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = (text: string) => detectPatterns(parse(text)).map((p) => p.name);

test('classes: singleton, builder, observer, repository and injected dependencies', () => {
  assert.deepEqual(names('class Config { private static instance: Config; private constructor() {} static get() { return Config.instance; } }'), ['Singleton']);
  assert.deepEqual(names('class QueryBuilder { where() { return this; } limit() { return this; } build() { return 1; } }'), ['Builder']);
  assert.deepEqual(names('class Bus { private listeners: (() => void)[] = []; on(l: () => void) { this.listeners.push(l); } emit() { this.listeners.forEach((l) => l()); } }'), ['Observer']);
  assert.deepEqual(names('class OrderRepository { findById(id: string) {} save(o: object) {} }'), ['Repository']);
  assert.deepEqual(names('class Checkout { constructor(private readonly payments: PaymentGateway) {} }'), ['Dependency injection']);
});

test('functions: factory, reducer, memoization, pipeline, hooks and wrappers', () => {
  assert.deepEqual(names('function createOrder(id: string) { return new Order(id); }'), ['Factory']);
  assert.deepEqual(names('function cartReducer(state: S, action: A) { switch (action.type) { default: return { ...state }; } }'), ['Reducer']);
  assert.deepEqual(names('const cache = new Map(); function price(id: string) { if (cache.has(id)) return cache.get(id); const p = 1; cache.set(id, p); return p; }'), ['Memoization']);
  assert.deepEqual(names('function total(items: number[]) { return items.filter((i) => i > 0).map((i) => i * 2); }'), ['Pipeline']);
  assert.deepEqual(names('function Cart() { const [n, setN] = useState(0); return <div>{n}</div>; }'), ['React component with hooks']);
  assert.deepEqual(names('function logged(fn: (x: number) => number) { return (x: number) => fn(x); }'), ['Higher-order function']);
  assert.deepEqual(names('let count = 0; export function bump() { count++; }'), ['Shared module state']);
});

test('interchangeable implementations are strategies, or commands when they execute', () => {
  assert.deepEqual(names('interface Pay {} class Card implements Pay {} class Cash implements Pay {}'), ['Strategy']);
  assert.deepEqual(names('class Add implements Cmd { execute() {} } class Undo implements Cmd { execute() {} }'), ['Command']);
  // Names alone are not enough: createId returns a string, not a new object.
  assert.deepEqual(names("function createId() { return 'x'; }"), []);
});

test('layers come from folder names, and only patterns on the value’s path are reported', () => {
  assert.deepEqual(detectLayers(['/app/src/controllers/orders.ts', '/app/src/services/orders.ts', '/app/src/util.ts'], '/app'), ['controllers', 'services']);
  const source = parse('function createOrder(id: string) { const order = new Order(id); return order; }\nfunction other() { return [1].map((x) => x).filter(Boolean); }');
  const order = source.text.indexOf('order =');
  const step = { node: findIdentifier(source, order) };
  assert.deepEqual(patternsAlong([step]).map((p) => p.name), ['Factory']);
});

function findIdentifier(sourceFile: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return found;
}

test('every report kind has an explanation for the info button', async () => {
  const { explanations } = await import('../structure/explanations');
  const fs = await import('fs');
  const path = await import('path');
  const kinds = new Set<string>();
  for (const dir of ['inspect', 'navigate']) {
    for (const file of fs.readdirSync(path.resolve(__dirname, '../../src', dir))) {
      for (const m of fs.readFileSync(path.resolve(__dirname, '../../src', dir, file), 'utf8').matchAll(/new ReportBuilder\('(\w+)'/g)) {
        kinds.add(m[1]);
      }
    }
  }
  assert.deepEqual([...kinds].filter((k) => !explanations[k]), []);
  assert.match(explanations.mutations.text, /changes state that outlives the function call/);
});

test('How Do I…? names only contributed commands, and its keys match the default shortcuts', async () => {
  const { tasks } = await import('../structure/tasks');
  const fs = await import('fs');
  const path = await import('path');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const commands = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
  for (const task of tasks) {
    assert.ok(commands.has(task.command), task.command);
    if (task.key) {
      assert.ok(pkg.contributes.keybindings.some((k: { key: string; command: string }) => k.command === task.command && k.key === `ctrl+alt+s ${task.key!.toLowerCase()}`), task.command);
    }
  }
});
