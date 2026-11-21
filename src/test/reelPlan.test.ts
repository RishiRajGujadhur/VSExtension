import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReelPlan, fitDuration, keepUserCaptions, parseHunks, redact, ReelScene, skipReason, titleFromBranch } from '../reel/plan';

/** A throwaway repository: one commit, then the working tree changed. */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'cart.ts'), "export function total(items: number[]) {\n  let sum = 0;\n  for (const i of items) sum += i;\n  return sum;\n}\n\nexport function label(n: number) {\n  return `${n} items`;\n}\n");
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n');
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add the cart');
  git('checkout', '-q', '-b', 'feat/retry-checkout');
  fs.writeFileSync(path.join(dir, 'cart.ts'), "export function total(items: number[]) {\n  if (!items.length) return 0;\n  let sum = 0;\n  for (const i of items) sum += i;\n  return sum;\n}\n\nexport function label(n: number) {\n  return `${n} items`;\n}\n");
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nRetry the checkout.\n');
  fs.writeFileSync(path.join(dir, 'config.ts'), 'export const apiKey = "sk_live_1234567890abcdef";\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n');
  return dir;
}

test('Git reel: overview, a scene per changed function with its flowchart, other files, summary', async () => {
  const dir = repo();
  const plan = await buildReelPlan({ repo: dir, ref: 'HEAD', baseLabel: 'the last commit' });
  assert.equal(plan.meta.title, 'Uncommitted changes');
  assert.equal(plan.meta.head, 'feat/retry-checkout');
  // The lock file and .env are left out.
  assert.equal(plan.meta.skipped, 2);
  assert.equal(plan.meta.files, 3);
  // The function's code, then its flowchart on its own.
  // No flowchart scenes: each change is its code and what it does.
  assert.deepEqual(plan.scenes.map((s) => s.kind), ['overview', 'diff', 'diff', 'diff', 'summary']);
  const fn = plan.scenes.find((s): s is Extract<ReelScene, { kind: 'diff' }> => s.kind === 'diff' && s.symbol === 'total')!;
  // What it does, in words; no counts.
  assert.equal(fn.caption, 'total now returns 0 early when there are no items.');
  assert.equal(fn.line, 2);
  // Only the key change: the new early exit, framed, the callout on it.
  assert.deepEqual(fn.lines.filter((l) => l.kind === 'add').map((l) => l.text), ['  if (!items.length) return 0;']);
  assert.equal(fn.lines[fn.key!.focus].kind, 'add');
  assert.match(fn.key!.label, /^Key change/);
  // The secret is masked in the code shown.
  const config = plan.scenes.find((s): s is Extract<ReelScene, { kind: 'diff' }> => s.kind === 'diff' && s.file === 'config.ts')!;
  // The caption shows the file's name; the voice says neither it nor any number.
  assert.equal(config.caption, 'config.ts — This new file adds the API key setting.');
  assert.ok(plan.scenes.every((sc) => !/\b\d+ (files?|lines?|boxes|paths?|changes?)\b/.test(sc.caption)), plan.scenes.map((sc) => sc.caption).join(' | '));
  assert.match(config.lines[0].text, /apiKey = "••••"/);
  assert.ok(plan.scenes.reduce((n, s) => n + s.seconds, 0) <= 90);
  // The same change gives the same plan.
  assert.deepEqual(await buildReelPlan({ repo: dir, ref: 'HEAD', baseLabel: 'the last commit' }), plan);
});

test('Git reel: captions written by hand stay on their scene when the plan is built again', async () => {
  const dir = repo();
  const plan = await buildReelPlan({ repo: dir, ref: 'HEAD', baseLabel: 'the last commit' });
  const edited = { ...plan, scenes: plan.scenes.map((s) => (s.id === 'cart.ts#total' ? { ...s, caption: 'Guard against an empty cart', captionSource: 'user' as const } : s)) };
  const again = keepUserCaptions(await buildReelPlan({ repo: dir, ref: 'HEAD', baseLabel: 'the last commit' }), edited);
  const scene = again.scenes.find((s) => s.id === 'cart.ts#total')!;
  assert.deepEqual([scene.caption, scene.captionSource], ['Guard against an empty cart', 'user']);
  assert.equal(again.scenes.find((s) => s.id === 'overview')!.captionSource, 'heuristic');
});

test('Git reel helpers: hunks, redaction, files left out, titles, length', () => {
  const hunks = parseHunks('diff --git a/x b/x\n@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n');
  assert.deepEqual(hunks[0].lines.map((l) => `${l.kind}${l.line}`), ['ctx1', 'del2', 'add2', 'add3', 'ctx4']);
  assert.equal(redact('const password = "hunter22";'), 'const password = "••••";');
  assert.equal(redact('const token = getToken();'), 'const token = getToken();');
  assert.equal(redact('key: AKIAABCDEFGHIJKLMNOP'), 'key: AKIA••••');
  const file = (p: string, binary = false) => ({ path: p, added: 1, removed: 0, binary, status: 'modified' as const });
  assert.deepEqual(['yarn.lock', 'dist/app.js', 'a.min.js', '.env.local', 'logo.png', 'src/a.ts'].map((p) => skipReason(file(p, p.endsWith('.png')))), ['lock file', 'build output', 'generated', 'secret', 'binary', undefined]);
  assert.equal(titleFromBranch('feat/retry-checkout'), 'Retry checkout');
  const scenes: ReelScene[] = [
    { kind: 'overview', id: 'o', caption: '', captionSource: 'heuristic', seconds: 5 },
    ...Array.from({ length: 10 }, (_, i): ReelScene => ({ kind: 'diff', id: String(i), file: 'a', added: 1, removed: 0, lines: [], caption: '', captionSource: 'heuristic', seconds: 9 })),
    { kind: 'summary', id: 's', points: [], caption: '', captionSource: 'heuristic', seconds: 5 },
  ];
  fitDuration(scenes, 60);
  assert.ok(scenes.reduce((n, s) => n + s.seconds, 0) <= 60.5);
  assert.equal(scenes[0].seconds, 5);
});

test('Git reel: one scene per file, its key change, and what each file is for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-cart-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'pipe' });
  const cart = (extra: string) =>
    `import { log } from './log';\n\nexport function addToCart(items: Item[], item: Item): Item[] {\n${extra}  log('add');\n  return [...items, item];\n}\n\nexport function cartLabel(n: number) {\n  return \`\${n} items\`;\n}\n`;
  const view = (extra: string) => `export function CartItems({ items }: { items: Item[] }) {\n  return (\n    <ul>\n${extra}    </ul>\n  );\n}\n`;
  fs.writeFileSync(path.join(dir, 'cart.ts'), cart(''));
  fs.writeFileSync(path.join(dir, 'CartItems.tsx'), view(''));
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'Cart');
  fs.writeFileSync(path.join(dir, 'cart.ts'), cart('  if (!item.inStock) return items;\n  // Keep the order the items were added in.\n'));
  fs.writeFileSync(path.join(dir, 'CartItems.tsx'), view('      {items.map((item) => (\n        <li key={item.id}>{item.name}</li>\n      ))}\n'));
  const plan = await buildReelPlan({ repo: dir, ref: 'HEAD', baseLabel: 'the last commit' });
  const diffs = plan.scenes.filter((s): s is Extract<ReelScene, { kind: 'diff' }> => s.kind === 'diff');
  assert.deepEqual(diffs.map((d) => d.file).sort(), ['CartItems.tsx', 'cart.ts']);
  const add = diffs.find((d) => d.file === 'cart.ts')!;
  assert.equal(add.feature, 'Adds item to cart');
  assert.match(add.caption, /^addToCart adds an item to the cart\. It now /);
  assert.equal(add.lines[add.key!.focus].text.trim(), 'if (!item.inStock) return items;');
  assert.equal(add.key!.label, 'Key change: early exit');
  const show = diffs.find((d) => d.file === 'CartItems.tsx')!;
  assert.equal(show.feature, 'Shows cart items');
  assert.ok(show.lines.length <= 12);
});
