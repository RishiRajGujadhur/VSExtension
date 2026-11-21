import { createHash } from 'crypto';

/**
 * The parts of the code model that are plain code: the files it is made of (pinned and checked), the tokenizer it
 * reads with (BERT's WordPiece, lowercased), and the arithmetic on what it returns. The model itself runs in
 * codeModelWorker.ts.
 *
 * The model is all-MiniLM-L6-v2 (Apache-2.0, by the sentence-transformers team; the int8 ONNX export by Xenova): a
 * small sentence-embedding model. Code X-Ray turns a function's names into words ("addToCart" → "add to cart") and
 * asks the model which of a few plain descriptions of features ("adds an item to a cart or list", "shows a list of
 * items on screen"…) they are closest to, and which changes are closest to what the change is about (its title).
 */

export interface ModelFile {
  /** Path in the model's repository, and the file name it is kept under. */
  path: string;
  name: string;
  size: number;
  /** SHA-256 of the file (a file kept in Git LFS). */
  sha256?: string;
  /** Git's blob hash of the file (a file kept in Git itself). */
  gitSha1?: string;
}

export const CODE_MODEL = {
  repo: 'Xenova/all-MiniLM-L6-v2',
  /** The exact version downloaded: a commit of the repository, never "main". */
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  files: [
    { path: 'onnx/model_quantized.onnx', name: 'model_quantized.onnx', size: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
    { path: 'vocab.txt', name: 'vocab.txt', size: 231508, gitSha1: 'fb140275c155a9c7c5a3b3e0e77a9e839594a938' },
  ] as ModelFile[],
  /** What it adds on disk, for the prompt and the docs. */
  megabytes: 23.2,
};

/** Whether the bytes are the file pinned above. */
export function fileMatches(file: ModelFile, bytes: Buffer): boolean {
  if (bytes.length !== file.size) return false;
  if (file.sha256) return createHash('sha256').update(bytes).digest('hex') === file.sha256;
  if (file.gitSha1) return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === file.gitSha1;
  return false;
}

/** The download address of a pinned file. */
export function fileUrl(file: ModelFile): string {
  return `https://huggingface.co/${CODE_MODEL.repo}/resolve/${CODE_MODEL.revision}/${file.path}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The tokenizer: BERT's, uncased

export interface Vocab {
  ids: Map<string, number>;
  cls: number;
  sep: number;
  unk: number;
}

export function readVocab(text: string): Vocab {
  const ids = new Map<string, number>();
  text.split(/\r?\n/).forEach((token, i) => {
    if (token) ids.set(token, i);
  });
  const id = (t: string) => ids.get(t) ?? 0;
  return { ids, cls: id('[CLS]'), sep: id('[SEP]'), unk: id('[UNK]') };
}

const isPunctuation = (ch: string) => /[\p{P}\p{S}]/u.test(ch);

/** Lowercase, accents off, split on spaces and around punctuation. */
export function basicTokens(text: string): string[] {
  const clean = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[\u0000�\p{Cc}]/gu, ' ');
  const out: string[] = [];
  for (const word of clean.split(/\s+/)) {
    let current = '';
    for (const ch of word) {
      if (isPunctuation(ch)) {
        if (current) out.push(current);
        out.push(ch);
        current = '';
      } else current += ch;
    }
    if (current) out.push(current);
  }
  return out;
}

/** Each word as the longest pieces the vocabulary has, the later ones marked "##"; an unknown word is [UNK]. */
export function wordPieces(word: string, vocab: Vocab): number[] {
  if (word.length > 100) return [vocab.unk];
  const pieces: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found: number | undefined;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + word.slice(start, end);
      found = vocab.ids.get(piece);
      if (found !== undefined) break;
      end--;
    }
    if (found === undefined) return [vocab.unk];
    pieces.push(found);
    start = end;
  }
  return pieces;
}

/** The ids the model reads: [CLS], the pieces, [SEP]; at most `max` in all. */
export function tokenize(text: string, vocab: Vocab, max = 128): number[] {
  const ids = basicTokens(text).flatMap((w) => wordPieces(w, vocab));
  return [vocab.cls, ...ids.slice(0, max - 2), vocab.sep];
}

// ---------------------------------------------------------------------------------------------------------------
// What the model returns

/** The average of the token vectors where the mask is on, made unit length: the sentence's embedding. */
export function meanPool(hidden: Float32Array, tokens: number, width: number): Float32Array {
  const out = new Float32Array(width);
  for (let t = 0; t < tokens; t++) for (let d = 0; d < width; d++) out[d] += hidden[t * width + d];
  let norm = 0;
  for (let d = 0; d < width; d++) {
    out[d] /= tokens;
    norm += out[d] * out[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < width; d++) out[d] /= norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Code as the model reads best, as words: names split ("addToCart" → "add to cart"), strings and punctuation
 * left out, each word once, in order.
 */
export function codeAsWords(name: string | undefined, lines: string[], max = 40): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (w: string) => {
    const lower = w.toLowerCase();
    if (lower.length < 2 || seen.has(lower) || STOP.has(lower)) return;
    seen.add(lower);
    out.push(lower);
  };
  if (name) for (const w of words(name)) add(w);
  for (const line of lines) {
    const code = line.replace(/\/\/.*$|--.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ');
    for (const id of code.match(/[A-Za-z_$][\w$]*/g) ?? []) for (const w of words(id)) add(w);
    if (out.length >= max) break;
  }
  return out.slice(0, max).join(' ');
}

/** "addToCart" → ["add", "to", "Cart"]: kept here so the worker does not load the TypeScript compiler. */
function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_\-.$]+/).filter(Boolean);
}

const STOP = new Set('const let var function return if else for of in new this await async export import from true false null undefined void typeof instanceof class extends public private protected static readonly string number boolean any unknown as type interface the and or not is are be to a an it its'.split(' '));

/**
 * What downloading the code model sends, said before it happens: for the download prompts.
 */
export function downloadDisclosure(): string {
  return [
    `What the download sends: a request to huggingface.co for each of the model's two files (${CODE_MODEL.files.map((f) => f.name).join(' and ')}), which Hugging Face may redirect to its file storage. Like any download, this shows Hugging Face your IP address, and the request names the client as "code-x-ray".`,
    'It sends none of your code, file names, account details, tokens or settings.',
    'The files are checked against their published hashes, kept in the extension\'s storage, and the model then runs on your computer only. Remove it any time with "Git reel: remove the code model".',
  ].join('\n\n');
}
