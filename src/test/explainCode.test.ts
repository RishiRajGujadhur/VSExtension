import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { explainCode } from '../explain/explainCode';
import { CodeModel } from '../reel/codeModel';
import { CODE_MODEL, downloadDisclosure } from '../reel/codeModelText';
import { explanationReel } from '../explain/explainReel';
import { explanationHtml } from '../explain/explainHtml';
import type { ReelScene } from '../reel/plan';

const root = path.resolve(__dirname, '../..');
const modelDir = path.join(root, 'assets', 'code-model');
const runnable = CODE_MODEL.files.every((f) => fs.existsSync(path.join(modelDir, f.name))) && fs.existsSync(path.join(root, 'dist', 'codeModelWorker.js'));

const code = `type Config = { repositoryRoot: string };

export async function currentConfig(): Promise<Config> {
  try {
    const r = await apiCall<{ config: Config }>(ctx.origin, '/workspace');
    ctx.repository = r.config.repositoryRoot;
    return r.config;
  } catch {
    let saved: Config | undefined;
    try { saved = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'workspace.json'), 'utf8')); } catch { /* none */ }
    const config = saved ?? { repositoryRoot: path.join(resourcesRoot(), 'fixtures') };
    ctx.repository = config.repositoryRoot;
    return config;
  }
}

export function addToCart(items: Item[], item: Item): Item[] {
  if (!item.inStock) return items;
  return [...items, item];
}
`;
const range = (from: string, to?: string): [number, number] => {
  const a = code.indexOf(from);
  return [a, to ? code.indexOf(to, a) + to.length : code.indexOf('\n}\n', a) + 2];
};

test('Explain this code: a function step by step, in the order it runs, with its fallback', async () => {
  const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  assert.equal(e.subject, 'the function currentConfig()');
  assert.equal(e.summary, 'currentConfig is an async function that returns a Config, once it finishes.');
  assert.deepEqual(e.steps, [
    'It asks the server for the workspace.',
    "It sets the context repository to the config's repository root.",
    'It returns the config.',
    'If something goes wrong, it reads the JSON.',
    'Then it falls back to a default when there is none.',
  ]);
});

test('Explain this code: what a function is for, by the rules; a few lines on their own', async () => {
  const cart = await explainCode('cart.ts', code, ...range('export function addToCart'));
  assert.deepEqual(cart.purpose, { text: 'Adds item to cart', by: 'rules' });
  assert.equal(cart.steps[0], "If the item's in stock is not set, it returns the items.");
  const lines = await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };'));
  assert.equal(lines.subject, 'the highlighted lines in currentConfig()');
  assert.deepEqual(lines.steps, ['It falls back to a default when there is none.']);
});

test('Explain this code: before any download, it says what is sent and what never is', () => {
  const said = downloadDisclosure();
  assert.match(said, /huggingface\.co/);
  assert.match(said, /IP address/);
  assert.match(said, /none of your code, file names, account details, tokens or settings/);
  assert.match(said, /model_quantized\.onnx and vocab\.txt/);
});

test('Explain this code: the code model names what the rules cannot', { skip: !runnable && 'needs assets/code-model and the bundle', timeout: 120000 }, async () => {
  const model = new CodeModel(modelDir, path.join(root, 'dist', 'codeModelWorker.js'), path.join(root, 'dist', 'kitten', 'ort'));
  try {
    const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'), (texts) => model.embed(texts));
    assert.deepEqual(e.purpose, { text: 'Loads current config', by: 'model' });
  } finally {
    model.dispose();
  }
});

test('Explain this code as a video: a scene per step on the flowchart, this step amber, the steps so far green', async () => {
  const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  const plan = explanationReel(e, 'src/workspace.ts')!;
  assert.deepEqual(plan.scenes.map((s) => s.kind), ['overview', ...e.steps.map(() => 'flow'), 'summary']);
  assert.equal(plan.meta.title, 'What currentConfig() does');
  assert.equal(plan.meta.chip, 'workspace.ts');
  assert.match(plan.scenes[0].caption, /^currentConfig is an async function .* Let's walk through it, step by step\.$/);
  const steps = plan.scenes.filter((s): s is Extract<ReelScene, { kind: 'flow' }> => s.kind === 'flow');
  assert.deepEqual(steps.map((s) => s.caption), e.steps);
  assert.deepEqual(steps.map((s) => s.chapter), e.steps.map((_, i) => `Step ${i + 1}`));
  for (const [i, s] of steps.entries()) {
    assert.ok(s.flow.walk);
    // Each step lights its own boxes; the ones before stay green.
    assert.ok(s.flow.nodes.some((n) => n.state === 'changed'), `step ${i + 1} lights a box`);
  }
  // The lines know the boxes they join, so the player can send the flow along them into each step.
  assert.ok(steps.every((s) => s.flow.edges.every((edge) => typeof edge.from === "number" && typeof edge.to === "number")));
  // Steps in the same box light the same box; by the last step the ones before are green.
  assert.ok(steps[steps.length - 1].flow.nodes.some((n) => n.state === 'added'), 'the last step keeps the steps so far');
  // Lines that are not a whole function have no flowchart to walk.
  assert.equal(explanationReel(await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };')), 'x.ts'), undefined);
});

test('Explain this code: the page offers the video only for a whole function, as a command link', async () => {
  const fn = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  assert.match(explanationHtml(fn, false), /href="command:tsStructure\.explainCode\.video"[^>]*>.*Generate video/);
  const lines = await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };'));
  assert.doesNotMatch(explanationHtml(lines, false), /Generate video/);
  assert.match(explanationHtml(fn, false), /Nothing was sent anywhere/);
});
