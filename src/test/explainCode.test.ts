import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { explainCode } from '../explain/explainCode';
import { CodeModel } from '../reel/codeModel';
import { CODE_MODEL, downloadDisclosure } from '../reel/codeModelText';
import { boxIcon, explanationReel, stepKind, walkSteps } from '../explain/explainReel';
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

test('Explain this code as a video: essential only, a scene per step on the flowchart, then the whole path', async () => {
  const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  const plan = explanationReel(e, 'src/workspace.ts')!;
  assert.equal(plan.meta.title, 'What currentConfig() does');
  assert.equal(plan.meta.chip, 'workspace.ts');
  // The opening: the signature on the card, and what it is, no filler.
  assert.equal(plan.meta.signature, 'export async function currentConfig(): Promise<Config>');
  assert.equal(plan.scenes[0].caption, 'currentConfig is an async function that returns a Config, once it finishes.');
  assert.ok(plan.scenes.every((s) => !/walk through|step by step/i.test(s.caption)));
  const flows = plan.scenes.filter((s): s is Extract<ReelScene, { kind: 'flow' }> => s.kind === 'flow');
  const steps = flows.filter((s) => s.id !== 'finale');
  // Steps on the same box are one scene.
  assert.equal(steps[0].caption, "It asks the server for the workspace, and sets the context repository to the config's repository root.");
  assert.ok(steps.length < e.steps.length);
  assert.deepEqual(steps.map((s) => s.chapter), steps.map((_, i) => `Step ${i + 1}`));
  for (const [i, s] of steps.entries()) {
    assert.ok(s.flow.walk);
    assert.ok(s.flow.nodes.some((n) => n.state === 'changed'), `step ${i + 1} lights a box`);
    // Dots for how far the walk has come, the step's own code, and the step before to glide from.
    assert.deepEqual(s.progress, { index: i, total: steps.length });
    // The code strip only when it adds to what the boxes show (their first line): never the same line twice.
    const lit = s.flow.nodes.filter((n) => n.state === 'changed').map((n) => n.label);
    assert.ok(!s.code?.length || s.code.some((line) => !lit.includes(line)), `step ${i + 1} repeats its box: ${s.code}`);
    if (i) assert.ok(s.flow.from && s.flow.from.length, `step ${i + 1} glides from the step before`);
  }
  assert.match(steps[0].code!.join(' '), /apiCall/);
  // Labelled by kind: what happens when something fails is red.
  const failing = steps.find((s) => /^If something goes wrong/.test(s.caption))!;
  assert.deepEqual([failing.badge, failing.flow.tone], ['If it fails', 'error']);
  assert.equal(steps.find((s) => /returns the config\.$/.test(s.caption))?.badge, 'Returns');
  // The finale: every step lit, nothing current, the flow along all of it.
  const finale = flows[flows.length - 1];
  assert.equal(finale.id, 'finale');
  assert.ok(finale.flow.finale);
  assert.ok(!finale.flow.nodes.some((n) => n.state === 'changed'));
  assert.ok(finale.flow.nodes.some((n) => n.state === 'added'));
  // The lines know the boxes they join, so the player can send the flow along them.
  assert.ok(flows.every((s) => s.flow.edges.every((edge) => typeof edge.from === 'number' && typeof edge.to === 'number')));
  // Lines that are not a whole function have no flowchart to walk.
  assert.equal(explanationReel(await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };')), 'x.ts'), undefined);
});

test('Explain this code as a video: steps that say little are left out, and kinds read from the step', () => {
  const steps = walkSteps(['It uses the config.', 'It sets the name to the user name.', 'It returns the name.', 'Then it uses the abort.'], [[1], [2], [3], [4]]);
  assert.deepEqual(steps.map((s) => s.text), ['It sets the name to the user name.', 'It returns the name.']);
  // Three steps on one box: two in one scene, the third in its own.
  assert.equal(walkSteps(['It a b.', 'It c d.', 'It e f.'], [[1], [1], [1]]).length, 2);
  assert.deepEqual(stepKind('If the cart is empty, it returns 0.', ['decision', 'return']), { label: 'Decision', tone: 'decision' });
  assert.deepEqual(stepKind('It goes through each item in the items.', ['loop']), { label: 'Loop', tone: 'step' });
  assert.deepEqual(stepKind('It sets the name.', ['statement']), { label: 'Step', tone: 'step' });
});

test('Explain this code: the page offers the video only for a whole function, as a command link', async () => {
  const fn = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  assert.match(explanationHtml(fn, false), /href="command:tsStructure\.explainCode\.video"[^>]*>.*Generate video/);
  const lines = await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };'));
  assert.doesNotMatch(explanationHtml(lines, false), /Generate video/);
  assert.match(explanationHtml(fn, false), /Nothing was sent anywhere/);
});

test('Explain this code as a video: an icon on each box, by what its code does', async () => {
  assert.equal(boxIcon('decision', 'ctx.win'), 'question');
  assert.equal(boxIcon('loop', 'for (const x of xs)'), 'sync');
  assert.equal(boxIcon('catch', 'catch'), 'shield');
  assert.equal(boxIcon('statement', "const r = await apiCall(ctx.origin, '/workspace');"), 'cloud');
  assert.equal(boxIcon('statement', 'saved = JSON.parse(fs.readFileSync(file))'), 'file');
  assert.equal(boxIcon('statement', "localStorage.setItem('cart', data)"), 'database');
  assert.equal(boxIcon('statement', "notify('Local API is not responding')"), 'bell');
  assert.equal(boxIcon('statement', 'clearTimeout(timeout)'), 'watch');
  assert.equal(boxIcon('statement', 'request.abort()'), 'circle-slash');
  assert.equal(boxIcon('statement', 'const request = new AbortController()'), 'add');
  assert.equal(boxIcon('statement', 'state.apiDown = false'), 'edit');
  assert.equal(boxIcon('return', 'return config'), 'sign-out');
  assert.equal(boxIcon('start', 'poll'), undefined);
  const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  const plan = explanationReel(e, 'src/workspace.ts')!;
  const step = plan.scenes.find((s): s is Extract<ReelScene, { kind: 'flow' }> => s.kind === 'flow')!;
  assert.ok(step.flow.nodes.some((n) => n.icon === 'cloud'), 'the request box has its icon');
});
