import * as vscode from 'vscode';
import { EarlyViews } from './ui/sidebarPages';

/**
 * The extension's entry point. It opens the sidebar views' pages straight away, and only then loads the rest
 * (TypeScript and every feature), which takes a moment. VS Code waits for activate to finish
 * before running any of the extension's commands, so none of them is missed meanwhile.
 */
let main: typeof import('./extension') | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const early = new EarlyViews(context);
  // Give VS Code the chance to open a visible view first (a moment at most), so its page loads alongside the rest.
  await Promise.race([early.opened.then(() => new Promise((resolve) => setTimeout(resolve, 0))), new Promise((resolve) => setTimeout(resolve, 150))]);
  main = await import('./extension');
  main.activate(context, early);
}

export function deactivate(): void {
  main?.deactivate();
}
