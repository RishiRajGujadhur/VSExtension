import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cdp } from './cdp';
import { scenes } from './scenes';
import { features } from '../../structure/features';
import { decodePng, encodeGif } from './gif';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const width = 1440;
const height = 860;
/** Recordings are scaled down to keep the GIFs small; text stays readable. */
const scale = 0.8;

/**
 * Records the window while a scene plays: frames are captured back to back and shown for as long as
 * they were on screen, up to a cap, so waiting for an analysis doesn't make the GIF drag.
 */
class Recorder {
  private readonly frames: { png: Buffer; at: number }[] = [];
  private stopped = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly cdp: Cdp) {}

  start(): void {
    this.loop = (async () => {
      while (!this.stopped && this.frames.length < 240) {
        this.frames.push({ png: await this.cdp.frame(width, height, scale), at: Date.now() });
        await delay(120);
      }
    })();
  }

  /** Stops, adds the final state, and writes the GIF with that state held for `holdMs`. */
  async save(file: string, holdMs: number): Promise<void> {
    this.stopped = true;
    await this.loop;
    this.frames.push({ png: await this.cdp.frame(width, height, scale), at: Date.now() });
    // Byte-identical captures are the same picture: keep the first of each run.
    const distinct = this.frames.filter((f, i) => i === 0 || !f.png.equals(this.frames[i - 1].png));
    const frames = distinct.map((f, i) => ({
      image: decodePng(f.png),
      delayMs: i === distinct.length - 1 ? holdMs : Math.min(1500, Math.max(80, distinct[i + 1].at - f.at)),
    }));
    fs.writeFileSync(file, encodeGif(frames));
  }
}

/** Runs inside VS Code via --extensionTestsPath; started by scripts/screenshots.js. */
export async function run(): Promise<void> {
  const cdp = await Cdp.connect(Number(process.env.SCREENSHOT_PORT));
  const outDir = process.env.SCREENSHOT_DIR!;
  const only = (process.env.SCREENSHOT_ONLY ?? '').split(',').filter(Boolean);
  try {
    // The guides show every feature, including the ones that start off.
    for (const feature of features) {
      await vscode.workspace.getConfiguration('tsStructure.features').update(feature.id, true, vscode.ConfigurationTarget.Global);
    }
    await cdp.resize(width, height);
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
      // Each scene starts from an empty results view, so the GIF shows its own report appearing.
      await vscode.commands.executeCommand('tsStructure.clearReport');
      await delay(300);
      const recorder = new Recorder(cdp);
      recorder.start();
      await scene.run({ open, cdp, delay });
      await delay(scene.settle ?? 1200);
      await recorder.save(path.join(outDir, `${scene.name}.gif`), 3500);
      if (scene.walkthrough) {
        await cdp.capture(path.join(outDir, '..', '..', 'media', 'walkthrough', `${scene.name}.png`), scene.walkthrough);
      }
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
