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
];
