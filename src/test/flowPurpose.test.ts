import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { Diagram, DiagramNode } from '../structure/diagram';
import { boxWords, diagramBoxes, FLOW_PURPOSES, isGroup, meaningMatches, modelPurpose, purposeIndex, rulePurpose, searchWords } from '../structure/flowPurpose';
import { CodeModel } from '../reel/codeModel';
import { CODE_MODEL } from '../reel/codeModelText';

const root = path.resolve(__dirname, '../..');
const modelDir = path.join(root, 'assets', 'code-model');
const runnable = CODE_MODEL.files.every((f) => fs.existsSync(path.join(modelDir, f.name))) && fs.existsSync(path.join(root, 'dist', 'codeModelWorker.js'));

const box = (label: string, description?: string, children: DiagramNode[] = []): DiagramNode => ({ label, description, collapsed: false, children });
// The pw chart: where it comes from, and where it goes.
const diagram: Diagram = {
  title: 'Data flow: pw',
  center: box('pw'),
  left: [box("= createRequire(path.join(resourcesRoot(), 'server/package.json'))", 'line 17 · chromiumInstalled', [box("returned by createRequire(path.join(resourcesRoot(), 'server'))")])],
  right: [
    box('→ fs.existsSync(…)', 'line 18 · chromiumInstalled'),
    box('chromiumInstalled', 'browsers.ts · 1 read', [box('read: pw.chromium', 'line 18')]),
    box('→ fs.writeFileSync(lockFile, JSON.stringify(state))', 'line 30 · saveState'),
    box('→ logger.info(`using ${pw.version}`)', 'line 22'),
    box('→ apiCall(origin, `/browsers`, pw)', 'line 40 · sync'),
    box('→ launchBrowser(pw.chromium.executablePath())', 'line 25 · start'),
  ],
};

test('Data flow purposes: boxes keyed as the page keys them, line numbers left out of what is read', () => {
  const boxes = diagramBoxes(diagram);
  assert.equal(boxes[0].key, "in/= createRequire(path.join(resourcesRoot(), 'server/package.json'))");
  assert.equal(boxes[1].key, `${boxes[0].key}/returned by createRequire(path.join(resourcesRoot(), 'server'))`);
  assert.ok(boxes.some((b) => b.key === 'out/chromiumInstalled/read: pw.chromium'));
  assert.equal(boxes.find((b) => b.key === 'out/→ fs.existsSync(…)')!.text, '→ fs.existsSync(…) · chromiumInstalled');
  assert.equal(boxes.length, 9);
});

test('Data flow purposes: known code gets its tag by rule', () => {
  const tag = (text: string) => rulePurpose(text)?.label;
  assert.equal(tag('→ fs.existsSync(…)'), 'Checks disk');
  assert.equal(tag("= createRequire(path.join(resourcesRoot(), 'server'))"), 'Module');
  assert.equal(tag('→ fs.writeFileSync(lockFile, data)'), 'File');
  assert.equal(tag('→ logger.info(`x`)'), 'Logged');
  assert.equal(tag("→ fetch('/api/orders')"), 'Network');
  assert.equal(tag('process.env.HOME'), 'Config');
  assert.equal(tag('chromiumInstalled'), undefined);
  assert.equal(rulePurpose('→ fs.existsSync(p)')?.by, 'rules');
  assert.equal(boxWords('→ launchBrowser(pw.chromium.executablePath())'), 'launch browser pw chromium executable path');
});

test('Data flow purposes: the code model tags what the rules cannot, and finds boxes by meaning', { skip: !runnable && 'needs assets/code-model and the bundle', timeout: 120000 }, async () => {
  const model = new CodeModel(modelDir, path.join(root, 'dist', 'codeModelWorker.js'), path.join(root, 'dist', 'kitten', 'ort'));
  try {
    const boxes = diagramBoxes(diagram);
    const meanings = await model.embed(FLOW_PURPOSES.map((k) => k.meaning));
    const vectors = await model.embed(boxes.map((b) => boxWords(b.node.label)));
    const purposes = boxes.map((b, i) => rulePurpose(b.text) ?? (isGroup(b.node) ? undefined : modelPurpose(vectors[i], meanings, boxWords(b.node.label))));
    const tagged = Object.fromEntries(boxes.map((b, i) => [b.key, purposes[i]]));
    // Project helpers the rules do not know: the model reads them as running a program and calling a server.
    assert.equal(tagged['out/→ launchBrowser(pw.chromium.executablePath())']?.label, 'Process', JSON.stringify(tagged));
    assert.deepEqual(tagged['out/→ apiCall(origin, `/browsers`, pw)'], { label: 'Network', icon: 'cloud', by: 'rules' });
    // A plain read says nothing about what for: no tag rather than a guess.
    assert.equal(tagged['out/chromiumInstalled/read: pw.chromium'], undefined);
    // The chart's own words ("read:") are not code: arithmetic read from the value is not reading a file.
    assert.equal(boxWords('read: amount * (1 + rate) · applyTax'), 'amount rate apply tax');
    const [arithmetic] = await model.embed([boxWords('read: amount * (1 + rate) · applyTax')]);
    assert.equal(modelPurpose(arithmetic, meanings), undefined);
    const searchable = await model.embed(boxes.map((b, i) => searchWords(b.text, purposes[i])));
    const index = boxes.map((b, i) => ({ key: b.key, vector: searchable[i], purpose: purposeIndex(purposes[i]) }));
    const find = async (query: string) => meaningMatches((await model.embed([query]))[0], index, meanings);
    assert.equal((await find('where is it saved'))[0], 'out/→ fs.writeFileSync(lockFile, JSON.stringify(state))');
    assert.equal((await find('sent to the server'))[0], 'out/→ apiCall(origin, `/browsers`, pw)');
    assert.equal((await find('where is it logged'))[0], 'out/→ logger.info(`using ${pw.version}`)');
    // Both module loads, and only they.
    assert.deepEqual((await find('loaded from a module')).sort(), [boxes[0].key, boxes[1].key].sort());
    // Words that only look alike, or nothing close: nothing found by meaning.
    assert.deepEqual(await find('quantum chromodynamics lattice'), []);
    assert.deepEqual(await find('pizza recipe'), []);
  } finally {
    model.dispose();
  }
});
