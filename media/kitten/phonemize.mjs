// SPDX-License-Identifier: GPL-3.0-or-later
//
// Code X-Ray's phonemizer process: text in, phonemes out, for the Kitten TTS voice-over.
//
// It runs eSpeak NG (GPL-3.0-or-later, https://github.com/espeak-ng/espeak-ng), built for JavaScript by
// phonemizer.js (https://github.com/xenova/phonemizer.js), so this program is GPL-3.0-or-later too: see
// GPL-3.0.txt and ESPEAK-NG-NOTICE.md next to it. It is a separate program: Code X-Ray (MIT) starts it and talks to it
// only through its standard input and output, one JSON line per request and per answer:
//   in:  {"id": 1, "text": "Returns 0 early."}
//   out: {"id": 1, "phonemes": "ɹᵻtˈɜːnz zˈiəɹoʊ ˈɜːli ."}
import { createInterface } from 'node:readline';
import { phonemize } from './phonemizer/phonemizer.js';

/** Phonemes for a text, its punctuation kept between the pieces (as the Kitten model expects). */
async function toPhonemes(text) {
  const parts = text.match(/[^,.;:!?]+|[,.;:!?]/g) ?? [];
  const out = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;
    if (/^[,.;:!?]$/.test(piece)) out.push(piece);
    else out.push((await phonemize(piece, 'en-us')).join(' '));
  }
  return out.join(' ').replace(/ ([,.;:!?])/g, '$1');
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const phonemes = await toPhonemes(String(request.text ?? ''));
    process.stdout.write(`${JSON.stringify({ id: request.id, phonemes })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request?.id, error: String(error?.message ?? error) })}\n`);
  }
}
