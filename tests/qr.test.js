// QR generator verified against an independent decoder (jsQR).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { qrMatrix, qrSvg } from '../public/js/qr.js';

const require = createRequire(import.meta.url);
let jsQR = null;
try { jsQR = require('jsqr'); } catch { /* devDependency missing: decode tests skip */ }

function rasterize(matrix, scale = 4, quiet = 4) {
  const size = (matrix.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  rgba.fill(255);
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const i = (y * size + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
  }
  return { rgba, size };
}

const SAMPLES = [
  'https://echo.example/j/ABC234',
  'HELLO',
  'https://echo-app.example.com:8443/j/XYZW29?ref=qr',
  'x'.repeat(100), // forces version 5
];

test('matrix shape and version selection', () => {
  const small = qrMatrix('HELLO');
  assert.equal(small.version, 1);
  assert.equal(small.size, 21);
  const big = qrMatrix('x'.repeat(100));
  assert.equal(big.version, 5);
  assert.equal(big.size, 37);
  assert.throws(() => qrMatrix('x'.repeat(200)));
});

test('svg output is well-formed', () => {
  const svg = qrSvg('https://echo.example/j/ABC234');
  assert.match(svg, /^<svg /);
  assert.match(svg, /fill="currentColor"/);
});

for (const sample of SAMPLES) {
  test(`decodes with jsQR: ${sample.slice(0, 40)}…`, (t) => {
    if (!jsQR) return t.skip('jsqr not installed');
    const { rgba, size } = rasterize(qrMatrix(sample));
    const decoded = jsQR(rgba, size, size);
    assert.ok(decoded, 'decoder found no QR code');
    assert.equal(decoded.data, sample);
  });
}
