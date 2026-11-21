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
import { listVoices, speak } from './voice';
import { speakable } from './describe';

const lastRefKey = 'tsStructure.reel.lastRevision';
const captionsKey = 'tsStructure.reel.captions';
const skippedKey = 'tsStructure.reel.skipped';
const voiceKey = 'tsStructure.reel.voice';

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
  /** Each scene's length without a voice: with one, a scene lasts at least as long as its clip. */
  private baseSeconds: Record<string, number> = {};
  /** The voice-over: on or off, which voice, and the clips by scene. */
  private voice: { on: boolean; name?: string; voices: string[]; clips: Record<string, string> } = { on: false, voices: [], clips: {} };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
    /** Where recorded voice clips are kept. */
    private readonly storage: string,
  ) {
    const saved = state.get<{ on: boolean; name?: string }>(voiceKey);
    if (saved) this.voice = { ...this.voice, on: saved.on, name: saved.name };
  }

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
      this.pendingExport = { file, resolve, reject };
      void this.panel.webview.postMessage({ type: 'record', format });
    });
  }
  /** For tests: the next export (started in the page, say with its E key) is written to this file. */
  expectExport(file: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pendingExport = { file, resolve, reject };
    });
  }
  /** For tests: what the page said about the sound of the last export. */
  lastSound: unknown;
  private pendingExport: { file: string; resolve: (size: number) => void; reject: (error: Error) => void } | undefined;

  /** Turns the voice-over on (recording every caption) or off, with a voice by name if given. */
  async setVoice(on: boolean, name?: string): Promise<void> {
    this.voice.on = on;
    if (name !== undefined) this.voice.name = name || undefined;
    void this.state.update(voiceKey, { on: this.voice.on, name: this.voice.name });
    if (this.voice.on) await this.voiceOver(undefined, false);
    else this.applyVoiceTiming();
    this.post();
  }

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
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; id?: string; caption?: string | null; data?: string; ext?: string; skip?: boolean; on?: boolean; voice?: string; text?: string; file?: string; line?: number; error?: string; sound?: unknown }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.post();
      } else if (message.type === 'refresh') {
        await this.build();
      } else if (message.type === 'caption' && message.id) {
        this.rememberCaption(message.id, message.caption ?? undefined);
        // A new caption, a new clip for its scene.
        if (this.voice.on) await this.voiceOver([message.id]);
      } else if (message.type === 'skip' && message.id) {
        const skipped = new Set(this.state.get<string[]>(this.key(skippedKey)) ?? []);
        if (message.skip) skipped.add(message.id);
        else skipped.delete(message.id);
        void this.state.update(this.key(skippedKey), [...skipped]);
      } else if (message.type === 'voice') {
        await this.setVoice(message.on === true, message.voice);
      } else if (message.type === 'maximize') {
        // Full screen inside the editor: Zen Mode, which hides the rest of the editor and (by default) fills the
        // screen; the player fills the panel.
        await vscode.commands.executeCommand('workbench.action.toggleZenMode');
        // Zen Mode narrows the editor to a centred column by default: the reel takes the whole width instead (for
        // this time only; the setting is left as it is, and leaving Zen Mode restores the layout).
        if (message.on && vscode.workspace.getConfiguration('zenMode').get('centerLayout', true)) await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
      } else if (message.type === 'copy' && typeof message.text === 'string') {
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Copied the reel as Markdown: paste it into a pull request', 5000);
      } else if (message.type === 'open' && message.file && this.request) {
        // The scene's code, at its first changed line.
        const line = Math.max(0, (message.line ?? 1) - 1);
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.request.repo, message.file)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
      } else if (message.type === 'save' && (message.ext === 'webm' || message.ext === 'mp4')) {
        const video = Buffer.from(message.data ?? '', 'base64');
        this.lastSound = message.sound;
        const pending = this.pendingExport;
        this.pendingExport = undefined;
        // Nothing recorded: this editor cannot make that format, or the recording failed (the page said why).
        if (!video.length) {
          if (pending && message.error) pending.reject(new Error(message.error));
          else pending?.resolve(0);
          if (!pending && message.error) void showProblem(`The Git reel could not be exported: ${message.error}`, [], 'info');
        }
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
      this.baseSeconds = Object.fromEntries(this.plan.scenes.map((s) => [s.id, s.seconds]));
      this.voice.clips = {};
      if (this.voice.on) await this.voiceOver(undefined, false);
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
    return this.key(captionsKey);
  }
  /** A memento key for this change: the repository and what it is compared with. */
  private key(prefix: string): string {
    return `${prefix}:${this.request?.repo}:${this.request?.ref}`;
  }

  /**
   * Records the voice-over of the scenes (all, or those given) with the system voice and fits each scene to its clip.
   * Says so, and turns the voice off, when this computer has no voice to use.
   */
  private async voiceOver(ids?: string[], post = true): Promise<void> {
    if (!this.plan) return;
    if (!this.voice.voices.length) this.voice.voices = await listVoices();
    if (!this.voice.voices.length) {
      this.voice.on = false;
      void showProblem(process.platform === 'linux' ? 'The voice-over needs espeak-ng (or espeak): install it, then turn the voice on again.' : 'No system voice was found for the voice-over.', [], 'info');
      if (post) this.post();
      return;
    }
    const scenes = this.plan.scenes.filter((s) => !ids || ids.includes(s.id));
    void this.panel?.webview.postMessage({ type: 'busy', text: `Recording the voice-over (${scenes.length} scene${scenes.length === 1 ? '' : 's'})…` });
    try {
      const clips = await speak(scenes.map((s) => ({ id: s.id, text: speakable(s.caption) })), this.voice.name ?? this.voice.voices[0], path.join(this.storage, 'reel-voice'));
      for (const id of ids ?? this.plan.scenes.map((s) => s.id)) delete this.voice.clips[id];
      for (const clip of clips) this.voice.clips[clip.id] = clip.wav.toString('base64');
      this.clipSeconds = { ...this.clipSeconds, ...Object.fromEntries(clips.map((c) => [c.id, c.seconds])) };
      this.applyVoiceTiming();
    } catch (error) {
      this.voice.on = false;
      void showProblem(`The voice-over could not be recorded: ${error instanceof Error ? error.message : String(error)}`, [], 'info');
    }
    void this.panel?.webview.postMessage({ type: 'busy', text: '' });
    if (post) this.post();
  }
  private clipSeconds: Record<string, number> = {};

  /** With the voice on, each scene lasts at least as long as its clip and a breath; off, as it was built. */
  private applyVoiceTiming(): void {
    if (!this.plan) return;
    for (const s of this.plan.scenes) {
      const base = this.baseSeconds[s.id] ?? s.seconds;
      const clip = this.voice.on ? this.clipSeconds[s.id] ?? 0 : 0;
      s.seconds = Math.round(Math.max(base, clip ? clip + 0.9 : 0) * 10) / 10;
    }
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
    void this.panel.webview.postMessage({
      type: 'plan',
      plan: this.plan,
      generated: this.generated,
      skipped: this.state.get<string[]>(this.key(skippedKey)) ?? [],
      voice: { on: this.voice.on, name: this.voice.name ?? this.voice.voices[0], voices: this.voice.voices, clips: this.voice.on ? this.voice.clips : {} },
    });
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
  ${iconButton('copyMarkdown', 'markdown', 'Copy as Markdown: what each change does, for a pull request description')}
  ${iconButton('refresh', 'refresh', 'Read the changes again (captions you wrote are kept)')}
</header>
<p id="empty">Reading the changes…</p>
<div id="stage">
  <div id="player" class="player" tabindex="0" aria-label="Git reel player: Space plays, F goes full screen, C turns captions on or off">
    <canvas id="screen" width="1920" height="1080" role="img" aria-label="The reel"></canvas>
    <button type="button" id="bigPlay" class="big-play" aria-label="Play"><i class="codicon codicon-play" aria-hidden="true"></i></button>
    <div class="chrome">
      <div id="timeline" role="slider" aria-label="Chapters: click or drag to move through the reel" tabindex="-1"><span id="playhead"></span><span id="hoverTip" hidden></span></div>
      <div class="bar">
        <button type="button" id="play" class="yt" aria-pressed="false" title="Play (k)" aria-label="Play"><i class="codicon codicon-play" aria-hidden="true"></i></button>
        <button type="button" id="restart" class="yt" title="Back to the start (Home)" aria-label="Back to the start"><i class="codicon codicon-debug-restart" aria-hidden="true"></i></button>
        <button type="button" id="voiceToggle" class="yt" aria-pressed="false" title="Voice-over (v)"><i class="codicon codicon-mute" aria-hidden="true"></i></button>
        <span class="time"><span id="time">0:00</span> / <span id="frames">0:00</span></span>
        <span id="chapter" class="chapter"></span>
        <span class="spacer"></span>
        <button type="button" id="cc" class="yt cc" aria-pressed="true" title="Captions (c)" aria-label="Captions">CC</button>
        <button type="button" id="settings" class="yt" aria-haspopup="menu" aria-expanded="false" title="Settings" aria-label="Settings"><i class="codicon codicon-settings-gear" aria-hidden="true"></i></button>
        <button type="button" id="fullscreen" class="yt" title="Full screen (f)" aria-label="Full screen"><i class="codicon codicon-screen-full" aria-hidden="true"></i></button>
      </div>
    </div>
    <div id="settingsMenu" class="yt-menu" role="menu" hidden>
      <label class="row">Theme
        <select id="theme" aria-label="Theme">
          <option value="midnight">Midnight</option>
          <option value="graphite">Graphite</option>
          <option value="paper">Paper</option>
        </select>
      </label>
      <div class="row">Shape
        <span class="segmented" role="group" aria-label="Shape">
          <button type="button" data-aspect="16:9" aria-pressed="true" title="Landscape, for pull requests and slides">16:9</button>
          <button type="button" data-aspect="9:16" aria-pressed="false" title="Portrait, for phones and stories">9:16</button>
        </span>
      </div>
      <label class="row" id="voiceRow">Voice <select id="voiceSelect" aria-label="Voice" hidden></select></label>
    </div>
  </div>
</div>
<section id="transport" aria-label="Export">
  <div class="controls">
    <span id="status" role="status" aria-live="polite"></span>
    <span class="progress" hidden><span id="progressBar"></span></span>
    <button type="button" id="cancel" hidden>Cancel</button>
    <span id="exports"></span>
  </div>
</section>
<section id="scenes" aria-label="Scenes and captions">
  <h2>Scenes and captions</h2>
  <ol id="sceneList"></ol>
</section>`,
  });
}
