import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { test } from 'node:test';
import { detectPatterns } from '../inspect/patterns';

const names = (code: string) => detectPatterns(ts.createSourceFile('a.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).map((p) => p.name);
const has = (code: string, name: string) => assert.ok(names(code).includes(name), `${name} not in ${names(code).join(', ')}`);
const lacks = (code: string, name: string) => assert.ok(!names(code).includes(name), `${name} found`);

test('Adapter is recognized', () => {
  has('interface Logger { log(m: string): void; warn(m: string): void } class ConsoleAdapter implements Logger { constructor(private readonly out: Console) {} log(m: string) { this.out.info(m); } warn(m: string) { this.out.error(m); } }', 'Adapter');
});

test('Facade is recognized', () => {
  has('class Checkout { constructor(private cart: Cart, private payments: Payments, private mail: Mailer) {} placeOrder() { this.cart.lock(); this.payments.charge(); this.mail.send(); } }', 'Facade');
});

test('Proxy is recognized', () => {
  has('const settings = new Proxy({}, { get: (t, k) => 1 });', 'Proxy');
});

test('Decorator is recognized', () => {
  has('interface Store { get(k: string): string } class CachingStore implements Store { constructor(private inner: Store) {} get(k: string) { return this.inner.get(k); } }', 'Decorator');
  lacks('interface Store { get(k: string): string } class CachingStore implements Store { constructor(private inner: Store) {} get(k: string) { return this.inner.get(k); } }', 'Adapter');
});

test('Template method is recognized', () => {
  has('abstract class Report { abstract body(): string; render() { return "<h1>" + this.body(); } }', 'Template method');
});

test('State is recognized', () => {
  has('class Light { private state: LightState = new Off(); press() { this.state.press(this); } describe() { return this.state.name(); } }', 'State');
});

test('Event bus is recognized', () => {
  has('class Bus { private handlers = new Map<string, Array<() => void>>(); on(e: string, h: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), h]); } emit(e: string) { this.handlers.get(e)?.forEach((h) => h()); } }', 'Event bus');
});

test('Chain of responsibility is recognized', () => {
  has('class Handler { constructor(private next?: Handler) {} handle(r: string): string { return this.next?.handle(r) ?? r; } }', 'Chain of responsibility');
});

test('Composite is recognized', () => {
  has('class Item { children: Item[] = []; size(): number { return 1 + this.children.reduce((n, c) => n + c.size(), 0); } }', 'Composite');
});

test('Visitor is recognized', () => {
  has('class Num { accept(v: Visitor) { return v.visitNum(this); } }', 'Visitor');
});

test('Iterator is recognized', () => {
  has('class Range { *[Symbol.iterator]() { yield 1; } }', 'Iterator');
  has('function* ids() { yield 1; }', 'Iterator');
});

test('Prototype is recognized', () => {
  has('class Shape { clone() { return new Shape(); } }', 'Prototype');
});

test('Object pool is recognized', () => {
  has('class Pool { private free: Conn[] = []; acquire() { return this.free.pop() ?? new Conn(); } release(c: Conn) { this.free.push(c); } }', 'Object pool');
});

test('Lazy initialization is recognized', () => {
  has('class Db { private conn?: Conn; get connection() { this.conn ??= new Conn(); return this.conn; } }', 'Lazy initialization');
});

test('Middleware is recognized', () => {
  has('function auth(req: Req, res: Res, next: () => void) { if (req.user) next(); }', 'Middleware');
});

test('Retry is recognized', () => {
  has('async function fetchWithRetry() { for (let i = 0; i < 3; i++) { try { return await get(); } catch { await sleep(100 * 2 ** i); } } }', 'Retry');
});

test('Debounce or throttle is recognized', () => {
  has('function debounce(fn: () => void, ms: number) { let t: any; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }', 'Debounce or throttle');
});

test('Circuit breaker is recognized', () => {
  has("class Breaker { private state: 'open' | 'closed' | 'half-open' = 'closed'; private failures = 0; call() { if (this.state === 'open') throw new Error(); } }", 'Circuit breaker');
});

test('Context provider is recognized', () => {
  has('const Theme = createContext("light"); export function App() { return <Theme.Provider value="dark"><div /></Theme.Provider>; }', 'Context provider');
});

test('Higher-order component is recognized', () => {
  has('function withUser(Wrapped: Comp) { return (props: P) => <Wrapped {...props} user={1} />; }', 'Higher-order component');
});

test('Render props is recognized', () => {
  has('function A() { return <List render={(x: string) => <b>{x}</b>} />; }', 'Render props');
});

test('Custom hook is recognized', () => {
  has('function useCart() { const [c] = useState(0); return c; }', 'Custom hook');
  lacks('function useCart() { const [c] = useState(0); return c; }', 'React component with hooks');
});

test('Store is recognized', () => {
  has('const store = configureStore({ reducer: {} });', 'Store');
});

test('Service locator is recognized', () => {
  has('class Container { private factories = new Map<string, () => unknown>(); register(k: string, f: () => unknown) { this.factories.set(k, f); } resolve(k: string) { return this.factories.get(k)!(); } }', 'Service locator');
});

test('Null object is recognized', () => {
  has('class NullLogger implements Logger { log() {} warn() {} }', 'Null object');
});

test('Value object is recognized', () => {
  has('class Money { constructor(readonly amount: number, readonly currency: string) {} equals(o: Money) { return o.amount === this.amount; } }', 'Value object');
});

test('Module pattern is recognized', () => {
  has('const counter = (() => { let n = 0; return { inc: () => ++n }; })();', 'Module pattern');
});

test('Fluent interface is recognized', () => {
  has('class Query { where() { return this; } order() { return this; } limit() { return this; } }', 'Fluent interface');
  lacks('class QueryBuilder { where() { return this; } limit() { return this; } build() { return 1; } }', 'Fluent interface');
});

test('Promise chain is recognized', () => {
  has('function load() { return fetch("/x").then((r) => r.json()).then((d) => d.items); }', 'Promise chain');
});

test('Mixin is recognized', () => {
  has('function Timestamped<T extends new (...a: any[]) => object>(Base: T) { return class extends Base { at = Date.now(); }; }', 'Mixin');
});

test('Design patterns: recognize Abstract factory', () => {
  has('class LightTheme implements Ui { button() { return new LightButton(); } input() { return new LightInput(); } } class DarkTheme implements Ui { button() { return new DarkButton(); } input() { return new DarkInput(); } }', 'Abstract factory');
});

test('Design patterns: recognize Barrel module', () => {
  has("export * from './cart';\nexport { total } from './pricing';", 'Barrel module');
  lacks("export * from './cart';\nexport const x = 1;", 'Barrel module');
});
