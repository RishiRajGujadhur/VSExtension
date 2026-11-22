import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CODE_MODEL } from './codeModelText';
import { downloadPinned, isDownloaded } from './pinnedDownload';

/**
 * The code model on this computer: downloaded once, when you agree to it, from Hugging Face (two files, pinned to
 * one version and checked against their hashes), then run offline in a worker thread. Nothing about your code is
 * sent: the download is a plain request for the model's files, and the model only reads what it is given here.
 */
export class CodeModel {
  private worker: Worker | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  /**
   * `dir` is where the model is kept (the extension's storage), `workerFile` dist/codeModelWorker.js, `ortDir` the
   * runtime's folder (dist/kitten/ort).
   */
  constructor(
    private readonly dir: string,
    private readonly workerFile: string,
    private readonly ortDir: string,
  ) {}

  /** Whether the model is downloaded (its files there, at their sizes) and can run here. */
  get downloaded(): boolean {
    return isDownloaded(this.dir, CODE_MODEL.files);
  }

  get runnable(): boolean {
    return this.downloaded && fs.existsSync(this.workerFile) && fs.existsSync(path.join(this.ortDir, 'ort.wasm.min.mjs'));
  }

  /**
   * Downloads the model's files that are missing, each checked against its hash before it is kept. `onProgress` is
   * told the bytes so far; `cancelled` stops it between chunks.
   */
  async download(onProgress?: (received: number, total: number) => void, cancelled?: () => boolean): Promise<void> {
    await downloadPinned(this.dir, CODE_MODEL.files, CODE_MODEL, onProgress, cancelled);
  }

  /** Removes the downloaded model. */
  remove(): void {
    this.dispose();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** The embeddings of the texts: unit vectors, one per text. */
  embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    if (!this.worker) {
      const worker = new Worker(this.workerFile, { workerData: { model: this.dir, ort: this.ortDir } });
      worker.on('message', (reply: { id: number; vectors?: Float32Array[]; error?: string }) => {
        const w = this.waiting.get(reply.id);
        if (!w) return;
        this.waiting.delete(reply.id);
        if (reply.error) w.reject(new Error(reply.error));
        else w.resolve(reply.vectors ?? []);
      });
      worker.on('error', (error) => this.failAll(error));
      worker.on('exit', () => {
        this.worker = undefined;
        this.failAll(new Error('The code model stopped.'));
      });
      this.worker = worker;
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, texts });
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
    this.failAll(new Error('The code model was stopped.'));
  }

  private failAll(error: Error): void {
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
  }
}
