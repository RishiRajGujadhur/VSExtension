import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { ProjectService } from '../analysis/project';
import { analyzeImpact, analyzeImpactAsync } from '../analysis/impact';
import { discoverTests } from '../analysis/testDiscovery';
import { AnalysisError, AnalysisScope, ImpactResult } from '../analysis/types';

const root = path.resolve(__dirname, '../..');
const sample = path.join(root, 'sample');
const edge = path.join(root, 'test-fixtures', 'edge');
const service = new ProjectService();

/** Analyzes with the cursor at the first occurrence of `marker` (at `|` within it, if present). */
function analyze(fileName: string, marker: string, scope: AnalysisScope = 'symbol'): ImpactResult {
  const text = fs.readFileSync(fileName, 'utf8');
  const cursor = marker.indexOf('|');
  const needle = marker.replace('|', '');
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `marker not found: ${needle}`);
  const project = service.load(fileName);
  return analyzeImpact(project, { fileName, offset: at + Math.max(cursor, 0), scope });
}

function titles(result: ImpactResult): string[] {
  return result.tests.map((t) => t.test.titlePath.join(' > ')).sort();
}

function find(result: ImpactResult, title: string) {
  const found = result.tests.find((t) => t.test.title === title);
  assert.ok(found, `expected ${title} in ${titles(result).join(', ')}`);
  return found;
}

test('formatImpactLabel reaches both label tests, including through displayImpactLabel', () => {
  const result = analyze(path.join(sample, 'src/impactSource.ts'), 'function |formatImpactLabel');
  assert.deepEqual(titles(result), ['impact labels > formats a single impacted test', 'impact labels > prefixes the display label']);
  const indirect = find(result, 'prefixes the display label');
  assert.deepEqual(indirect.path.map((s) => s.name), ['formatImpactLabel', 'displayImpactLabel', 'impact labels › prefixes the display label']);
  assert.equal(indirect.confidence, 'confirmed');
});

test('Active Module includes every test of the module', () => {
  const result = analyze(path.join(sample, 'src/impactSource.ts'), 'export', 'module');
  assert.equal(result.tests.length, 3);
});

test('calculateDiscount reaches tests through cart and checkout, and not unrelated cart tests', () => {
  const result = analyze(path.join(sample, 'src/discount.ts'), 'function |calculateDiscount');
  assert.deepEqual(titles(result), [
    'cart > applies discounts',
    'checkout > calculates total',
    'checkout > counts items',
    'checkout > handles coupons',
  ]);
  const viaCheckout = find(result, 'handles coupons');
  assert.deepEqual(viaCheckout.path.map((s) => s.name).slice(0, 3), ['calculateDiscount', 'calculateTotal', 'checkout']);
});

test('a symbol selected in a test file resolves the import to its declaration', () => {
  const result = analyze(path.join(sample, 'tests/cart.test.ts'), 'calculateSubtotal(items)');
  // calculateTotal calls calculateSubtotal, and checkout calls calculateTotal.
  assert.deepEqual(titles(result), [
    'cart > adds up line items',
    'cart > applies discounts',
    'checkout > calculates total',
    'checkout > counts items',
    'checkout > handles coupons',
  ]);
});

test('re-exports, renamed exports and object-literal functions are followed', () => {
  const result = analyze(path.join(edge, 'src/strings.ts'), 'function |normalize');
  assert.deepEqual(titles(result), ['strings > normalizes %s', 'strings > settings > greets by normalized name']);
  const each = find(result, 'normalizes %s');
  assert.equal(each.test.parameterized, true);
  assert.equal(each.test.dynamic, true);
});

test('recursive cycles terminate and helper-defined suites fall back to the test file', () => {
  const result = analyze(path.join(edge, 'src/strings.ts'), 'function |isOdd');
  assert.deepEqual(titles(result), ['parity.test.ts', 'strings > detects odd numbers']);
  const fallback = result.tests.find((t) => t.test.isFileEntry);
  assert.equal(fallback?.confidence, 'possible');
});

test('direct method calls are confirmed; calls through an interface are possible', () => {
  const result = analyze(path.join(edge, 'src/shapes.ts'), 'area(): number {\n    return this.side');
  assert.equal(find(result, 'square area').confidence, 'confirmed');
  const viaInterface = find(result, 'sums areas');
  assert.equal(viaInterface.confidence, 'possible');
  assert.ok(viaInterface.path.some((s) => s.name === 'Shape.area'));
});

test('shared hooks and module initialization conservatively include the whole test file', () => {
  const viaHook = analyze(path.join(edge, 'src/registry.ts'), 'export const |registry');
  assert.equal(viaHook.tests.length, 4);
  assert.ok(viaHook.tests.every((t) => t.confidence === 'possible'));

  const viaModuleInit = analyze(path.join(edge, 'src/registry.ts'), 'function |registerDefaults');
  assert.equal(viaModuleInit.tests.length, 4);
});

test('an unreferenced function has no impacted tests', () => {
  const result = analyze(path.join(edge, 'src/strings.ts'), 'function |unusedHelper');
  assert.equal(result.tests.length, 0);
});

test('a cursor inside a test body selects that test', () => {
  const result = analyze(path.join(sample, 'tests/checkout.test.ts'), 'expect(checkout(items).itemCount).toBe(|2)');
  assert.deepEqual(titles(result), ['checkout > counts items']);
});

test('library symbols are rejected with an explanation', () => {
  assert.throws(() => analyze(path.join(sample, 'src/discount.ts'), 'Math.|round'), AnalysisError);
});

test('discovery handles aliased imports, modifiers, nested suites, .each and globals', () => {
  const discover = (file: string) => {
    const text = fs.readFileSync(file, 'utf8');
    return discoverTests(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  };
  const spec = discover(path.join(edge, 'test/strings.spec.ts'));
  assert.equal(spec.framework, 'vitest');
  assert.deepEqual(
    spec.cases.map((c) => c.titlePath.join(' > ')),
    ['strings > normalizes %s', 'strings > detects odd numbers', 'strings > settings > greets by normalized name', 'registry > has defaults'],
  );
  const globals = discover(path.join(edge, 'test/shapes.test.ts'));
  assert.equal(globals.isTestFile, true);
  assert.equal(globals.cases.length, 2);
  const source = discover(path.join(edge, 'src/strings.ts'));
  assert.equal(source.isTestFile, false);
});

test('unchanged projects are reused, and unsaved editor text produces a new snapshot', () => {
  const file = path.join(sample, 'src/impactSource.ts');
  const first = service.load(file);
  assert.equal(service.load(file), first);

  const original = fs.readFileSync(file, 'utf8');
  const edited = original.replace('return `Impact: ${formatImpactLabel(count)}`;', 'return `Impact: ${count}`;');
  const overlaid = new ProjectService((f) => (path.resolve(f) === path.resolve(file) ? edited : undefined));
  const result = analyzeImpact(overlaid.load(file), { fileName: file, offset: edited.indexOf('formatImpactLabel'), scope: 'symbol' });
  assert.deepEqual(titles(result), ['impact labels > formats a single impacted test']);
  assert.notEqual(result.fileHashes[result.target.location.file], analyze(file, 'formatImpactLabel').fileHashes[result.target.location.file]);
});

test('a test file excluded from every config reports how to fix it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impact-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src'] }));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'tests/a.test.ts'), "import { a } from '../src/a';\nit('a', () => a);\n");
    assert.throws(() => new ProjectService().load(path.join(dir, 'tests/a.test.ts')), /same compiler project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cancellable analysis finds the same tests, and stops when cancelled', async () => {
  const fileName = path.join(sample, 'src/impactSource.ts');
  const offset = fs.readFileSync(fileName, 'utf8').indexOf('formatImpactLabel');
  const fresh = new ProjectService();
  const result = await analyzeImpactAsync(fresh.load(fileName), { fileName, offset, scope: 'symbol' });
  assert.deepEqual(titles(result!), titles(analyze(fileName, 'function |formatImpactLabel')));
  assert.equal(await analyzeImpactAsync(new ProjectService().load(fileName), { fileName, offset, scope: 'symbol' }, {}, { isCancellationRequested: true }), undefined);
});
