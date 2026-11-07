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

test('Design patterns: recognize Result type', () => {
  has('type Result<T> = { ok: true; value: T } | { ok: false; error: Error };', 'Result type');
});

test('Design patterns: recognize Plugin registry', () => {
  has('class App { private plugins: Plugin[] = []; use(p: Plugin) { this.plugins.push(p); } start() { this.plugins.forEach((p) => p.install(this)); } }', 'Plugin registry');
});

test('Design patterns: recognize API client', () => {
  has('class UsersApi { list() { return fetch("/users"); } get(id: string) { return fetch(`/users/${id}`); } }', 'API client');
});

test('Design patterns: recognize Module-level singleton', () => {
  has('export const db = new Database("app.db");', 'Module-level singleton');
  lacks('export const cache = new Map();', 'Module-level singleton');
});

test('Design patterns: recognize Strategy map', () => {
  has('const handlers = { add: (a: number) => a, remove: (a: number) => a, clear: () => 0 }; export function run(k: keyof typeof handlers) { return handlers[k](1); }', 'Strategy map');
});

test('Design patterns: recognize State machine', () => {
  has('const machine = { initial: "idle", states: { idle: { on: { FETCH: "loading" } }, loading: { on: { DONE: "idle" } } } };', 'State machine');
});

test('Design patterns: recognize Specification', () => {
  has('class AdultSpec { isSatisfiedBy(u: { age: number }) { return u.age >= 18; } }', 'Specification');
});

test('Design patterns: recognize Unit of work', () => {
  has('class UnitOfWork { commit() {} rollback() {} }', 'Unit of work');
});

test('Discriminated union is recognized', () => {
  has("type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number };", 'Discriminated union');
  lacks('type Id = { a: string } | { b: number };', 'Discriminated union');
});

test('Type guard is recognized', () => {
  has('function isUser(x: unknown): x is User { return typeof x === "object"; }', 'Type guard');
  lacks('function isUser(x: unknown): boolean { return typeof x === "object"; }', 'Type guard');
});

test('Assertion function is recognized', () => {
  has('function assertDefined<T>(x: T | undefined): asserts x is T { if (x === undefined) throw new Error(); }', 'Assertion function');
  has('function assert(c: unknown): asserts c { if (!c) throw new Error(); }', 'Assertion function');
});

test('Branded type is recognized', () => {
  has("type UserId = string & { readonly __brand: 'UserId' };", 'Branded type');
  lacks('type Named = { name: string } & { id: number };', 'Branded type');
});

test('Constant object as enum is recognized', () => {
  has("const Role = { Admin: 'admin', User: 'user' } as const; type Role = (typeof Role)[keyof typeof Role];", 'Constant object as enum');
  lacks("const Role = { Admin: 'admin' } as const;", 'Constant object as enum');
});

test('Exhaustive check is recognized', () => {
  has('function area(s: Shape) { switch (s.kind) { default: { const unhandled: never = s; return unhandled; } } }', 'Exhaustive check');
  has('function assertNever(x: never): never { throw new Error(String(x)); }', 'Exhaustive check');
});

test('Mediator is recognized', () => {
  has('class Dialog { constructor(private title: TextBox, private ok: Button) {} notify(sender: object, event: string) { if (event === "change") this.ok.enable(); } }', 'Mediator');
  lacks('class Dialog { constructor(private title: TextBox) {} notify(sender: object, event: string) {} }', 'Mediator');
});

test('Memento is recognized', () => {
  has('class Editor { private text = ""; snapshot() { return { text: this.text }; } restore(s: { text: string }) { this.text = s.text; } }', 'Memento');
});

test('Flyweight is recognized', () => {
  has('class Glyphs { private cache = new Map<string, Glyph>(); get(c: string) { if (!this.cache.has(c)) this.cache.set(c, new Glyph(c)); return this.cache.get(c)!; } }', 'Flyweight');
});

test('Bridge is recognized', () => {
  has('interface Device { on(): void } class Tv implements Device { on() {} } class Radio implements Device { on() {} } class Remote { constructor(protected device: Device) {} power() { this.device.on(); } } class AdvancedRemote extends Remote { mute() {} }', 'Bridge');
});

test('Compound components are recognized', () => {
  has('function Tabs() { return <div />; } function Panel() { return <section />; } Tabs.Panel = Panel;', 'Compound components');
  has('function Menu() { return <ul />; } function Item() { return <li />; } export default Object.assign(Menu, { Item });', 'Compound components');
});

test('Error boundary is recognized', () => {
  has('class Boundary extends React.Component { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } render() { return this.props.children; } }', 'Error boundary');
});

test('Controlled component is recognized', () => {
  has('function Name() { const [v, setV] = useState(""); return <input value={v} onChange={(e) => setV(e.target.value)} />; }', 'Controlled component');
  lacks('function Name() { return <input defaultValue="x" />; }', 'Controlled component');
});

test('Memoized component is recognized', () => {
  has('const Row = memo(function Row(p: { id: string }) { return <li>{p.id}</li>; });', 'Memoized component');
  has('export default React.memo(List);', 'Memoized component');
});

test('Lazy-loaded component is recognized', () => {
  has('const Settings = lazy(() => import("./Settings"));', 'Lazy-loaded component');
});

test('Portal is recognized', () => {
  has('function Modal(p: { children: any }) { return createPortal(<div>{p.children}</div>, document.body); }', 'Portal');
});

test('Forwarded ref is recognized', () => {
  has('const Field = forwardRef<HTMLInputElement, {}>((props, ref) => <input ref={ref} />);', 'Forwarded ref');
});
