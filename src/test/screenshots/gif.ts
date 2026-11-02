import * as zlib from 'zlib';

/** An RGBA image. */
export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decodes the 8-bit RGB or RGBA, non-interlaced PNGs that Chromium's screenshots are. */
export function decodePng(png: Buffer): Image {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) {
        throw new Error('Only 8-bit, non-interlaced RGB or RGBA PNGs are supported.');
      }
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[out + x] = (line[x] + predictor) & 0xff;
    }
  }
  if (channels === 4) {
    return { width, height, rgba: pixels };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** 15-bit color of a pixel, the key of the palette lookup. */
const key = (rgba: Uint8Array, i: number) => ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);

/**
 * A palette of at most 256 colors for all frames, by median cut over a 15-bit histogram, and a table
 * from each 15-bit color to its nearest palette entry. Screenshots of an editor have few colors, so
 * one shared palette without dithering keeps text crisp.
 */
export function buildPalette(images: readonly Image[]): { palette: number[][]; lookup: Uint8Array } {
  const counts = new Uint32Array(1 << 15);
  for (const image of images) {
    for (let i = 0; i < image.rgba.length; i += 4) {
      counts[key(image.rgba, i)]++;
    }
  }
  const colors = [...counts.keys()].filter((c) => counts[c] > 0);
  const channel = (c: number, ch: number) => (c >> (10 - ch * 5)) & 31;
  let boxes = [colors];
  while (boxes.length < 256) {
    // Split the box with the widest channel range, weighted by how many pixels it holds.
    let best = -1;
    let bestScore = 0;
    let bestChannel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) {
        return;
      }
      for (let ch = 0; ch < 3; ch++) {
        let min = 31;
        let max = 0;
        let pixels = 0;
        for (const c of box) {
          const v = channel(c, ch);
          min = Math.min(min, v);
          max = Math.max(max, v);
          pixels += counts[c];
        }
        const score = (max - min) * Math.sqrt(pixels);
        if (score > bestScore) {
          [best, bestScore, bestChannel] = [index, score, ch];
        }
      }
    });
    if (best < 0) {
      break;
    }
    const box = boxes[best].sort((a, b) => channel(a, bestChannel) - channel(b, bestChannel));
    let half = 0;
    let seen = 0;
    const total = box.reduce((n, c) => n + counts[c], 0);
    while (half < box.length - 1 && seen + counts[box[half]] <= total / 2) {
      seen += counts[box[half++]];
    }
    half = Math.max(1, half);
    boxes = [...boxes.slice(0, best), box.slice(0, half), box.slice(half), ...boxes.slice(best + 1)];
  }
  const palette = boxes.map((box) => {
    const sum = [0, 0, 0];
    let n = 0;
    for (const c of box) {
      for (let ch = 0; ch < 3; ch++) {
        sum[ch] += ((channel(c, ch) << 3) | 4) * counts[c];
      }
      n += counts[c];
    }
    return sum.map((s) => Math.round(s / Math.max(1, n)));
  });
  const lookup = new Uint8Array(1 << 15);
  for (let c = 0; c < lookup.length; c++) {
    const rgb = [0, 1, 2].map((ch) => (channel(c, ch) << 3) | 4);
    let nearest = 0;
    let distance = Infinity;
    palette.forEach((p, i) => {
      const d = (p[0] - rgb[0]) ** 2 * 2 + (p[1] - rgb[1]) ** 2 * 4 + (p[2] - rgb[2]) ** 2 * 3;
      if (d < distance) {
        [nearest, distance] = [i, d];
      }
    });
    lookup[c] = nearest;
  }
  return { palette, lookup };
}

/** GIF's variable-length LZW for one frame's palette indices. */
export function lzw(indices: Uint8Array, minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const write = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  let table = new Map<number, number>();
  let next = end + 1;
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const entry = (prefix << 8) | k;
    const code = table.get(entry);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    write(prefix);
    if (next < 4096) {
      table.set(entry, next++);
      // Decoders add each entry one code later than this, so widen one entry after the table fills the size.
      if (next > 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    } else {
      write(clear);
      table = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(end);
  if (bitCount > 0) {
    bytes.push(bits & 0xff);
  }
  // Data sub-blocks of at most 255 bytes, ended by an empty one.
  const blocks: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Buffer.concat([Buffer.from([minCodeSize]), Buffer.from(blocks)]);
}

/**
 * An animated GIF of the frames, looping. After the first frame only the rectangle that changed is
 * stored, and a frame that changes nothing just lengthens the one before it.
 */
export function encodeGif(frames: readonly { image: Image; delayMs: number }[]): Buffer {
  const { width, height } = frames[0].image;
  const { palette, lookup } = buildPalette(frames.map((f) => f.image));
  const indexed = frames.map((f) => {
    const out = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      out[p] = lookup[key(f.image.rgba, i)];
    }
    return out;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7; // global color table of 256 entries
  parts.push(header);
  const table = Buffer.alloc(256 * 3);
  palette.forEach((p, i) => table.set(p, i * 3));
  parts.push(table);
  // Loop forever (NETSCAPE2.0 application extension).
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]));

  type Region = { x: number; y: number; w: number; h: number; delay: number; pixels: Uint8Array };
  const regions: Region[] = [];
  indexed.forEach((pixels, f) => {
    let [x0, y0, x1, y1] = [0, 0, width - 1, height - 1];
    if (f > 0) {
      const before = indexed[f - 1];
      [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (pixels[y * width + x] !== before[y * width + x]) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      }
      if (x1 < 0) {
        regions[regions.length - 1].delay += frames[f].delayMs;
        return;
      }
    }
    const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
    const crop = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      crop.set(pixels.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w);
    }
    regions.push({ x: x0, y: y0, w, h, delay: frames[f].delayMs, pixels: crop });
  });
  for (const region of regions) {
    const delay = Math.max(2, Math.round(region.delay / 10));
    // Graphic control: keep the frame in place (disposal 1), delay in hundredths of a second.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, delay & 0xff, delay >> 8, 0x00, 0x00]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(region.x, 1);
    descriptor.writeUInt16LE(region.y, 3);
    descriptor.writeUInt16LE(region.w, 5);
    descriptor.writeUInt16LE(region.h, 7);
    parts.push(descriptor, lzw(region.pixels, 8));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
