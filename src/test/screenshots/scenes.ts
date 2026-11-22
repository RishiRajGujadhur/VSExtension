import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import type { Cdp, Clip } from './cdp';
import type { Open } from './index';
import { features } from '../../structure/features';

export interface SceneContext {
  open: Open;
  cdp: Cdp;
  delay: (ms: number) => Promise<void>;
}

export interface Scene {
  /** The image name in docs/images. */
  name: string;
  run(context: SceneContext): Promise<void>;
  cleanup?(): Promise<void>;
  /** How long to wait before the capture, in milliseconds. */
  settle?: number;
  /** Only the walkthrough picture is wanted, not a GIF for the README. */
  still?: boolean;
  /** The part of the window shown in the Getting Started walkthrough, saved to media/walkthrough. */
  walkthrough?: Clip;
}

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const uri = (file: string) => vscode.Uri.file(path.join(root(), file));
const settings = () => vscode.workspace.getConfiguration('tsStructure');

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { contributes: { commands: { command: string; title: string }[] } };

/**
 * Types the command's title into the Command Palette, as a viewer of the GIF would, and closes it;
 * the scene then runs the command (with its arguments) itself.
 */
async function typeCommand(command: string, delay: SceneContext['delay']): Promise<void> {
  const title = manifest.contributes.commands.find((c) => c.command === command)?.title ?? command;
  // Starting from the category, so the list holds only this extension's commands while the name is typed.
  const prefix = '>Code X-Ray: ';
  for (let n = 0; n < title.length; n += 2) {
    await vscode.commands.executeCommand('workbench.action.quickOpen', prefix + title.slice(0, n));
    await delay(40);
  }
  await vscode.commands.executeCommand('workbench.action.quickOpen', prefix + title);
  await delay(900);
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await delay(150);
}

/** Types the command into the Command Palette, then runs it with its arguments. */
async function runTyped(command: string, delay: SceneContext['delay'], ...args: unknown[]): Promise<unknown> {
  await typeCommand(command, delay);
  return vscode.commands.executeCommand(command, ...args);
}

/** A scene that runs an analysis command at the cursor and shows its report. */
function analysis(name: string, file: string, needle: string, command: string, ...args: unknown[]): Scene {
  return {
    name,
    async run({ open, delay }) {
      await open(file, needle);
      await delay(700);
      await runTyped(command, delay, ...args);
    },
  };
}

/** Waits until the file has diagnostics from this extension. */
async function diagnostics(file: string, delay: SceneContext['delay']): Promise<void> {
  for (let i = 0; i < 100 && !vscode.languages.getDiagnostics(uri(file)).some((d) => d.source === 'X-Ray'); i++) {
    await delay(100);
  }
}

/** A scene that shows an inspection's squiggles, its hover at the needle and the Problems panel. */
function inspection(name: string, file: string, needle: string): Scene {
  return {
    name,
    async run({ open, delay }) {
      await open(file, needle);
      await diagnostics(file, delay);
      // The squiggle and its hover first, then every finding listed by Inspect Code.
      await delay(300);
      await vscode.commands.executeCommand('editor.action.showHover');
      await delay(2000);
      await runTyped('tsStructure.inspectCode', delay, 'file');
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      await open(file, needle);
      await delay(300);
      await vscode.commands.executeCommand('editor.action.showHover');
    },
    settle: 1500,
  };
}


/** Presses a key in the window as a person would, with Ctrl, Alt and Shift as asked (real key events, not a command). */
async function press(cdp: Cdp, key: string, code: string, keyCode: number, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): Promise<void> {
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}


export const scenes: Scene[] = [
  // Getting started
  {
    name: 'actions-at-cursor',
    walkthrough: { x: 420, y: 30, width: 602, height: 390 },
    async run({ open, delay }) {
      await open('src/pricing.ts', 'applyCoupon(amount');
      await delay(700);
      await typeCommand('tsStructure.actionsAtCursor', delay);
      void vscode.commands.executeCommand('tsStructure.actionsAtCursor');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    },
  },
  {
    name: 'context-menu',
    async run({ open, delay }) {
      await open('src/pricing.ts', 'calculateSubtotal(items');
      await delay(900);
      void vscode.commands.executeCommand('editor.action.showContextMenu');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.commands.executeCommand('editor.action.hideContextMenu').then(undefined, () => undefined);
    },
    settle: 2000,
  },
  {
    name: 'shortcuts',
    async run({ open, delay }) {
      await open('src/cart.ts', 'addToCart(');
      await delay(700);
      void vscode.commands.executeCommand('tsStructure.shortcutSheet');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    },
    settle: 2000,
  },
  // Understand code
  { ...analysis('data-flow', 'src/orders.ts', 'payment: PaymentMethod, coupon', 'tsStructure.dataFlow'), settle: 3000 },
  { ...analysis('flowchart', 'src/pricing.ts', 'applyCoupon(amount', 'tsStructure.controlFlow'), settle: 3000 },
  analysis('design-patterns', 'src/cart.ts', 'addToCart(', 'tsStructure.detectPatterns', 'project'),
  { ...analysis('semantic-usages', 'src/pricing.ts', 'calculateSubtotal(items', 'tsStructure.semanticUsages'), walkthrough: { x: 48, y: 30, width: 860, height: 330 } },
  analysis('nullability', 'src/pricing.ts', 'coupon = findCoupon', 'tsStructure.nullability'),
  analysis('mutation-tracking', 'src/cart.ts', 'addToCart(', 'tsStructure.mutationTracking'),
  {
    name: 'side-effects',
    async run({ open, delay }) {
      await settings().update('codeLens.sideEffects', true, vscode.ConfigurationTarget.Global);
      await open('src/cart.ts', 'addToCart(');
      await delay(1500);
      await runTyped('tsStructure.sideEffects', delay);
    },
    async cleanup() {
      await settings().update('codeLens.sideEffects', undefined, vscode.ConfigurationTarget.Global);
    },
    settle: 3000,
  },
  {
    name: 'test-impact',
    walkthrough: { x: 420, y: 30, width: 602, height: 280 },
    async run({ open, delay }) {
      await open('src/pricing.ts', 'calculateSubtotal(items');
      await delay(700);
      await typeCommand('tsImpact.analyze', delay);
      void vscode.commands.executeCommand('tsImpact.analyze', 'symbol');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    },
    settle: 3000,
  },
  {
    name: 'graph-diff',
    async run({ open, delay }) {
      // Since the last commit: analytics.ts now imports cart.ts (a new cycle) and orders.ts stops using notifications.ts.
      const analytics = path.join(root(), 'src/analytics.ts');
      fs.writeFileSync(analytics, `import { cartFor } from './cart';\n${fs.readFileSync(analytics, 'utf8')}\nexport const cartSize = (id: string) => cartFor(id).length;\n`);
      const orders = path.join(root(), 'src/orders.ts');
      fs.writeFileSync(
        orders,
        fs
          .readFileSync(orders, 'utf8')
          .replace("import { notifyCustomer } from './notifications';\n", '')
          .replace(/  notifyCustomer\(.*\n/, ''),
      );
      await open('src/analytics.ts', 'cartFor');
      await delay(700);
      await runTyped('tsStructure.dependencyGraphDiff', delay, 'HEAD');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      execFileSync('git', ['checkout', '--', '.'], { cwd: root() });
    },
  },
  // Refactor and find problems
  {
    name: 'change-signature',
    walkthrough: { x: 984, y: 30, width: 456, height: 440 },
    async run({ open, delay }) {
      await open('src/pricing.ts', 'applyCoupon(amount');
      await delay(700);
      await typeCommand('tsStructure.changeSignature', delay);
      void vscode.commands.executeCommand('tsStructure.changeSignature');
    },
    settle: 3000,
  },
  { ...inspection('missing-await', 'src/orders.ts', 'placeOrder(id, items, payment);\n}\n\nexport function onCheckoutClick'), walkthrough: { x: 532, y: 60, width: 908, height: 560 } },
  analysis('dead-exports', 'src/legacy.ts', 'oldDiscount', 'tsStructure.deadExports', 'project'),
  {
    name: 'structural-search',
    async run({ open, delay }) {
      await open('src/cart.ts', 'items.find');
      await runTyped('tsStructure.structuralSearch', delay, {
        pattern: '$list$.find($callback$)',
        constraints: [{ name: 'list', type: '^LineItem\\[\\]$' }],
        run: true,
      });
    },
    settle: 2500,
  },
  // Results and settings. Pickers wait for an answer, so they are opened without awaiting them.
  {
    name: 'limit-results',
    async run({ open, delay }) {
      await open('src/cart.ts', 'calculateSubtotal(items);');
      await runTyped('tsStructure.semanticUsages', delay);
      // Every usage first, then only those in this file.
      await delay(2500);
      await runTyped('tsStructure.report.limitScope', delay, 'file');
    },
  },
  {
    name: 'choose-features',
    walkthrough: { x: 420, y: 30, width: 602, height: 390 },
    async run({ open, delay }) {
      // As a new user sees it: the optional features off.
      for (const feature of features.filter((f) => !f.core)) {
        await vscode.workspace.getConfiguration('tsStructure.features').update(feature.id, false, vscode.ConfigurationTarget.Workspace);
      }
      await open('src/cart.ts', 'addToCart(');
      await typeCommand('tsStructure.configureFeatures', delay);
      void vscode.commands.executeCommand('tsStructure.configureFeatures');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      for (const feature of features) {
        await vscode.workspace.getConfiguration('tsStructure.features').update(feature.id, undefined, vscode.ConfigurationTarget.Workspace);
      }
    },
  },
  {
    name: 'analysis-scope',
    still: true,
    walkthrough: { x: 420, y: 30, width: 602, height: 232 },
    async run({ open, delay }) {
      await settings().update('exclude', ['**/generated/**', 'src/legacy.ts'], vscode.ConfigurationTarget.Workspace);
      await settings().update('include', ['src'], vscode.ConfigurationTarget.Workspace);
      await open('src/cart.ts', 'addToCart(');
      await typeCommand('tsStructure.editAnalysisScope', delay);
      void vscode.commands.executeCommand('tsStructure.editAnalysisScope');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await settings().update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      await settings().update('include', undefined, vscode.ConfigurationTarget.Workspace);
    },
  },
  // C#: what a person does in a C# file, with real key presses.
  {
    // Git reel: applyCoupon and shipping edited, then the reel of the changes since the last commit, playing.
    name: 'git-reel',
    async run({ open, delay, cdp }) {
      await open('src/pricing.ts', 'const coupon = findCoupon');
      const editor = vscode.window.activeTextEditor!;
      const text = editor.document.getText();
      const at = (s: string) => editor.document.positionAt(text.indexOf(s));
      await editor.edit((b) => {
        b.insert(at('  const coupon = findCoupon'), '  if (amount <= 0) {\n    return 0;\n  }\n');
        b.replace(new vscode.Range(at('return amount * (1 - coupon'), at('return amount * (1 - coupon').translate(0, 'return amount * (1 - coupon.percentOff / 100);'.length)), 'return Math.round(amount * (100 - coupon.percentOff)) / 100;');
      });
      await editor.document.save();
      await delay(400);
      await vscode.commands.executeCommand('tsStructure.gitReel', 'HEAD');
      await delay(1500);
      await vscode.commands.executeCommand('tsStructure.gitReel.focus');
      await delay(300);
      // Seek to the applyCoupon scene's flowchart, by pressing → in the player.
      for (let i = 0; i < 8; i++) {
        await press(cdp, 'ArrowRight', 'ArrowRight', 39);
        await delay(60);
      }
      await press(cdp, ' ', 'Space', 32);
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      execFileSync('git', ['checkout', '--', '.'], { cwd: root() });
    },
    settle: 3500,
  },
  {
    // Not for the docs: full screen in VS Code (the F key, a real key press), to see which way it goes.
    name: 'git-reel-fullscreen-check',
    still: true,
    async run({ open, delay, cdp }) {
      await open('src/pricing.ts', 'const coupon = findCoupon');
      const editor = vscode.window.activeTextEditor!;
      const text = editor.document.getText();
      await editor.edit((b) => b.insert(editor.document.positionAt(text.indexOf('  const coupon = findCoupon')), '  if (amount <= 0) {\n    return 0;\n  }\n'));
      await editor.document.save();
      await vscode.commands.executeCommand('tsStructure.gitReel', 'HEAD');
      await delay(2000);
      await press(cdp, 'f', 'KeyF', 70);
      await delay(1500);
      // Saved for checking: the reel fills the editor area, and VS Code's own window is unchanged.
      await cdp.capture(path.join(require('os').tmpdir(), 'git-reel-fullscreen-check.png'));
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      execFileSync('git', ['checkout', '--', '.'], { cwd: root() });
    },
    settle: 800,
  },
  {
    // Not for the docs: the voice-over end to end. The reel with the voice on, exported with the E key (a real key
    // press, so the page may start its sound), written to the temp folder for checking.
    name: 'git-reel-voice-check',
    still: true,
    async run({ open, delay, cdp }) {
      await open('src/pricing.ts', 'const coupon = findCoupon');
      const editor = vscode.window.activeTextEditor!;
      const text = editor.document.getText();
      await editor.edit((b) => b.insert(editor.document.positionAt(text.indexOf('  const coupon = findCoupon')), '  if (amount <= 0) {\n    return 0;\n  }\n'));
      await editor.document.save();
      await vscode.commands.executeCommand('tsStructure.gitReel', 'HEAD');
      await delay(1500);
      await vscode.commands.executeCommand('tsStructure.gitReel.voice', true);
      await delay(1500);
      // The "Generating narration…" notice may have taken the focus: back to the reel before the key press.
      await vscode.commands.executeCommand('tsStructure.gitReel.focus');
      await delay(800);
      const done = vscode.commands.executeCommand<number>('tsStructure.gitReel.expectExport', path.join(require('os').tmpdir(), 'reel-voice-e2e.webm'));
      await press(cdp, 'e', 'KeyE', 69);
      const size = await Promise.race([done, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 120_000))]);
      const sound = await vscode.commands.executeCommand('tsStructure.gitReel.lastSound');
      fs.writeFileSync(path.join(require('os').tmpdir(), 'reel-voice-e2e.txt'), `size ${size} ${JSON.stringify(sound)}`);
    },
    async cleanup() {
      await vscode.commands.executeCommand('tsStructure.gitReel.voice', false);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      execFileSync('git', ['checkout', '--', '.'], { cwd: root() });
    },
    settle: 500,
  },
  {
    // Highlighted code: the Actions view shows only the actions that work with it. A name first, then code.
    name: 'actions-for-selection',
    async run({ open, delay }) {
      await open('src/pricing.ts', 'const coupon = findCoupon');
      await vscode.commands.executeCommand('tsStructure.actions.focus');
      await delay(1200);
      const editor = vscode.window.activeTextEditor!;
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      const text = editor.document.getText();
      const range = (from: string, to: string) => {
        const start = text.indexOf(from);
        return new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(text.indexOf(to, start) + to.length));
      };
      editor.selection = range('coupon = findCoupon', 'coupon');
      await delay(1800);
      editor.selection = range('const coupon = findCoupon', 'return amount;\n  }');
    },
    cleanup: () => Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')).then(() => undefined),
    settle: 1800,
  },
  {
    // Explain this code: the name placeOrder highlighted, explained as the whole function with what it takes, gives
    // back and changes.
    name: 'explain-code',
    async run({ open, delay }) {
      await open('src/orders.ts', 'placeOrder(id: string');
      const editor = vscode.window.activeTextEditor!;
      const at = editor.document.getText().indexOf('placeOrder(id: string');
      editor.selection = new vscode.Selection(editor.document.positionAt(at), editor.document.positionAt(at + 'placeOrder'.length));
      await delay(900);
      await runTyped('tsStructure.explainCode', delay);
    },
    cleanup: () => Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')).then(() => undefined),
    settle: 2500,
  },
  {
    // The explanation as a video: its steps on the function's flowchart, one by one, in the reel's player.
    name: 'explain-video',
    async run({ open, delay, cdp }) {
      await settings().update('reel.narrationVoice', 'Off', vscode.ConfigurationTarget.Global);
      await open('src/orders.ts', 'placeOrder(id: string');
      const editor = vscode.window.activeTextEditor!;
      const at = editor.document.getText().indexOf('placeOrder(id: string');
      editor.selection = new vscode.Selection(editor.document.positionAt(at), editor.document.positionAt(at + 'placeOrder'.length));
      await vscode.commands.executeCommand('tsStructure.explainCode');
      await delay(800);
      await vscode.commands.executeCommand('tsStructure.explainCode.video');
      await delay(1500);
      // Full screen in the editor area, then on to the steps on the flowchart, playing.
      await vscode.commands.executeCommand('tsStructure.gitReel.fullscreen');
      await delay(600);
      await vscode.commands.executeCommand('tsStructure.gitReel.focus');
      await delay(300);
      // Past the title card (Shift+→ is 5 seconds), to the steps on the flowchart.
      for (let i = 0; i < 3; i++) {
        await press(cdp, 'ArrowRight', 'ArrowRight', 39, { shift: true });
        await delay(80);
      }
      await press(cdp, ' ', 'Space', 32);
    },
    async cleanup() {
      if (await vscode.commands.executeCommand<boolean>('tsStructure.gitReel.fullscreen')) await vscode.commands.executeCommand('tsStructure.gitReel.fullscreen');
      await settings().update('reel.narrationVoice', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
    settle: 6000,
  },
  {
    // The code model in a chart: a pill on each box for what it is for, then Find by meaning.
    name: 'chart-code-model',
    async run({ open, delay, cdp }) {
      await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', true, vscode.ConfigurationTarget.Global);
      const file = path.join(root(), 'src', 'cartStore.ts');
      fs.writeFileSync(file, [
        "import * as fs from 'fs';",
        'declare function postJson(url: string, body: string): Promise<void>;',
        '',
        'export async function saveCart(items: string[], origin: string) {',
        '  const cart = JSON.stringify({ items, at: Date.now() });',
        "  fs.writeFileSync('cart.json', cart);",
        "  await postJson(origin + '/carts', cart);",
        '  console.log(`saved ${cart.length} bytes`);',
        '  return cart;',
        '}',
        '',
      ].join('\n'));
      await open('src/cartStore.ts', 'cart = JSON');
      await delay(600);
      await vscode.commands.executeCommand('tsStructure.dataFlowDiagram');
      await delay(3500);
      // The words typed into the chart's Find box, a letter at a time.
      const query = 'where is it saved';
      for (let n = 1; n <= query.length; n++) {
        await vscode.commands.executeCommand('tsStructure.diagram.typeFind', query.slice(0, n));
        await delay(55);
      }
    },
    async cleanup() {
      await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(root(), 'src', 'cartStore.ts'), { force: true });
    },
    settle: 2500,
  },
  {
    // A Data flow chart: where payment comes from and where it goes.
    name: 'data-flow-chart',
    async run({ open, delay }) {
      await open('src/orders.ts', 'payment: PaymentMethod, coupon');
      await delay(700);
      await runTyped('tsStructure.dataFlowDiagram', delay);
    },
    cleanup: () => Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')).then(() => undefined),
    settle: 3500,
  },
  {
    // Not for the docs: a Data flow chart with the code model on (boxes tagged by what they are for, and Find by
    // meaning), saved to the temp folder for checking.
    name: 'data-flow-code-model-check',
    still: true,
    async run({ open, delay, cdp }) {
      await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', true, vscode.ConfigurationTarget.Global);
      // A value that goes to disk, the network, the log and a helper of its own.
      const file = path.join(root(), 'src', 'cartStore.ts');
      fs.writeFileSync(file, [
        "import * as fs from 'fs';",
        'declare function apiCall(origin: string, path: string, body: unknown): Promise<void>;',
        'declare function launchBrowser(path: string): void;',
        'export async function saveCart(items: string[], origin: string) {',
        '  const cart = JSON.stringify({ items, at: Date.now() });',
        "  fs.writeFileSync('cart.json', cart);",
        "  await apiCall(origin, '/carts', cart);",
        '  console.log(`saved ${cart.length} bytes`);',
        '  launchBrowser(cart);',
        '}',
        '',
      ].join('\n'));
      await open('src/cartStore.ts', 'cart = JSON');
      await vscode.commands.executeCommand('tsStructure.dataFlowDiagram');
      await delay(4000);
      const found = { saved: await vscode.commands.executeCommand<string[]>('tsStructure.diagram.findByMeaning', 'where is it saved'), server: await vscode.commands.executeCommand<string[]>('tsStructure.diagram.findByMeaning', 'sent to the server') };
      const info = await vscode.commands.executeCommand<{ purposes: Record<string, { label: string; by: string }> }>('tsStructure.diagram.meaningInfo');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tmp = require('os').tmpdir();
      fs.writeFileSync(path.join(tmp, 'data-flow-code-model-check.json'), JSON.stringify({ purposes: info?.purposes, found }, null, 2));
      await cdp.capture(path.join(tmp, 'data-flow-code-model-check.png'));
    },
    async cleanup() {
      await vscode.workspace.getConfiguration().update('tsStructure.charts.codeModel', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(root(), 'src', 'cartStore.ts'), { force: true });
    },
    settle: 500,
  },
  {
    // Flowchart vs last commit: applyCoupon edited (a new guard, a changed return), then compared with the commit.
    name: 'flowchart-vs-commit',
    async run({ open, delay, cdp }) {
      await open('src/pricing.ts', 'const coupon = findCoupon');
      const editor = vscode.window.activeTextEditor!;
      const text = editor.document.getText();
      const at = (s: string) => editor.document.positionAt(text.indexOf(s));
      await editor.edit((b) => {
        b.insert(at('  const coupon = findCoupon'), '  if (amount <= 0) {\n    return 0;\n  }\n');
        b.replace(new vscode.Range(at('return amount * (1 - coupon'), at('return amount * (1 - coupon').translate(0, 'return amount * (1 - coupon.percentOff / 100);'.length)), 'return Math.round(amount * (100 - coupon.percentOff)) / 100;');
      });
      await delay(900);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, '!', 'Digit1', 49, { shift: true });
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
    settle: 4000,
  },
  {
    name: 'csharp-flowchart',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'var amount = cart.Price()');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, '1', 'Digit1', 49);
    },
    settle: 5000,
  },
  {
    name: 'csharp-usages',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'attempts++');
      await delay(1500);
      await press(cdp, 'F7', 'F7', 118, { alt: true });
    },
    settle: 4000,
  },
  {
    name: 'csharp-dataflow',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'amount *= 0.9m');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, 'd', 'KeyD', 68);
    },
    settle: 3000,
  },
  {
    name: 'csharp-actions',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'var amount = cart.Price()');
      await delay(1500);
      await press(cdp, 't', 'KeyT', 84, { ctrl: true, alt: true, shift: true });
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    },
    settle: 2500,
  },
  {
    name: 'csharp-chart-dataflow',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'amount *= 0.9m');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, '8', 'Digit8', 56);
    },
    settle: 5000,
  },
  {
    name: 'csharp-chart-errors',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'var amount = cart.Price()');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, 'x', 'KeyX', 88);
      await delay(3000);
      await vscode.commands.executeCommand('tsStructure.report.showDiagram');
    },
    settle: 4000,
  },
  {
    name: 'csharp-chart-callers',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'var amount = cart.Price()');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, 'C', 'KeyC', 67, { shift: true });
    },
    settle: 5000,
  },
  {
    name: 'csharp-chart-family',
    async run({ open, delay, cdp }) {
      await open('csharp/OrderService.cs', 'class Cart : IPriced');
      await delay(1500);
      await press(cdp, 's', 'KeyS', 83, { ctrl: true, alt: true });
      await delay(150);
      await press(cdp, 'h', 'KeyH', 72);
      await delay(3000);
      await vscode.commands.executeCommand('tsStructure.report.showDiagram');
    },
    settle: 4000,
  },
  {
    name: 'csharp-inspections',
    async run({ open, delay }) {
      await open('csharp/OrderService.cs', 'throw ex;');
      await delay(2500);
      await vscode.commands.executeCommand('editor.action.showHover');
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    },
    settle: 3000,
  },
];
