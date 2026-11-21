import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildReelPlan, keepUserCaptions, ReelPlan, ReelRequest } from './plan';
import { gitRoot } from '../navigate/graphDiff';
import { pickRef } from '../ui/graphDiffCommand';
import { iconButton, webviewPage, webviewRoots } from '../ui/webviewPage';
import { followAnimations } from '../ui/animationSettings';
import { remedies, showProblem, unexpectedRemedies } from '../ui/problems';
import { AnalysisError } from '../analysis/types';

const lastRefKey = 'tsStructure.reel.lastRevision';
const captionsKey = 'tsStructure.reel.captions';

/** "Branch point with main" → "main"; HEAD → "the last commit". */
export function baseLabelOf(choice: { ref: string; label: string }): string {
  if (choice.ref === 'HEAD') return 'the last commit';
  const branchPoint = /^Branch point with (.+)$/.exec(choice.label);
  return branchPoint ? branchPoint[1] : choice.label;
}

/**
 * The Git reel panel: a short video of the changes since a revision, drawn by media/reel.js from a ReelPlan. Captions
 * edited by hand are kept per scene (in the workspace) and survive rebuilding the plan.
 */
export class ReelPanel {
  static readonly viewType = 'tsStructure.reel';
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private request: ReelRequest | undefined;
  private plan: ReelPlan | undefined;
  private generated: Record<string, string> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  /** Asks what to compare with (unless given), builds the plan and shows the player. Returns the plan, for tests. */
  async open(refArg?: string): Promise<ReelPlan | undefined> {
    const editor = vscode.window.activeTextEditor;
    const anchor = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!anchor) {
      void showProblem('Open a folder or a file in a Git repository first.', [remedies.openFile, remedies.initGit]);
      return undefined;
    }
    let repo: string;
    try {
      repo = gitRoot(fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor));
    } catch {
      void showProblem('A Git reel shows the changes in a Git repository, and this folder is not in one.', [remedies.initGit], 'info');
      return undefined;
    }
    const choice = refArg ? { ref: refArg, label: refArg } : await pickRef(repo, this.state.get(lastRefKey), 'Make a Git reel of the changes since…');
    if (!choice) return undefined;
    void this.state.update(lastRefKey, choice);
    this.request = { repo, ref: choice.ref, baseLabel: baseLabelOf(choice) };
    this.reveal();
    return this.build();
  }

  /** For tests: records the reel and writes it to a file, without the save dialog. Resolves with the file's size. */
  exportTo(file: string, format: 'webm' | 'mp4'): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.panel) return reject(new Error('No Git reel is open.'));
      this.pendingExport = { file, resolve };
      void this.panel.webview.postMessage({ type: 'record', format });
    });
  }
  private pendingExport: { file: string; resolve: (size: number) => void } | undefined;

  /** For tests: the plan on show. */
  get current(): ReelPlan | undefined {
    return this.plan;
  }

  private reveal(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(ReelPanel.viewType, 'Git reel', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewRoots(this.extensionUri) });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'structure-light.svg'), dark: vscode.Uri.joinPath(media, 'structure-dark.svg') };
    this.ready = false;
    this.panel.webview.html = page(this.panel.webview, this.extensionUri);
    followAnimations(this.panel);
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; id?: string; caption?: string | null; data?: string; ext?: string }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.post();
      } else if (message.type === 'refresh') {
        await this.build();
      } else if (message.type === 'caption' && message.id) {
        this.rememberCaption(message.id, message.caption ?? undefined);
      } else if (message.type === 'save' && (message.ext === 'webm' || message.ext === 'mp4')) {
        const video = Buffer.from(message.data ?? '', 'base64');
        const pending = this.pendingExport;
        this.pendingExport = undefined;
        // Nothing recorded: this editor cannot make that format.
        if (!video.length) pending?.resolve(0);
        else if (pending) {
          fs.writeFileSync(pending.file, video);
          pending.resolve(video.length);
        } else await this.save(video, message.ext);
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.plan = undefined;
    });
  }

  private async build(): Promise<ReelPlan | undefined> {
    const request = this.request;
    if (!request) return undefined;
    void this.panel?.webview.postMessage({ type: 'busy', text: 'Reading the changes…' });
    try {
      const fresh = await buildReelPlan(request);
      if (request !== this.request) return undefined;
      this.generated = Object.fromEntries(fresh.scenes.map((s) => [s.id, s.caption]));
      // Captions written by hand for this change come back.
      const written = this.state.get<Record<string, string>>(this.captionKey()) ?? {};
      const earlier: ReelPlan = { ...fresh, scenes: fresh.scenes.filter((s) => written[s.id] !== undefined).map((s) => ({ ...s, caption: written[s.id], captionSource: 'user' })) };
      this.plan = keepUserCaptions(fresh, earlier);
      if (this.plan.scenes.length <= 2 && !this.plan.meta.files) {
        void showProblem(`No changes since ${request.baseLabel}: the reel has nothing to show.`, [], 'info');
      }
      if (this.panel) this.panel.title = `Git reel: ${this.plan.meta.title}`;
      this.post();
      return this.plan;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      void this.panel?.webview.postMessage({ type: 'busy', text: '' });
      void showProblem(error instanceof AnalysisError ? `The Git reel could not read the changes. ${why}` : `Git reel failed: ${why}`, error instanceof AnalysisError ? [] : unexpectedRemedies('Git reel', error));
      return undefined;
    }
  }

  private captionKey(): string {
    return `${captionsKey}:${this.request?.repo}:${this.request?.ref}`;
  }

  private rememberCaption(id: string, caption: string | undefined): void {
    const written = { ...(this.state.get<Record<string, string>>(this.captionKey()) ?? {}) };
    if (caption === undefined) delete written[id];
    else written[id] = caption;
    void this.state.update(this.captionKey(), written);
    const scene = this.plan?.scenes.find((s) => s.id === id);
    if (scene) {
      scene.caption = caption ?? this.generated[id] ?? scene.caption;
      scene.captionSource = caption === undefined ? 'heuristic' : 'user';
    }
  }

  private post(): void {
    if (!this.panel || !this.ready || !this.plan) return;
    void this.panel.webview.postMessage({ type: 'plan', plan: this.plan, generated: this.generated });
  }

  /** Saves a recorded video, by default under .codexray/reels in the repository, and offers to keep that out of Git. */
  private async save(video: Buffer, ext: 'webm' | 'mp4'): Promise<void> {
    const repo = this.request?.repo;
    if (!repo || !this.plan) return;
    const slug = this.plan.meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'reel';
    const folder = path.join(repo, '.codexray', 'reels');
    fs.mkdirSync(folder, { recursive: true });
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, `${slug}.${ext}`)),
      filters: ext === 'mp4' ? { 'MP4 video': ['mp4'] } : { 'WebM video': ['webm'] },
      title: 'Save the Git reel',
    });
    if (!target) {
      void this.panel?.webview.postMessage({ type: 'saved', text: 'Not saved.' });
      return;
    }
    await vscode.workspace.fs.writeFile(target, video);
    const size = `${(video.length / 1024 / 1024).toFixed(1)} MB`;
    void this.panel?.webview.postMessage({ type: 'saved', text: `Saved ${path.basename(target.fsPath)} (${size}).` });
    const actions = ['Show in Folder', ...(target.fsPath.startsWith(path.join(repo, '.codexray')) && !ignored(repo) ? ['Add .codexray/ to .gitignore'] : [])];
    const picked = await vscode.window.showInformationMessage(`Saved the Git reel: ${path.basename(target.fsPath)} (${size}).`, ...actions);
    if (picked === 'Show in Folder') await vscode.commands.executeCommand('revealFileInOS', target);
    else if (picked?.startsWith('Add')) {
      const file = path.join(repo, '.gitignore');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}.codexray/\n`);
    }
  }
}

/** Whether .codexray/ is already in the repository's .gitignore. */
function ignored(repo: string): boolean {
  try {
    return /^\/?\.codexray\/?\s*$/m.test(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'));
  } catch {
    return false;
  }
}

function page(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return webviewPage(webview, extensionUri, {
    title: 'Git reel',
    styles: ['reel.css'],
    scripts: ['reel.js'],
    body: `<header aria-label="Git reel">
  <span class="dot" aria-hidden="true"></span>
  <span id="title">Git reel</span>
  <span id="base"></span>
  <span class="spacer"></span>
  <span class="segmented" role="group" aria-label="Shape">
    <button type="button" data-aspect="16:9" aria-pressed="true" title="Landscape, for pull requests and slides">16:9</button>
    <button type="button" data-aspect="9:16" aria-pressed="false" title="Portrait, for phones and stories">9:16</button>
  </span>
  <select id="theme" aria-label="Theme" title="Theme">
    <option value="midnight">Midnight</option>
    <option value="graphite">Graphite</option>
    <option value="paper">Paper</option>
  </select>
  ${iconButton('refresh', 'refresh', 'Read the changes again (captions you wrote are kept)')}
</header>
<p id="empty">Reading the changes…</p>
<div id="stage"><canvas id="screen" width="1920" height="1080" role="img" aria-label="The reel"></canvas></div>
<section id="transport" aria-label="Playback">
  <div class="times"><span id="time">00:00.0</span><span id="frames"></span></div>
  <div id="timeline" role="slider" aria-label="Scenes: click or drag to move through the reel"><span id="playhead"></span></div>
  <div class="controls">
    <button type="button" id="play" class="primary" aria-pressed="false"><i class="codicon codicon-play" aria-hidden="true"></i> Play</button>
    <button type="button" id="restart" class="icon-button" title="Back to the start (Home)" aria-label="Back to the start"><i class="codicon codicon-debug-restart" aria-hidden="true"></i></button>
    <span id="status" role="status" aria-live="polite"></span>
    <span id="exports"></span>
  </div>
</section>
<section id="scenes" aria-label="Scenes and captions">
  <h2>Scenes and captions</h2>
  <ol id="sceneList"></ol>
</section>`,
  });
}
