import * as path from 'path';
import * as vscode from 'vscode';
import { Cdp } from './cdp';
import { scenes } from './scenes';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs inside VS Code via --extensionTestsPath; started by scripts/screenshots.js. */
export async function run(): Promise<void> {
  const cdp = await Cdp.connect(Number(process.env.SCREENSHOT_PORT));
  const outDir = process.env.SCREENSHOT_DIR!;
  const only = (process.env.SCREENSHOT_ONLY ?? '').split(',').filter(Boolean);
  try {
    await cdp.resize(1440, 860);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    // A wider side bar, so report rows are not cut off.
    await vscode.commands.executeCommand('tsStructure.report.focus');
    await delay(500);
    await cdp.sideBarWidth(480);
    for (const scene of scenes) {
      if (only.length && !only.includes(scene.name)) {
        continue;
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('notifications.clearAll');
      await scene.run({ open, cdp, delay });
      await delay(scene.settle ?? 1200);
      await cdp.capture(path.join(outDir, `${scene.name}.png`));
      await scene.cleanup?.();
      console.log(`captured ${scene.name}`);
    }
  } finally {
    cdp.close();
  }
}

/** Opens a file of the demo project with the cursor at the needle (plus delta characters), or with the needle selected. */
async function open(file: string, needle?: string, options: { delta?: number; select?: boolean; column?: vscode.ViewColumn } = {}): Promise<vscode.TextEditor> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const document = await vscode.workspace.openTextDocument(path.join(root, file));
  const editor = await vscode.window.showTextDocument(document, options.column);
  if (needle !== undefined) {
    const index = document.getText().indexOf(needle);
    if (index < 0) {
      throw new Error(`${needle} not found in ${file}`);
    }
    const start = document.positionAt(index + (options.select ? 0 : (options.delta ?? 1)));
    const end = options.select ? document.positionAt(index + needle.length) : start;
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  }
  return editor;
}

export type Open = typeof open;
