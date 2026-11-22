import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { Worker } from 'worker_threads';
import { KITTEN_VOICES, phonemeParts, spaceTokens, toWav } from './kittenModel';
import { VoiceClip, wavSeconds } from './voice';

/**
 * The environment the phonemizer runs with: enough for Node to start (and the system's temporary folder and locale),
 * nothing else from the editor's environment.
 */
export function phonemizerEnvironment(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS'];
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of keep) if (from[key] !== undefined) env[key] = from[key];
  return env;
}

/**
 * The bundled Kitten TTS voice-over: text → phonemes in the eSpeak NG phonemizer (its own GPL program, started once
 * and kept), phonemes → audio in the Kitten model (a worker thread, so the editor never waits), each clip kept in a
 * cache by voice and text. `home` is dist/kitten; `workerFile` is dist/kittenWorker.js.
 */
export class KittenNarrator {
  private worker: Worker | undefined;
  private phonemizer: ChildProcess | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly home: string,
    private readonly workerFile: string,
  ) {}

  /** The voice model it speaks with: one you downloaded (its folder), or none yet. */
  private model: { id: string; dir: string; priors: boolean } | undefined;

  /** Speaks with this model from now on (a different one restarts the worker). */
  use(model: { id: string; dir: string; priors: boolean } | undefined): void {
    if (model?.id === this.model?.id && model?.dir === this.model?.dir) return;
    void this.worker?.terminate();
    this.worker = undefined;
    this.model = model;
  }

  /** Whether a downloaded model is set, and the bundled runtime and phonemizer are there. */
  get available(): boolean {
    return !!this.model && fs.existsSync(path.join(this.model.dir, 'model.onnx')) && fs.existsSync(path.join(this.home, 'phonemize.mjs')) && fs.existsSync(this.workerFile);
  }

  /** The natural voices by name, as the voice picker shows them: "Jasper", "Bella"… */
  static voices(): string[] {
    return Object.keys(KITTEN_VOICES);
  }

  /** Whether a voice is one of the natural voices (an older "Kitten Jasper" counts as "Jasper"). */
  static isNatural(name: string | undefined): boolean {
    return !!name && !!KITTEN_VOICES[name.replace(/^Kitten /, '')];
  }

  /**
   * Records each text with the voice ("Jasper"), using the cache in `cacheDir`; `onClip` is told after each
   * one made, and `cancelled` stops between clips.
   */
  async speak(items: { id: string; text: string }[], voiceName: string, cacheDir: string, onClip?: (done: number, total: number) => void, cancelled?: () => boolean): Promise<VoiceClip[]> {
    const voice = voiceName.replace(/^Kitten /, '');
    if (!KITTEN_VOICES[voice]) throw new Error(`No natural voice called ${voice}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = (text: string) => this.clipFile(cacheDir, voice, text);
    const missing = items.filter((i) => i.text.trim() && !fs.existsSync(target(i.text)));
    let done = 0;
    for (const item of missing) {
      if (cancelled?.()) break;
      const phonemes = await this.phonemes(item.text);
      const samples = (await this.ask({ phonemes, voice })) as Float32Array;
      fs.writeFileSync(target(item.text), toWav(samples));
      onClip?.(++done, missing.length);
    }
    return items
      .filter((i) => i.text.trim() && fs.existsSync(target(i.text)))
      .map((i) => {
        const wav = fs.readFileSync(target(i.text));
        return { id: i.id, seconds: wavSeconds(wav), wav };
      });
  }

  /** How many of these texts still need recording with the voice: for saying how long it will take. */
  missing(items: { text: string }[], voiceName: string, cacheDir: string): number {
    const voice = voiceName.replace(/^Kitten /, '');
    return items.filter((i) => i.text.trim() && !fs.existsSync(this.clipFile(cacheDir, voice, i.text))).length;
  }

  /** A clip, kept by the model, the voice and the text: another model records its own. */
  private clipFile(cacheDir: string, voice: string, text: string): string {
    return path.join(cacheDir, `kitten-${createHash('sha1').update(`${this.model?.id ?? 'none'}\n${voice}\n${text}`).digest('hex').slice(0, 20)}.wav`);
  }

  /** Text to the phonemes the model reads: the phonemizer's output, spaced into words and marks. */
  async phonemes(text: string): Promise<string> {
    if (!phonemeParts(text).length) return '';
    const reply = (await this.askPhonemizer(text)) as { phonemes?: string; error?: string };
    if (reply.error) throw new Error(`The phonemizer failed: ${reply.error}`);
    return spaceTokens(reply.phonemes ?? '');
  }

  /** Loads the model now, so the first clip does not wait for it. */
  async warm(): Promise<void> {
    await this.ask({ warm: true });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.phonemizer?.kill();
    this.worker = undefined;
    this.phonemizer = undefined;
    for (const w of this.waiting.values()) w.reject(new Error('The narrator was stopped.'));
    this.waiting.clear();
  }

  private ask(message: Record<string, unknown>): Promise<unknown> {
    if (!this.worker) {
      if (!this.model) return Promise.reject(new Error('No voice model is downloaded.'));
      const worker = new Worker(this.workerFile, { workerData: { home: this.home, model: this.model.dir, priors: this.model.priors } });
      worker.on('message', (reply: { id: number; samples?: Float32Array; ok?: boolean; error?: string }) => {
        const w = this.waiting.get(reply.id);
        if (!w) return;
        this.waiting.delete(reply.id);
        if (reply.error) w.reject(new Error(reply.error));
        else w.resolve(reply.samples ?? reply.ok);
      });
      worker.on('error', (error) => this.failAll(error));
      worker.on('exit', () => {
        this.worker = undefined;
        this.failAll(new Error('The Kitten model stopped.'));
      });
      this.worker = worker;
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, ...message });
    });
  }

  private askPhonemizer(text: string): Promise<unknown> {
    if (!this.phonemizer) {
      // A separate program (GPL, see dist/kitten/ESPEAK-NG-NOTICE.md): the editor's own Node, as plain Node. It gets
      // only the environment it needs to run, never the rest (tokens, keys and the like in environment variables).
      const child = spawn(process.execPath, [path.join(this.home, 'phonemize.mjs')], {
        env: phonemizerEnvironment(),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      createInterface({ input: child.stdout! }).on('line', (line) => {
        let reply: { id?: number };
        try {
          reply = JSON.parse(line);
        } catch {
          return;
        }
        const w = reply.id !== undefined ? this.waiting.get(reply.id) : undefined;
        if (!w) return;
        this.waiting.delete(reply.id!);
        w.resolve(reply);
      });
      child.on('exit', () => {
        this.phonemizer = undefined;
        this.failAll(new Error('The phonemizer stopped.'));
      });
      child.on('error', (error) => this.failAll(error));
      this.phonemizer = child;
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.phonemizer!.stdin!.write(`${JSON.stringify({ id, text })}\n`);
    });
  }

  private failAll(error: Error): void {
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
  }
}
