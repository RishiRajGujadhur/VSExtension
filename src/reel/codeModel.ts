import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CODE_MODEL, fileMatches, fileUrl } from './codeModelText';

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
    return CODE_MODEL.files.every((f) => {
      try {
        return fs.statSync(path.join(this.dir, f.name)).size === f.size;
      } catch {
        return false;
      }
    });
  }

  get runnable(): boolean {
    return this.downloaded && fs.existsSync(this.workerFile) && fs.existsSync(path.join(this.ortDir, 'ort.wasm.min.mjs'));
  }

  /**
   * Downloads the model's files that are missing, each checked against its hash before it is kept. `onProgress` is
   * told the bytes so far; `cancelled` stops it between chunks.
   */
  async download(onProgress?: (received: number, total: number) => void, cancelled?: () => boolean): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const total = CODE_MODEL.files.reduce((n, f) => n + f.size, 0);
    let received = 0;
    for (const file of CODE_MODEL.files) {
      const target = path.join(this.dir, file.name);
      if (fs.existsSync(target) && fileMatches(file, fs.readFileSync(target))) {
        received += file.size;
        onProgress?.(received, total);
        continue;
      }
      const start = received;
      const bytes = await fetchPinned(fileUrl(file), (n) => onProgress?.(start + n, total), cancelled);
      if (!fileMatches(file, bytes)) throw new Error(`The downloaded ${file.name} is not the expected file (its hash differs), so it was not kept.`);
      const temp = `${target}.part`;
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, target);
      received = start + file.size;
    }
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

/** Hugging Face and the hosts it hands its files to. Nothing else is ever asked for. */
export function allowedHost(host: string): boolean {
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
}

/** GETs a pinned model file, following Hugging Face's redirects (to its file storage), with no cookies or names. */
function fetchPinned(url: string, onBytes: (n: number) => void, cancelled?: () => boolean, hops = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !allowedHost(parsed.hostname)) return reject(new Error(`The code model is only downloaded from Hugging Face, not ${parsed.hostname}.`));
    const request = https.get(parsed, { headers: { 'User-Agent': 'code-x-ray', Accept: '*/*' }, timeout: 30000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (hops >= 5) return reject(new Error('Too many redirects while downloading the code model.'));
        resolve(fetchPinned(new URL(response.headers.location, parsed).href, onBytes, cancelled, hops + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`Hugging Face answered ${status} for the code model.`));
      }
      const chunks: Buffer[] = [];
      let n = 0;
      response.on('data', (chunk: Buffer) => {
        if (cancelled?.()) {
          request.destroy(new Error('The download was cancelled.'));
          return;
        }
        chunks.push(chunk);
        n += chunk.length;
        onBytes(n);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('The download of the code model timed out.')));
    request.on('error', reject);
  });
}
