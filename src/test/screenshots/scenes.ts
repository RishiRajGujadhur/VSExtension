import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import type { Cdp } from './cdp';
import type { Open } from './index';

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
}

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const uri = (file: string) => vscode.Uri.file(path.join(root(), file));
const settings = () => vscode.workspace.getConfiguration('tsStructure');

/** A scene that runs an analysis command at the cursor and shows its report. */
function analysis(name: string, file: string, needle: string, command: string, ...args: unknown[]): Scene {
  return {
    name,
    async run({ open }) {
      await open(file, needle);
      await vscode.commands.executeCommand(command, ...args);
    },
  };
}

/** Waits until the file has diagnostics from this extension. */
async function diagnostics(file: string, delay: SceneContext['delay']): Promise<void> {
  for (let i = 0; i < 100 && !vscode.languages.getDiagnostics(uri(file)).some((d) => d.source === 'TS Structure'); i++) {
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
      await vscode.commands.executeCommand('tsStructure.inspectCode', 'file');
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      await open(file, needle);
      await delay(300);
      await vscode.commands.executeCommand('editor.action.showHover');
    },
    settle: 1500,
  };
}

export const scenes: Scene[] = [
  // Inspections
  analysis('data-flow', 'src/cart.ts', 'total = applyCoupon', 'tsStructure.dataFlow'),
  analysis('mutation-tracking', 'src/cart.ts', 'addToCart(', 'tsStructure.mutationTracking'),
  analysis('nullability', 'src/pricing.ts', 'coupon = findCoupon', 'tsStructure.nullability'),
  analysis('promise-rejections', 'src/orders.ts', 'saveOrder(id: string', 'tsStructure.promiseRejections'),
  inspection('missing-await', 'src/orders.ts', 'placeOrder(id, items, payment);\n}\n\nexport function onCheckoutClick'),
  inspection('type-assertions', 'src/api.ts', 'as Book;\n}\n\nexport function firstItem'),
  analysis('dead-exports', 'src/legacy.ts', 'oldDiscount', 'tsStructure.deadExports'),
  analysis('exception-flow', 'src/config.ts', 'parseConfig(text: string)', 'tsStructure.exceptionFlow'),
  analysis('duplicates', 'src/pricing.ts', 'calculateSubtotal(items', 'tsStructure.findDuplicates', 'project'),
  {
    name: 'side-effects',
    async run({ open }) {
      await settings().update('codeLens.sideEffects', true, vscode.ConfigurationTarget.Global);
      await open('src/cart.ts', 'addToCart(');
      await vscode.commands.executeCommand('tsStructure.sideEffects');
    },
    async cleanup() {
      await settings().update('codeLens.sideEffects', undefined, vscode.ConfigurationTarget.Global);
    },
  },
  // Navigation and search
  analysis('semantic-usages', 'src/pricing.ts', 'calculateSubtotal(items', 'tsStructure.semanticUsages'),
  analysis('reexport-chain', 'src/main.ts', 'subtotal }', 'tsStructure.reexportChain'),
  {
    name: 'structural-search',
    async run({ open }) {
      await open('src/cart.ts', 'items.find');
      await vscode.commands.executeCommand('tsStructure.structuralSearch', {
        pattern: '$list$.find($callback$)',
        constraints: [{ name: 'list', type: '^LineItem\\[\\]$' }],
        run: true,
      });
    },
    settle: 2500,
  },
  {
    name: 'structural-replace',
    async run({ open }) {
      await open('src/pricing.ts', 'Math.round');
      await vscode.commands.executeCommand('tsStructure.structuralSearch', {
        pattern: 'Math.round($value$ * 100) / 100',
        replacement: 'Number($value$.toFixed(2))',
        run: true,
      });
    },
    settle: 2500,
  },
  {
    name: 'custom-inspections',
    async run({ open, delay }) {
      await settings().update(
        'customInspections',
        [{ id: 'no-console-log', pattern: 'console.log($args*$)', message: 'Use track() instead of console.log', severity: 'warning', replacement: "track('log', String($args*$))" }],
        vscode.ConfigurationTarget.Workspace,
      );
      await open('src/orders.ts', 'console.log');
      await diagnostics('src/orders.ts', delay);
      await vscode.commands.executeCommand('tsStructure.inspectCode', 'file');
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      await open('src/orders.ts', 'console.log');
      await delay(300);
      await vscode.commands.executeCommand('editor.action.showHover');
    },
    async cleanup() {
      await settings().update('customInspections', undefined, vscode.ConfigurationTarget.Workspace);
    },
    settle: 1500,
  },
  analysis('type-hierarchy', 'src/models.ts', 'PaymentMethod {', 'tsStructure.typeHierarchy'),
  analysis('override-impact', 'src/models.ts', 'charge(amount: number): Promise<Receipt>;', 'tsStructure.overrideImpact'),
  {
    name: 'dependency-path',
    async run({ open }) {
      await open('src/main.ts', 'placeOrder');
      await vscode.commands.executeCommand('tsStructure.dependencyPath', uri('src/main.ts'), uri('src/analytics.ts'));
    },
  },
  {
    name: 'graph-diff',
    async run({ open }) {
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
      await vscode.commands.executeCommand('tsStructure.dependencyGraphDiff', 'HEAD');
    },
    async cleanup() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      execFileSync('git', ['checkout', '--', '.'], { cwd: root() });
    },
  },
  analysis('argument-flow', 'src/pricing.ts', 'code?: string): number', 'tsStructure.argumentFlow'),
];
