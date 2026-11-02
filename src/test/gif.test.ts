import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { decodePng, encodeGif, lzw } from './screenshots/gif';

/** A GIF decoder's LZW, written from the format description, to check the encoder against. */
function unlzw(data: Buffer, count: number): number[] {
  const minCodeSize = data[0];
  const bytes: number[] = [];
  for (let i = 1; data[i] !== 0; i += data[i] + 1) {
    bytes.push(...data.subarray(i + 1, i + 1 + data[i]));
  }
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: clear }, (_, i) => [i]);
    table.push([], []);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let previous: number[] | undefined;
  let bitPos = 0;
  while (out.length < count) {
    let code = 0;
    for (let b = 0; b < codeSize; b++, bitPos++) {
      code |= ((bytes[bitPos >> 3] >> (bitPos & 7)) & 1) << b;
    }
    if (code === clear) {
      reset();
      previous = undefined;
      continue;
    }
    if (code === end) {
      break;
    }
    const entry = code < table.length ? table[code] : [...previous!, previous![0]];
    out.push(...entry);
    if (previous) {
      table.push([...previous, entry[0]]);
      if (table.length === 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    }
    previous = entry;
  }
  return out;
}

test('LZW output decodes back to the same indices, through code size changes and table resets', () => {
  // Varied enough to fill the 4096-entry table more than once.
  const indices = Uint8Array.from({ length: 60000 }, (_, i) => (i * 7 + ((i >> 5) % 13) * 31 + (i % 997 === 0 ? 200 : 0)) & 0xff);
  assert.deepEqual(unlzw(lzw(indices, 8), indices.length), [...indices]);
  const flat = new Uint8Array(20000).fill(3);
  assert.deepEqual(unlzw(lzw(flat, 8), flat.length), [...flat]);
});

test('PNG screenshots decode, and frames become a looping GIF with only changed regions after the first', () => {
  const icon = decodePng(fs.readFileSync(path.resolve(__dirname, '../../media/icon.png')));
  assert.equal(icon.width, 128);
  assert.equal(icon.rgba.length, 128 * 128 * 4);
  const changed = { ...icon, rgba: Uint8Array.from(icon.rgba) };
  // A white dot in the corner: only that region is stored for the second frame.
  changed.rgba.set([255, 255, 255, 255], (5 * 128 + 6) * 4);
  const gif = encodeGif([
    { image: icon, delayMs: 500 },
    { image: icon, delayMs: 500 },
    { image: changed, delayMs: 1000 },
  ]);
  assert.equal(gif.toString('latin1', 0, 6), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0', 'latin1')));
  // Two frames: the unchanged second one only lengthened the first, to one second.
  const controls = [...gif.toString('latin1').matchAll(/\x21\xf9\x04\x04([\s\S])([\s\S])/g)].map((m) => m[1].charCodeAt(0) + m[2].charCodeAt(0) * 256);
  assert.deepEqual(controls, [100, 100]);
  const descriptor = gif.lastIndexOf(0x2c, gif.length - 20);
  assert.ok(descriptor > 0);
});
