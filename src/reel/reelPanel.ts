import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildReelPlan, changedFiles, keepUserCaptions, ReelPlan, ReelRequest, skipReason } from './plan';
import { gitRoot } from '../navigate/graphDiff';
import { pickRef } from '../ui/graphDiffCommand';
import { iconButton, webviewPage, webviewRoots } from '../ui/webviewPage';
import { followAnimations } from '../ui/animationSettings';
import { remedies, showProblem, unexpectedRemedies } from '../ui/problems';
import { AnalysisError } from '../analysis/types';
import { listVoices, speak, VoiceClip } from './voice';
import { KittenNarrator } from './kitten';
import { DEFAULT_KITTEN_VOICE } from './kittenModel';
import { DEFAULT_VOICE_MODEL, SYSTEM_VOICE_MODEL, VOICE_MODELS, voiceModel, VoiceModel, VoiceModelStore } from './voiceModels';
import { speakable } from './describe';
import { CodeModel } from './codeModel';
import { CODE_MODEL, downloadDisclosure } from './codeModelText';

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
    this.kitten = new KittenNarrator(path.join(extensionUri.fsPath, 'dist', 'kitten'), path.join(extensionUri.fsPath, 'dist', 'kittenWorker.js'));
    this.codeModel = new CodeModel(path.join(storage, 'code-model'), path.join(extensionUri.fsPath, 'dist', 'codeModelWorker.js'), path.join(extensionUri.fsPath, 'dist', 'kitten', 'ort'));
    this.voiceModels = new VoiceModelStore(path.join(storage, 'voice-models'));
  }
  /** The natural voices' engine (bundled), speaking with the voice model you downloaded; stopped with the extension. */
  private readonly kitten: KittenNarrator;
  /** The voice models downloaded, one folder each in the extension's storage. */
  readonly voiceModels: VoiceModelStore;
  /** "Not now" to the voice model prompt: the computer's voice reads until VS Code restarts. */
  private voiceModelDeclined = false;

  /**
   * The Voice model setting: a model's id, or "system" for the computer's own voice. Natural voices turned off in an
   * earlier version (and no model chosen since) read as "system".
   */
  private voiceModelSetting(): string {
    const config = vscode.workspace.getConfiguration('tsStructure.reel');
    const chosen = config.inspect<string>('voiceModel');
    const set = chosen?.workspaceValue ?? chosen?.globalValue;
    if (set === undefined && config.get<boolean>('naturalVoices', true) === false) return SYSTEM_VOICE_MODEL;
    return set ?? DEFAULT_VOICE_MODEL;
  }

  /**
   * The voice model to speak with, downloaded: the one set, or the one you choose now. When none is downloaded, you
   * are asked which (Kitten Nano is recommended), with what each download weighs and what it sends; or your
   * computer's own voice, with nothing to download. Undefined: the computer's voice reads.
   */
  async ensureVoiceModel(): Promise<VoiceModel | undefined> {
    const setting = this.voiceModelSetting();
    if (setting === SYSTEM_VOICE_MODEL) return undefined;
    const set = voiceModel(setting) ?? voiceModel(DEFAULT_VOICE_MODEL)!;
    if (this.voiceModels.downloaded(set)) return this.useVoiceModel(set);
    if (this.voiceModelDeclined) return undefined;
    const picked = await this.pickVoiceModel('The voice-over needs a voice model: choose one to download (once), or your computer\'s own voice');
    if (!picked) {
      this.voiceModelDeclined = true;
      return undefined;
    }
    if (picked === SYSTEM_VOICE_MODEL) return undefined;
    return (await this.downloadVoiceModel(picked)) ? this.useVoiceModel(picked) : undefined;
  }

  private useVoiceModel(model: VoiceModel): VoiceModel {
    this.kitten.use({ id: model.id, dir: this.voiceModels.dir(model), priors: model.speedPriors });
    return model;
  }

  /**
   * The voice models to choose from, the recommended one first, each with its download size and whether it is on
   * this computer; then your computer's own voice. The choice is kept in the Voice model setting.
   */
  private async pickVoiceModel(title: string): Promise<VoiceModel | typeof SYSTEM_VOICE_MODEL | undefined> {
    type Item = vscode.QuickPickItem & { model?: VoiceModel; system?: boolean };
    const current = this.voiceModelSetting();
    const items: Item[] = [
      ...VOICE_MODELS.map((m): Item => ({
        label: `${m.recommended ? '$(star-full) ' : ''}${m.name}${m.recommended ? ' (recommended)' : ''}`,
        description: this.voiceModels.downloaded(m) ? 'downloaded' : `${m.megabytes} MB download`,
        detail: `${m.note} Eight voices. Apache-2.0, by KittenML.${m.id === current ? ' Chosen now.' : ''}`,
        model: m,
      })),
      { label: '$(device-desktop) Your computer\'s own voice', description: 'no download', detail: 'Made at once, more robotic.', system: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Downloaded once from huggingface.co: the request shows Hugging Face your IP address, and sends none of your code',
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    const value = pick.system ? SYSTEM_VOICE_MODEL : pick.model!.id;
    await vscode.workspace.getConfiguration('tsStructure.reel').update('voiceModel', value, vscode.ConfigurationTarget.Global);
    return pick.system ? SYSTEM_VOICE_MODEL : pick.model;
  }

  /** Downloads a voice model, with its progress and a way to cancel; true when it is ready. */
  private async downloadVoiceModel(model: VoiceModel): Promise<boolean> {
    if (this.voiceModels.downloaded(model)) return true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${model.name} (${model.megabytes} MB, from Hugging Face)`, cancellable: true },
        async (progress, token) => {
          let shown = 0;
          await this.voiceModels.download(model, (received, total) => {
            const percent = Math.floor((100 * received) / total);
            if (percent > shown) {
              progress.report({ increment: percent - shown, message: `${percent}%` });
              shown = percent;
            }
          }, () => token.isCancellationRequested);
        },
      );
    } catch (error) {
      void showProblem(`${model.name} could not be downloaded, so your computer's voice reads instead: ${error instanceof Error ? error.message : String(error)}`, [], 'info');
      return false;
    }
    return this.voiceModels.downloaded(model);
  }

  /** The command: choose the voice model (downloading it if needed), or the computer's voice. */
  async chooseVoiceModel(): Promise<void> {
    const picked = await this.pickVoiceModel('Choose the voice model for the voice-over');
    if (!picked) return;
    this.voiceModelDeclined = false;
    if (picked !== SYSTEM_VOICE_MODEL && (await this.downloadVoiceModel(picked))) {
      void vscode.window.showInformationMessage(`${picked.name} is ready: the voice-over speaks with it, on your computer.`);
    }
    this.settingsChanged();
  }

  /** The command: remove downloaded voice models, chosen from those on this computer. */
  async removeVoiceModels(): Promise<void> {
    const here = this.voiceModels.list();
    if (!here.length) {
      void vscode.window.showInformationMessage('No voice model is downloaded.');
      return;
    }
    const picks = await vscode.window.showQuickPick(
      here.map((m) => ({ label: m.name, description: `${m.megabytes} MB`, picked: true, model: m })),
      { title: 'Remove downloaded voice models', canPickMany: true, placeHolder: 'The ones ticked are removed; the voice-over asks again when it next needs one' },
    );
    if (!picks?.length) return;
    this.kitten.use(undefined);
    for (const p of picks) this.voiceModels.remove(p.model);
    void vscode.window.showInformationMessage(`Removed ${picks.map((p) => p.model.name).join(', ')}.`);
    this.settingsChanged();
  }
  /** The code model: downloaded only when you agree to it, then run on this computer. */
  readonly codeModel: CodeModel;
  /** Asked once per session whether to download the code model. */
  private offered = false;

  dispose(): void {
    this.kitten.dispose();
    this.codeModel.dispose();
  }

  /** The Code model setting: "ask" (the default), "on" or "off". */
  private codeModelSetting(): 'ask' | 'on' | 'off' {
    const value = vscode.workspace.getConfiguration('tsStructure.reel').get<string>('codeModel', 'ask');
    return value === 'on' || value === 'off' ? value : 'ask';
  }

  /** The model for a plan, when it is turned on and downloaded. */
  private understanding(): ((texts: string[]) => Promise<Float32Array[]>) | undefined {
    if (this.codeModelSetting() === 'off' || !this.codeModel.runnable) return undefined;
    return (texts) => this.codeModel.embed(texts);
  }

  /**
   * Downloads the code model, with its progress shown and a way to cancel; true when it is ready. Only ever started
   * by you: from the prompt, the command, or the setting turned on.
   */
  async downloadCodeModel(): Promise<boolean> {
    if (this.codeModel.downloaded) return true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading the code model (${CODE_MODEL.megabytes} MB, from Hugging Face)`, cancellable: true },
        async (progress, token) => {
          let shown = 0;
          await this.codeModel.download((received, total) => {
            const percent = Math.floor((100 * received) / total);
            if (percent > shown) {
              progress.report({ increment: percent - shown, message: `${percent}%` });
              shown = percent;
            }
          }, () => token.isCancellationRequested);
        },
      );
    } catch (error) {
      void showProblem(`The code model could not be downloaded: ${error instanceof Error ? error.message : String(error)}`, [], 'info');
      return false;
    }
    if (!this.codeModel.downloaded) return false;
    void vscode.window.showInformationMessage('The code model is ready: Git reels now use it to pick each file\'s key change and name what code is for. It runs on your computer.');
    if (this.panel) await this.build();
    return true;
  }

  /** The download command: says what the download sends, and downloads only when you confirm. */
  async confirmAndDownloadCodeModel(): Promise<boolean> {
    if (this.codeModel.downloaded) {
      void vscode.window.showInformationMessage('The code model is already downloaded. It runs on your computer.');
      return true;
    }
    const choice = await vscode.window.showInformationMessage(`Download the code model (all-MiniLM-L6-v2, Apache-2.0, ${CODE_MODEL.megabytes} MB)?`, { modal: true, detail: downloadDisclosure() }, 'Download');
    return choice === 'Download' ? this.downloadCodeModel() : false;
  }

  /** Removes the downloaded code model; Git reels go back to the rules alone. */
  async removeCodeModel(): Promise<void> {
    this.codeModel.remove();
    void vscode.window.showInformationMessage('The code model was removed. Git reels use Code X-Ray\'s rules alone.');
    if (this.panel) await this.build();
  }

  /** After a reel is shown: offers the code model once a session, when the setting asks and it is not there yet. */
  private async offerCodeModel(): Promise<void> {
    const setting = this.codeModelSetting();
    if (this.codeModel.downloaded || setting === 'off' || this.offered) return;
    this.offered = true;
    if (setting === 'on') {
      await this.downloadCodeModel();
      return;
    }
    // What a download sends is said before it happens: only a request for the files, never your code.
    const choice = await vscode.window.showInformationMessage(
      `Git reel can explain changes better with a small code model: a one-time ${CODE_MODEL.megabytes} MB download from Hugging Face (all-MiniLM-L6-v2, Apache-2.0). The download sends only a request for the model's files, which shows Hugging Face your IP address; none of your code is sent, and the model runs on your computer.`,
      'Download',
      'Not Now',
      "Don't Ask Again",
    );
    if (choice === 'Download') await this.downloadCodeModel();
    else if (choice === "Don't Ask Again") await vscode.workspace.getConfiguration('tsStructure.reel').update('codeModel', 'off', vscode.ConfigurationTarget.Global);
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
    this.fixedPlan = undefined;
    // No changes: no player opens at all.
    let changed = true;
    try {
      changed = changedFiles(repo, choice.ref).some((f) => !skipReason(f));
    } catch {
      // Git could not say: the build reports why.
    }
    if (!changed) {
      void showProblem(`No changes since ${this.request.baseLabel}, so there is no reel to show.`, [], 'info');
      return undefined;
    }
    this.reveal();
    return this.build();
  }

  /**
   * Plays a plan made elsewhere (an explanation video) in the same player, with the voice-over on unless it is off
   * in the settings. `folder` is where its video is saved by default; `id` keeps its edited captions apart.
   */
  async openPlan(plan: ReelPlan, folder: string, id: string): Promise<ReelPlan | undefined> {
    this.fixedPlan = plan;
    this.request = { repo: folder, ref: `explain:${id}`, baseLabel: 'the explanation' };
    this.reveal();
    if (!this.narrationOff() && !this.voice.on) {
      await this.loadVoices();
      this.voice.on = true;
    }
    return this.build();
  }
  /** Whether the player's full screen has maximized its editor group, to undo it once. */
  private maximized = false;
  private async setMaximized(on: boolean): Promise<void> {
    if (on === this.maximized) return;
    this.maximized = on;
    try {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
    } catch {
      // An editor without it: the player still fills its panel.
    }
  }
  /** For tests: whether the player's full screen is on. */
  get isMaximized(): boolean {
    return this.maximized;
  }
  /** For tests: full screen on or off, as the F key does; resolves with whether it is on. */
  async toggleFullscreen(): Promise<boolean> {
    const before = this.maximized;
    void this.panel?.webview.postMessage({ type: 'fullscreen' });
    for (let waited = 0; waited < 3000 && this.maximized === before; waited += 50) await new Promise((r) => setTimeout(r, 50));
    return this.maximized;
  }

  /** A plan given to the player rather than read from Git. */
  private fixedPlan: ReelPlan | undefined;

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
    if (on && this.narrationOff()) {
      void showProblem('The voice-over is off in the Narration voice setting.', [{ title: 'Open the Setting', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'tsStructure.reel.narrationVoice') }], 'info');
      return;
    }
    if (on) await this.loadVoices();
    this.voice.on = on;
    if (name !== undefined) this.voice.name = name || undefined;
    void this.state.update(voiceKey, { on: this.voice.on, name: this.voice.name });
    if (this.voice.on) await this.voiceOver(undefined, false);
    else this.applyVoiceTiming();
    this.post();
  }

  /** For tests: the plan on show. */
  /** For tests: the reel's tab in front, with the focus. */
  focus(): void {
    this.panel?.reveal(undefined, false);
  }

  /** For tests: the voice the voice-over reads with, the voices offered, and how many clips it has. */
  get voiceInfo(): { name: string | undefined; voices: string[]; clips: number } {
    return { name: this.voice.on ? this.chosenVoice() : undefined, voices: this.voice.voices, clips: Object.keys(this.voice.clips).length };
  }

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
        // Full screen inside VS Code's window, never the screen: the reel's editor group takes the whole editor area
        // (the other groups fold away), and the player fills the panel. VS Code itself stays as it was.
        await this.setMaximized(!!message.on);
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
      // Closed while full screen: the editor groups come back as they were.
      void this.setMaximized(false);
    });
  }

  private async build(): Promise<ReelPlan | undefined> {
    const request = this.request;
    if (!request) return undefined;
    void this.panel?.webview.postMessage({ type: 'busy', text: this.fixedPlan ? 'Preparing the video…' : 'Reading the changes…' });
    try {
      const fixed = this.fixedPlan;
      const fresh: ReelPlan = fixed ? JSON.parse(JSON.stringify(fixed)) : await buildReelPlan({ ...request, understand: this.understanding() });
      if (request !== this.request) return undefined;
      // Nothing changed (or only files a reel leaves out, such as lock files): no video, just a word saying so.
      if (!fixed && !fresh.meta.files) {
        this.panel?.dispose();
        void showProblem(`No changes since ${request.baseLabel}, so there is no reel to show.`, [], 'info');
        return fresh;
      }
      this.generated = Object.fromEntries(fresh.scenes.map((s) => [s.id, s.caption]));
      // Captions written by hand for this change come back.
      const written = this.state.get<Record<string, string>>(this.captionKey()) ?? {};
      const earlier: ReelPlan = { ...fresh, scenes: fresh.scenes.filter((s) => written[s.id] !== undefined).map((s) => ({ ...s, caption: written[s.id], captionSource: 'user' })) };
      this.plan = keepUserCaptions(fresh, earlier);
      this.baseSeconds = Object.fromEntries(this.plan.scenes.map((s) => [s.id, s.seconds]));
      this.voice.clips = {};
      if (this.voice.on) await this.voiceOver(undefined, false);
      if (this.panel) this.panel.title = fixed ? `Video: ${this.plan.meta.title}` : `Git reel: ${this.plan.meta.title}`;
      this.post();
      if (!fixed) void this.offerCodeModel();
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
  /** The voices the picker offers: the bundled Kitten voices first, then this computer's own. */
  private async loadVoices(): Promise<void> {
    if (this.voice.voices.length) return;
    this.systemVoices = await listVoices();
    this.voice.voices = [...this.naturalVoiceNames(), ...this.systemVoices];
  }

  /**
   * The natural voices the picker offers: the eight voices of every model downloaded ("Jasper (Mini)"), the
   * model set first; with none downloaded yet, the eight by name (choosing one asks which model to download).
   */
  private naturalVoiceNames(): string[] {
    if (!this.naturalVoicesOn()) return [];
    const set = voiceModel(this.voiceModelSetting());
    const here = this.voiceModels.list().sort((a, b) => Number(b.id === set?.id) - Number(a.id === set?.id));
    if (!here.length) return KittenNarrator.voices();
    return here.flatMap((m) => KittenNarrator.voices().map((v) => `${v} (${m.short})`));
  }

  /** A voice by name as the picker lists it: "Jasper" from an earlier choice or the setting reads as "Jasper (…)". */
  private listedVoice(name: string | undefined): string | undefined {
    if (!name) return undefined;
    if (this.voice.voices.includes(name)) return name;
    if (!KittenNarrator.isNatural(name)) return undefined;
    const { voice } = KittenNarrator.parse(name);
    return this.voice.voices.find((v) => KittenNarrator.isNatural(v) && KittenNarrator.parse(v).voice === voice);
  }

  /** The natural voices: offered unless the Voice model setting is your computer's own voice (downloaded on first use). */
  private naturalVoicesOn(): boolean {
    return this.voiceModelSetting() !== SYSTEM_VOICE_MODEL && fs.existsSync(path.join(this.extensionUri.fsPath, 'dist', 'kitten', 'phonemize.mjs'));
  }

  /** The Git reel settings changed: the voices offered again; natural voices turned off (or another model) stop at once. */
  settingsChanged(): void {
    this.voice.voices = [];
    const model = voiceModel(this.voiceModelSetting());
    if (!this.naturalVoicesOn() || !model || !this.voiceModels.downloaded(model)) {
      this.kitten.use(undefined);
      if (!this.naturalVoicesOn() && KittenNarrator.isNatural(this.voice.name)) this.voice.name = undefined;
    } else this.useVoiceModel(model);
    void this.loadVoices().then(() => this.post());
  }
  private systemVoices: string[] = [];

  private narrationOff(): boolean {
    return vscode.workspace.getConfiguration('tsStructure.reel').get<string>('narrationVoice') === 'Off';
  }

  /** The voice to read with: the one picked in the player, else the Narration voice setting. */
  private chosenVoice(): string | undefined {
    const picked = this.listedVoice(this.voice.name);
    if (picked) return picked;
    // Settings written as "Kitten Jasper" by an earlier version read as "Jasper".
    const setting = vscode.workspace.getConfiguration('tsStructure.reel').get<string>('narrationVoice', DEFAULT_KITTEN_VOICE).replace(/^Kitten /, '');
    if (setting === 'System voice' || (KittenNarrator.isNatural(setting) && !this.naturalVoicesOn())) return this.systemVoices[0];
    return this.listedVoice(setting) ?? this.voice.voices[0];
  }

  /**
   * Records the clips: with a Kitten voice in the background, behind a "Generating narration…" notification that can
   * be cancelled (only the clips not made before); with the system voice at once. If the Kitten voice cannot run, the
   * system voice reads instead, and a short message says so.
   */
  private async record(items: { id: string; text: string }[], voiceName: string): Promise<VoiceClip[]> {
    const cache = path.join(this.storage, 'reel-voice');
    if (!KittenNarrator.isNatural(voiceName) || !this.naturalVoicesOn()) return speak(items, voiceName, cache);
    // A voice of a model on this computer ("Jasper (Mini)") speaks with that model.
    const named = VOICE_MODELS.find((m) => m.short === KittenNarrator.parse(voiceName).model);
    if (named && this.voiceModels.downloaded(named)) this.useVoiceModel(named);
    // Otherwise the model set, asked for now if none is downloaded yet.
    else if (!(await this.ensureVoiceModel())) {
      const fallback = this.systemVoices[0];
      if (!fallback) throw new Error('No voice model is downloaded, and no system voice was found.');
      this.voice.name = fallback;
      return speak(items, fallback, cache);
    }
    try {
      const missing = this.kitten.missing(items, voiceName, cache);
      if (!missing) return await this.kitten.speak(items, voiceName, cache);
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Generating narration…', cancellable: true },
        async (progress, token) => {
          progress.report({ message: `${missing} clip${missing === 1 ? '' : 's'}` });
          return this.kitten.speak(items, voiceName, cache, (done, total) => progress.report({ increment: 100 / total, message: `${done} of ${total}` }), () => token.isCancellationRequested);
        },
      );
    } catch (error) {
      const fallback = this.systemVoices[0];
      void showProblem(`The ${voiceName} voice could not run, so the system voice reads instead. ${error instanceof Error ? error.message : String(error)}`, [], 'info');
      if (!fallback) throw error;
      this.voice.name = fallback;
      return speak(items, fallback, cache);
    }
  }

  private async voiceOver(ids?: string[], post = true): Promise<void> {
    if (!this.plan) return;
    await this.loadVoices();
    if (!this.voice.voices.length) {
      this.voice.on = false;
      void showProblem(process.platform === 'linux' ? 'The voice-over needs espeak-ng (or espeak): install it, then turn the voice on again.' : 'No system voice was found for the voice-over.', [], 'info');
      if (post) this.post();
      return;
    }
    const scenes = this.plan.scenes.filter((s) => !ids || ids.includes(s.id));
    void this.panel?.webview.postMessage({ type: 'busy', text: 'Generating narration…' });
    try {
      const voiceName = this.chosenVoice() ?? this.voice.voices[0];
      const clips = await this.record(scenes.map((s) => ({ id: s.id, text: speakable(s.caption) })), voiceName);
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
      // Off in the Narration voice setting: no voice-over, and no button for it.
      voice: { on: this.voice.on && !this.narrationOff(), off: this.narrationOff(), name: this.chosenVoice() ?? this.voice.voices[0], voices: this.voice.voices, clips: this.voice.on && !this.narrationOff() ? this.voice.clips : {} },
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
