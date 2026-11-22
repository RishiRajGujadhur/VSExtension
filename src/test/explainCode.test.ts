import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { explainCode } from '../explain/explainCode';
import { CodeModel } from '../reel/codeModel';
import { CODE_MODEL, MODEL_RUNTIME, downloadDisclosure } from '../reel/codeModelText';
import { downloadPrivacy } from '../reel/downloadPrivacy';
import { VOICE_MODELS } from '../reel/voiceModels';
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
  const said = downloadDisclosure('C:/storage/code-model');
  assert.match(said, /huggingface\.co/);
  assert.match(said, /IP address/);
  assert.match(said, /model_quantized\.onnx and vocab\.txt/);
  // Every part of how the data is used, at the download step.
  for (const part of ['WHAT IS SENT', 'WHAT IS NEVER SENT', 'HOW HUGGING FACE MAY USE IT', 'ON YOUR COMPUTER', 'WHEN IT RUNS', 'TO REMOVE IT']) assert.match(said, new RegExp(part));
  assert.match(said, /Your code, file names or paths/);
  assert.match(said, /"code-x-ray"/);
  assert.match(said, /huggingface\.co\/privacy/);
  assert.match(said, /C:\/storage\/code-model/);
  assert.match(said, /at version 751bff3/);
  assert.match(said, /no usage data or telemetry/);
});

test('Model downloads: the notice says what a voice model keeps on disk, and is true to the downloader', () => {
  const said = downloadPrivacy(VOICE_MODELS[0], { reads: 'the captions', gives: 'the sound of each caption', keeps: 'the spoken clips, as WAV files in X', folder: 'Y', remove: 'run "Git reel: remove downloaded voice models"' });
  assert.match(said, /It keeps the spoken clips, as WAV files in X, and sends nothing\./);
  assert.match(said, /model\.onnx and voices\.npz/);
  // The downloader sends exactly the headers the notice names, and only to Hugging Face's hosts.
  const downloader = fs.readFileSync(path.join(root, 'src', 'reel', 'pinnedDownload.ts'), 'utf8');
  assert.match(downloader, /headers: \{ 'User-Agent': 'code-x-ray', Accept: '\*\/\*' \}/);
  // No cookie or credential header in the code itself (its comments say there are none).
  const code = downloader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/cookie|authorization/i.test(code));
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

test('Explain this code as a video: essential only, a scene per step on the flowchart, ending on the last step', async () => {
  const e = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  const plan = explanationReel(e, 'src/workspace.ts')!;
  assert.equal(plan.meta.title, 'What currentConfig() does');
  assert.equal(plan.meta.chip, 'workspace.ts');
  // The opening: the signature on the card, and what it is, no filler.
  assert.equal(plan.meta.signature, 'export async function currentConfig(): Promise<Config>');
  assert.equal(plan.scenes[0].caption, 'currentConfig is an async function that returns a Config, once it finishes.');
  assert.ok(plan.scenes.every((s) => !/walk through|step by step/i.test(s.caption)));
  const flows = plan.scenes.filter((s): s is Extract<ReelScene, { kind: 'flow' }> => s.kind === 'flow');
  const steps = flows;
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
  // No ending card: the last scene is the last step (and no frame says only the function's name).
  assert.equal(plan.scenes[plan.scenes.length - 1].id, `step-${steps.length}`);
  assert.ok(plan.scenes.every((sc) => !/^That's |^So w+ /.test(sc.caption)));
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

const BY = { version: '9.9.9', reader: 'the TypeScript 6.0.3 compiler' };
const BY_MODEL = { ...BY, model: { name: 'all-MiniLM-L6-v2 (int8, Xenova)', revision: '751bff37182d3f1213fa05d7196b954e230abad9', runtime: 'ONNX Runtime Web 1.24.3' } };

test('Explain this code: the page says exactly what explained it, behind an info button, with links', async () => {
  const fn = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  const plain = explanationHtml(fn, BY);
  assert.ok(plain.includes("Explained on your computer. Nothing was sent anywhere."), "Explained on your computer. Nothing was sent anywhere.");
  assert.ok(plain.includes("class=\"info\" tabindex=\"0\" role=\"button\" aria-label=\"How this was explained\""), "class=\"info\" tabindex=\"0\" role=\"button\" aria-label=\"How this was explained\"");
  assert.ok(plain.includes("Code X-Ray 9.9.9 rules</b> wrote every sentence, from what the TypeScript 6.0.3 compiler works out"), "Code X-Ray 9.9.9 rules</b> wrote every sentence, from what the TypeScript 6.0.3 compiler works out");
  assert.ok(plain.includes("Code model:</b> not used"), "Code model:</b> not used");
  assert.ok(plain.includes("href=\"https://github.com/RishiRajGujadhur/VSExtension/blob/main/docs/HOW_EXPLAINING_WORKS.md\""), "href=\"https://github.com/RishiRajGujadhur/VSExtension/blob/main/docs/HOW_EXPLAINING_WORKS.md\"");
  assert.ok(plain.includes("href=\"https://github.com/RishiRajGujadhur/VSExtension#privacy-and-size\""), "href=\"https://github.com/RishiRajGujadhur/VSExtension#privacy-and-size\"");
  const withModel = explanationHtml(fn, BY_MODEL);
  assert.ok(withModel.includes("with the code model. Nothing was sent anywhere"), "with the code model. Nothing was sent anywhere");
  assert.ok(withModel.includes("all-MiniLM-L6-v2 (int8, Xenova), version 751bff3, run by ONNX Runtime Web 1.24.3"), "all-MiniLM-L6-v2 (int8, Xenova), version 751bff3, run by ONNX Runtime Web 1.24.3");
  assert.ok(withModel.includes("the rules were enough here"), "the rules were enough here");
  // The video is an icon button, named on hover.
  assert.match(plain, /<a class="video"[^>]*title="Generate video"[^>]*><i class="codicon codicon-device-camera-video"[^>]*><\/i><\/a>/);
  // The runtime named matches the one installed.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  assert.equal(MODEL_RUNTIME, `ONNX Runtime Web ${pkg.devDependencies['onnxruntime-web']}`);
});

test('Explain this code: the facts fold to one line, and steps after the fifth fold away', async () => {
  const add = await explainCode('shop.ts', shop, shop.indexOf('add('), shop.indexOf('add(') + 3);
  const html = explanationHtml(add, BY);
  assert.ok(html.includes("<details class=\"facts-box\"><summary><span class=\"facts-line\">Takes <code>id</code>, <code>qty</code>, <code>tags</code> · gives back number · changes 2 things outside itself</span></summary>"), "<details class=\"facts-box\"><summary><span class=\"facts-line\">Takes <code>id</code>, <code>qty</code>, <code>tags</code> · gives back number · changes 2 things outside itself</span></summary>");
  const many = explanationHtml({ subject: 'the function f()', steps: ['It a b.', 'It c d.', 'It e f.', 'It g h.', 'It i j.', 'It k l.', 'It m n.'] }, BY);
  assert.match(many, /<ol class="steps">(<li>[^<]*<\/li>){5}<\/ol>/);
  assert.ok(many.includes("<details class=\"more\"><summary>Show 2 more steps</summary><ol class=\"steps\" start=\"6\">"), "<details class=\"more\"><summary>Show 2 more steps</summary><ol class=\"steps\" start=\"6\">");
});

test('Explain this code: the page offers the video only for a whole function, as a command link', async () => {
  const fn = await explainCode('workspace.ts', code, ...range('export async function currentConfig'));
  assert.match(explanationHtml(fn, BY), /href="command:tsStructure\.explainCode\.video" title="Generate video"/);
  const lines = await explainCode('workspace.ts', code, ...range('    const config = saved', 'fixtures\') };'));
  assert.doesNotMatch(explanationHtml(lines, BY), /Generate video/);
  assert.match(explanationHtml(fn, BY), /Nothing was sent anywhere/);
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

const shop = `const cache = new Map<string, number>();
let calls = 0;

export class Cart {
  items: string[] = [];
  add(id: string, qty = 1, ...tags: string[]): number {
    this.items.push(id);
    calls++;
    return this.items.length;
  }
}

export async function priceOf(id: string, { currency }: { currency?: string } = {}): Promise<number | undefined> {
  if (!id) return;
  const known = cache.get(id);
  if (known !== undefined) return known;
  console.log('pricing', id, currency);
  return undefined;
}

function checkout(cart: Cart) {
  const total = priceOf(cart.items[0]);
  cart.add('fee');
  return total;
}
`;

test('Explain this code: a function name highlighted, where declared or where called, explains the whole function', async () => {
  const at = (needle: string, from = 0) => shop.indexOf(needle, from);
  // Its own name, behind export async.
  const declared = await explainCode('shop.ts', shop, at('priceOf'), at('priceOf') + 'priceOf'.length);
  assert.equal(declared.subject, 'the function priceOf()');
  assert.ok(declared.walk);
  // A call to it, inside another function.
  const call = at('priceOf(cart');
  const called = await explainCode('shop.ts', shop, call, call + 'priceOf'.length);
  assert.equal(called.subject, 'the function priceOf()');
  // A method called on an object.
  const method = at('add(', at('checkout'));
  const added = await explainCode('shop.ts', shop, method, method + 3);
  assert.equal(added.subject, 'the function add()');
  // A parameter in the header: the function too.
  const param = at('qty');
  assert.equal((await explainCode('shop.ts', shop, param, param + 3)).subject, 'the function add()');
  // A plain variable in a body is not a function: those lines.
  const total = at('total =');
  assert.match((await explainCode('shop.ts', shop, total, total + 5)).subject, /highlighted lines in checkout/);
});

test('Explain this code: what a function takes, what it gives back and what it changes outside itself', async () => {
  const add = await explainCode('shop.ts', shop, shop.indexOf('add('), shop.indexOf('add(') + 3);
  const facts = add.facts!;
  assert.deepEqual(facts.inputs.map((i) => [i.name, i.type, i.defaultValue, i.optional, i.rest]), [
    ['id', 'string', undefined, false, false],
    ['qty', undefined, '1', true, false],
    ['tags', 'string[]', undefined, false, true],
  ]);
  assert.deepEqual(facts.output, { type: 'number', later: false, values: ['this.items.length'], nothing: false });
  assert.ok(facts.effects.some((e) => /this\.items/.test(e)), facts.effects.join(' | '));
  assert.ok(facts.effects.some((e) => /calls/.test(e)), facts.effects.join(' | '));

  const price = await explainCode('shop.ts', shop, shop.indexOf('priceOf'), shop.indexOf('priceOf') + 7);
  assert.equal(price.facts!.inputs[1].name, '{ currency }');
  assert.equal(price.facts!.output.type, 'number | undefined');
  assert.equal(price.facts!.output.later, true);
  assert.deepEqual(price.facts!.output.values, ['known', 'undefined']);
  assert.ok(price.facts!.effects.some((e) => /console/i.test(e)), price.facts!.effects.join(' | '));

  const html = explanationHtml(add, BY);
  assert.match(html, /Takes/);
  assert.match(html, /Gives back a? ?number|Gives back number/);
  assert.match(html, /Changes outside itself/);
  assert.match(html, /any number of them/);
  // The name and type each appear once in a parameter's row.
  const row = /<li><code>id<\/code>.*?<\/li>/.exec(html)![0];
  assert.equal(row.match(/string/g)?.length, 1);

  const lines = await explainCode('shop.ts', shop, shop.indexOf('const total'), shop.indexOf('cart.add'));
  assert.equal(lines.facts, undefined);
});

test('Explain this code: calls made only for what they do are named as possible changes', async () => {
  const code = `declare function saveOrder(id: string): Promise<void>;
declare function notify(id: string): void;
declare const pay: { charge(n: number): Promise<number> };
export async function placeOrder(id: string, total: number) {
  const receipt = await pay.charge(total);
  await saveOrder(id);
  notify(id);
  return receipt;
}
`;
  const at = code.indexOf('placeOrder');
  const e = await explainCode('orders.ts', code, at, at + 'placeOrder'.length);
  assert.deepEqual(e.facts!.effects, ['calls pay.charge(), a property holding any function', 'calls saveOrder() and notify() for what they do, which may change things']);
});

test('Explain this code: verbs made from words, particles, event listeners and flags read naturally', async () => {
  const { callPhrase, conditionWords } = await import('../reel/words');
  assert.equal(callPhrase('win.maximize()'), 'maximizes the win');
  assert.equal(callPhrase('lockDown()'), 'locks down');
  assert.equal(callPhrase('setUpServer()'), 'sets up the server');
  assert.equal(callPhrase('win.once("ready-to-show", () => win.show())'), 'acts once on the ready to show event');
  assert.equal(callPhrase('win.on("closed", () => {})'), 'listens for the closed event');
  assert.equal(conditionWords('bounds.maximized'), 'the bounds are maximized');
  assert.equal(conditionWords('!bounds.maximized'), 'the bounds are not maximized');
  assert.equal(conditionWords('user.hasAccess'), 'the user has access');
  // The name's own verb when the intent would say it with another one; the intent's wording otherwise.
  const create = 'export function createWindow() { const w = new BrowserWindow({}); windows.push(w); return w; }';
  assert.equal((await explainCode('a.ts', create, create.indexOf('createWindow'), create.indexOf('createWindow') + 12)).purpose?.text, 'Creates the window');
  const add = 'export function addToCart(item) { cart.items.push(item); }';
  assert.equal((await explainCode('a.ts', add, add.indexOf('addToCart'), add.indexOf('addToCart') + 9)).purpose?.text, 'Adds item to cart');
});
