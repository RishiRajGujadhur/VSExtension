// Draws media/icon.png, the Marketplace icon: the activity bar glyph (media/structure.svg) in white on a
// TypeScript-blue rounded square. No image library: shapes are drawn by distance with anti-aliased edges.
// Usage: node scripts/icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const size = 128;
// The glyph's 24-unit viewBox, scaled into the square with a margin.
const scale = 4.2;
const offset = (size - 24 * scale) / 2;
const stroke = (1.9 * scale) / 2;

// The shapes of media/structure.svg: three rounded boxes and the connectors between them.
const boxes = [
  { x: 3, y: 3, w: 7, h: 5, r: 1 },
  { x: 14, y: 10, w: 7, h: 5, r: 1 },
  { x: 14, y: 17, w: 7, h: 4, r: 1 },
];
const lines = [
  [6.5, 8, 6.5, 12.5],
  [6.5, 12.5, 14, 12.5],
  [6.5, 12.5, 6.5, 19],
  [6.5, 19, 14, 19],
];

const at = (v) => offset + v * scale;

/** Distance from a point to the outline of a rounded box. */
function boxOutline(px, py, b) {
  const cx = at(b.x + b.w / 2);
  const cy = at(b.y + b.h / 2);
  const hw = (b.w * scale) / 2;
  const hh = (b.h * scale) / 2;
  const r = b.r * scale;
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.abs(outside);
}

function segment(px, py, [x1, y1, x2, y2]) {
  const [ax, ay, bx, by] = [at(x1), at(y1), at(x2), at(y2)];
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

/** Distance outside the background's rounded square (negative inside). */
function background(px, py) {
  const r = 26;
  const q = Math.abs(px - size / 2) - size / 2 + r + 2;
  const qy = Math.abs(py - size / 2) - size / 2 + r + 2;
  return Math.hypot(Math.max(q, 0), Math.max(qy, 0)) + Math.min(Math.max(q, qy), 0) - r;
}

const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance));

const pixels = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const bg = coverage(background(px, py));
    const glyphDistance = Math.min(...boxes.map((b) => boxOutline(px, py, b)), ...lines.map((l) => segment(px, py, l))) - stroke;
    const glyph = coverage(glyphDistance);
    // A top-to-bottom gradient from TypeScript blue to a deeper blue.
    const t = y / size;
    const base = [49 + (22 - 49) * t, 120 + (84 - 120) * t, 198 + (160 - 198) * t];
    const color = base.map((c) => c + (255 - c) * glyph);
    const i = (y * size + x) * 4;
    pixels[i] = Math.round(color[0]);
    pixels[i + 1] = Math.round(color[1]);
    pixels[i + 2] = Math.round(color[2]);
    pixels[i + 3] = Math.round(255 * bg);
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const raw = Buffer.concat(Array.from({ length: size }, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4)])));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.resolve(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
