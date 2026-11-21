import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { parentPort, workerData } from 'worker_threads';
import { meanPool, readVocab, tokenize, Vocab } from './codeModelText';

/**
 * The code model, run in a worker thread so the editor never waits on it: ONNX Runtime Web (WebAssembly, one thread,
 * the copy bundled for the voices) loads all-MiniLM-L6-v2 once, then turns texts into embeddings.
 * Bundled to dist/codeModelWorker.js. workerData.model is the folder the model was downloaded to; workerData.ort is
 * the runtime's folder (dist/kitten/ort).
 */

interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: { create(model: Uint8Array): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
}
interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

const { model, ort: runtime } = workerData as { model: string; ort: string };

// The model reads files from disk only: no request leaves this thread. The download is done before, by the
// extension, when you agree to it.
const localFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/^(file|data|blob):/i.test(url)) return Promise.reject(new Error(`The code model does not use the network (${new URL(url).host}).`));
  return localFetch(input, init);
}) as typeof fetch;

let ready: Promise<{ ort: Ort; session: Session; vocab: Vocab }> | undefined;
function load() {
  ready ??= (async () => {
    const ort = (await import(pathToFileURL(path.join(runtime, 'ort.wasm.min.mjs')).href)) as Ort;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${pathToFileURL(runtime).href}/`;
    const session = await ort.InferenceSession.create(fs.readFileSync(path.join(model, 'model_quantized.onnx')));
    const vocab = readVocab(fs.readFileSync(path.join(model, 'vocab.txt'), 'utf8'));
    return { ort, session, vocab };
  })();
  return ready;
}

parentPort?.on('message', async (message: { id: number; texts: string[] }) => {
  try {
    const { ort, session, vocab } = await load();
    const vectors: Float32Array[] = [];
    // One text at a time: no padding to think about, and the texts are short.
    for (const text of message.texts) {
      const ids = tokenize(text, vocab);
      const n = ids.length;
      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
      };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
      const result = await session.run(feeds);
      const out = result[session.outputNames.find((name) => /last_hidden_state/.test(name)) ?? session.outputNames[0]];
      vectors.push(meanPool(out.data, n, out.dims[out.dims.length - 1]));
    }
    parentPort?.postMessage({ id: message.id, vectors });
  } catch (error) {
    parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
