import * as zlib from 'zlib';

/**
 * The pure parts of narrating with Kitten TTS Nano 0.8 (KittenML, Apache-2.0): its symbol table, the voices file, the
 * style row and speed for a voice, and the WAV the clip is written as. They follow the official KittenTTS-web engine
 * (engine/TextCleaner.ts and engine/TTSEngine.ts), so the model hears what it was trained on.
 */

/** The eight built-in voices, by name as people say it, with their key in voices.npz. */
export const KITTEN_VOICES: Record<string, string> = {
  Jasper: 'expr-voice-2-m',
  Bella: 'expr-voice-2-f',
  Luna: 'expr-voice-3-f',
  Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f',
  Hugo: 'expr-voice-4-m',
  Kiki: 'expr-voice-5-f',
  Leo: 'expr-voice-5-m',
};
export const DEFAULT_KITTEN_VOICE = 'Jasper';
export const SAMPLE_RATE = 24000;

const PAD = '$';
const PUNCTUATION = ';:,.!?¡¿—…"«»“” ';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const IPA =
  'ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝ' +
  'ɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟ' +
  'ɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁ' +
  'ɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔ' +
  'ʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞' +
  '↓↑→↗↘’̩‘ᵻ';
const INDEX = new Map([...(PAD + PUNCTUATION + LETTERS + IPA)].map((ch, i) => [ch.codePointAt(0)!, i]));

/** Phonemes to the model's tokens: start, the symbols it knows (others skipped), end, pad. */
export function encode(phonemes: string): number[] {
  const tokens = [0];
  for (const ch of phonemes) {
    const id = INDEX.get(ch.codePointAt(0)!);
    if (id !== undefined) tokens.push(id);
  }
  tokens.push(10, 0);
  return tokens;
}

/** The phonemizer's words and marks, spaced as the Python package's basic_english_tokenize does. */
export function spaceTokens(phonemes: string): string {
  return (phonemes.match(/[\p{L}\p{M}ʰ-˿ᴀ-ᶿⱱ]+|[^\s\p{L}\p{M}]/gu) ?? []).join(' ');
}

/** Text cut where the phonemizer must keep punctuation: the pieces between marks, and the marks. */
export function phonemeParts(text: string): { text: string; mark: boolean }[] {
  return (text.match(/[^,.;:!?]+|[,.;:!?]/g) ?? []).map((part) => ({ text: part.trim(), mark: /^[,.;:!?]$/.test(part) })).filter((p) => p.text);
}

export interface VoiceTable {
  rows: number;
  cols: number;
  data: Float32Array;
}

/** voices.npz: a zip of float32 .npy arrays, one per voice, [rows, 256]. */
export function readVoices(buf: Buffer): Record<string, VoiceTable> {
  const out: Record<string, VoiceTable> = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('voices.npz is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const npy = method === 8 ? zlib.inflateRawSync(raw) : raw;
    const headerLength = npy.readUInt16LE(8);
    const header = npy.toString('latin1', 10, 10 + headerLength);
    if (!/'descr': '<f4'/.test(header)) throw new Error(`${name}: not float32`);
    const shape = /'shape': \((\d+),\s*(\d+)/.exec(header);
    if (!shape) throw new Error(`${name}: no shape`);
    const bytes = npy.subarray(10 + headerLength);
    const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    out[name.replace(/\.npy$/, '')] = { rows: Number(shape[1]), cols: Number(shape[2]), data };
  }
  return out;
}

/** The voice's style for a text of this many tokens: its row for that length (the last row for longer ones). */
export function styleFor(table: VoiceTable, tokenCount: number): Float32Array {
  const row = Math.min(Math.max(0, tokenCount - 3), table.rows - 1);
  return table.data.slice(row * table.cols, (row + 1) * table.cols);
}

/**
 * The speed the model is given. The voices speak slowly at 1 (their priors are 0.8, Hugo 0.9); the reel's pace,
 * `pace`, is 1 for a natural speed.
 */
export function modelSpeed(voice: string, pace = 1): number {
  const prior = voice === 'Hugo' ? 0.9 : 0.8;
  return (pace / 0.8) * prior;
}

/** Silence at the end, up to a quarter of a second, cut. */
export function trimEnd(samples: Float32Array): Float32Array {
  const max = Math.round(0.25 * SAMPLE_RATE);
  let trim = 0;
  while (trim < max && trim < samples.length && Math.abs(samples[samples.length - 1 - trim]) <= 0.005) trim++;
  return trim && trim < samples.length ? samples.slice(0, samples.length - trim) : samples;
}

/** 16-bit mono PCM WAV. */
export function toWav(samples: Float32Array, rate = SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
