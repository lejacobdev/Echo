// Generates Echo's PNG app icons from scratch (zero dependencies):
// concentric echo rings on a dark rounded square. Writes valid RGBA PNGs
// using node:zlib for the IDAT stream. Run: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- Minimal PNG encoder ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(file, size, pixels /* RGBA Uint8Array */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.subarray(y * size * 4, (y + 1) * size * 4)
      .forEach((v, i) => { raw[y * (size * 4 + 1) + 1 + i] = v; });
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.basename(file)} (${size}x${size}, ${png.length} bytes)`);
}

// ---- Icon art ----
const BG = [20, 20, 19];
const TEAL = [51, 198, 183];
const BLUE = [124, 161, 255];

function lerp(a, b, u) { return a + (b - a) * u; }

function mix(c1, c2, u) {
  return [lerp(c1[0], c2[0], u), lerp(c1[1], c2[1], u), lerp(c1[2], c2[2], u)];
}

// Signed distance to a rounded square (for corner masking).
function roundedRectAlpha(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const dist = Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function ringAlpha(dist, radius, width) {
  return Math.max(0, 1 - Math.abs(dist - radius) / width);
}

function drawIcon(size, { maskable = false, rounded = true } = {}) {
  const px = new Uint8Array(size * size * 4);
  const center = size / 2;
  // Maskable icons need the art inside the inner 80% safe zone.
  const scale = maskable ? 0.72 : 0.92;
  const rings = [0.14, 0.30, 0.46].map((r) => r * size * scale);
  const ringW = size * 0.035;
  const dotR = size * 0.055 * scale;
  const cornerR = maskable || !rounded ? 0 : size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const shape = cornerR ? roundedRectAlpha(x + 0.5, y + 0.5, size, cornerR) : 1;
      const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);

      // Background with a subtle vertical gradient
      const g = y / size;
      let [r, gr, b] = mix(BG, [BG[0] + 10, BG[1] + 14, BG[2] + 22], g);

      // Rings: teal core fading to blue outward
      rings.forEach((radius, idx) => {
        const a = ringAlpha(d, radius, ringW) * (1 - idx * 0.28);
        if (a > 0) {
          const col = mix(TEAL, BLUE, idx / 2);
          r = lerp(r, col[0], a);
          gr = lerp(gr, col[1], a);
          b = lerp(b, col[2], a);
        }
      });
      // Center dot
      const dotA = Math.max(0, Math.min(1, dotR - d + 0.5));
      if (dotA > 0) {
        r = lerp(r, TEAL[0], dotA);
        gr = lerp(gr, TEAL[1], dotA);
        b = lerp(b, TEAL[2], dotA);
      }

      px[i] = Math.round(r);
      px[i + 1] = Math.round(gr);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * shape);
    }
  }
  return px;
}

writePng(path.join(OUT, 'icon-192.png'), 192, drawIcon(192));
writePng(path.join(OUT, 'icon-512.png'), 512, drawIcon(512));
writePng(path.join(OUT, 'icon-maskable-512.png'), 512, drawIcon(512, { maskable: true }));
writePng(path.join(OUT, 'apple-touch-icon.png'), 180, drawIcon(180, { rounded: false }));
