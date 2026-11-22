import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { parentPort, workerData } from 'worker_threads';
import { encode, KITTEN_VOICES, modelSpeed, readVoices, styleFor, trimEnd, VoiceTable } from './kittenModel';

/**
 * The Kitten TTS model, run in a worker thread so the editor never waits on it: ONNX Runtime Web (WebAssembly, one
 * thread) loads the bundled model once, then turns phonemes into samples, one clip at a time.
 * Bundled to dist/kittenWorker.js; workerData.home is dist/kitten (the runtime), workerData.model the downloaded model's folder.
 */

interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: { create(model: Uint8Array): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
}
interface Session {
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

// The runtime is bundled (dist/kitten); the model is the one you downloaded (its own folder in the extension's storage).
const { home, model, priors } = workerData as { home: string; model: string; priors: boolean };

// Everything the model needs is in the extension's folder: no request leaves this thread. A runtime that tried to
// fetch anything (a wasm file from a CDN, say) is refused here rather than allowed out.
const localFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/^(file|data|blob):/i.test(url)) return Promise.reject(new Error(`The voice model does not use the network (${new URL(url).host}).`));
  return localFetch(input, init);
}) as typeof fetch;
let ready: Promise<{ ort: Ort; session: Session; voices: Record<string, VoiceTable> }> | undefined;

function load() {
  ready ??= (async () => {
    const runtime = path.join(home, 'ort');
    // An ES module, loaded from its file: the bundle is CommonJS, and the runtime finds its .wasm next to it.
    const ort = (await import(pathToFileURL(path.join(runtime, 'ort.wasm.min.mjs')).href)) as Ort;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${pathToFileURL(runtime).href}/`;
    const session = await ort.InferenceSession.create(fs.readFileSync(path.join(model, 'model.onnx')));
    const voices = readVoices(fs.readFileSync(path.join(model, 'voices.npz')));
    return { ort, session, voices };
  })();
  return ready;
}

parentPort?.on('message', async (message: { id: number; phonemes: string; voice: string; pace?: number } | { id: number; warm: true }) => {
  try {
    const { ort, session, voices } = await load();
    if ('warm' in message) {
      parentPort?.postMessage({ id: message.id, ok: true });
      return;
    }
    const table = voices[KITTEN_VOICES[message.voice] ?? KITTEN_VOICES.Jasper];
    const tokens = encode(message.phonemes);
    const style = styleFor(table, tokens.length);
    const result = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]),
      style: new ort.Tensor('float32', style, [1, style.length]),
      speed: new ort.Tensor('float32', Float32Array.of(modelSpeed(message.voice, message.pace, priors)), [1]),
    });
    const key = session.outputNames.find((n) => /wave/i.test(n)) ?? session.outputNames[0];
    const samples = trimEnd(result[key].data);
    parentPort?.postMessage({ id: message.id, samples }, [samples.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
