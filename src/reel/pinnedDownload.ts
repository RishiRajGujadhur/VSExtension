import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { fileMatches, fileUrl, ModelFile } from './codeModelText';

/**
 * The one place the extension downloads anything: models you chose to download (the code model, a voice model),
 * from Hugging Face only, each file pinned to one version of its repository and checked against its hash before it
 * is kept. A download is a plain request for a file: no cookie, token, name or code of yours goes with it.
 */

/** Hugging Face and the hosts it hands its files to. Nothing else is ever asked for. */
export function allowedHost(host: string): boolean {
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
}

/** Whether the files are in the folder, at their sizes. */
export function isDownloaded(dir: string, files: ModelFile[]): boolean {
  return files.every((f) => {
    try {
      return fs.statSync(path.join(dir, f.name)).size === f.size;
    } catch {
      return false;
    }
  });
}

/**
 * Downloads the files that are missing from the folder, each checked against its hash before it is kept.
 * `onProgress` is told the bytes so far; `cancelled` stops it between chunks.
 */
export async function downloadPinned(
  dir: string,
  files: ModelFile[],
  source: { repo: string; revision: string },
  onProgress?: (received: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const total = files.reduce((n, f) => n + f.size, 0);
  let received = 0;
  for (const file of files) {
    const target = path.join(dir, file.name);
    if (fs.existsSync(target) && fileMatches(file, fs.readFileSync(target))) {
      received += file.size;
      onProgress?.(received, total);
      continue;
    }
    const start = received;
    const bytes = await fetchPinned(fileUrl(file, source.repo, source.revision), (n) => onProgress?.(start + n, total), cancelled);
    if (!fileMatches(file, bytes)) throw new Error(`The downloaded ${file.name} is not the expected file (its hash differs), so it was not kept.`);
    const temp = `${target}.part`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
    received = start + file.size;
  }
}

/** GETs a pinned file, following Hugging Face's redirects (to its file storage), with no cookies or names. */
function fetchPinned(url: string, onBytes: (n: number) => void, cancelled?: () => boolean, hops = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !allowedHost(parsed.hostname)) return reject(new Error(`Models are only downloaded from Hugging Face, not ${parsed.hostname}.`));
    const request = https.get(parsed, { headers: { 'User-Agent': 'code-x-ray', Accept: '*/*' }, timeout: 30000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (hops >= 5) return reject(new Error('Too many redirects while downloading the model.'));
        resolve(fetchPinned(new URL(response.headers.location, parsed).href, onBytes, cancelled, hops + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`Hugging Face answered ${status} for the model.`));
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
    request.on('timeout', () => request.destroy(new Error('The download timed out.')));
    request.on('error', reject);
  });
}
