// Minimal QR code generator — byte mode, ECC level L, versions 1–5
// (up to 106 bytes: plenty for invite URLs). Pure module, no DOM required,
// verified against an independent decoder in tests/qr.test.js.

const EC_L = 0b01;
const DATA_CODEWORDS = { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108 };
const ECC_CODEWORDS = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26 };
const BYTE_CAPACITY = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106 };

// ---- GF(256) arithmetic for Reed-Solomon ----
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse(); // highest degree first, [1, ...]
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---- Bit buffer ----
function makeBits() {
  const bits = [];
  return {
    bits,
    push(value, length) {
      for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    },
  };
}

function encodeData(bytes, version) {
  const bb = makeBits();
  bb.push(0b0100, 4);            // byte mode
  bb.push(bytes.length, 8);      // char count (8 bits for v1-9)
  for (const b of bytes) bb.push(b, 8);
  const capacityBits = DATA_CODEWORDS[version] * 8;
  bb.push(0, Math.min(4, capacityBits - bb.bits.length)); // terminator
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  const codewords = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
    codewords.push(b);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < DATA_CODEWORDS[version]) codewords.push(pads[p++ % 2]);
  return codewords.concat(rsRemainder(codewords, ECC_CODEWORDS[version]));
}

// ---- Matrix construction ----
function formatBits(mask) {
  const d = (EC_L << 3) | mask;
  let rem = d;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  return ((d << 10) | (rem & 0x3ff)) ^ 0x5412;
}

export function qrMatrix(text, forcedMask = null) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 0;
  for (const v of [1, 2, 3, 4, 5]) {
    if (bytes.length <= BYTE_CAPACITY[v]) { version = v; break; }
  }
  if (!version) throw new Error(`QR payload too long (${bytes.length} > 106 bytes)`);

  const size = 21 + 4 * (version - 1);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, dark) => { modules[r][c] = dark; isFunc[r][c] = true; };

  function drawFinder(r, c) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(rr, cc, dist !== 2 && dist !== 4);
      }
    }
  }
  drawFinder(3, 3);
  drawFinder(3, size - 4);
  drawFinder(size - 4, 3);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!isFunc[6][i]) set(6, i, i % 2 === 0);
    if (!isFunc[i][6]) set(i, 6, i % 2 === 0);
  }

  // Alignment pattern (versions 2–5 have exactly one, at size-7)
  if (version >= 2) {
    const ctr = size - 7;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        set(ctr + dr, ctr + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }

  // Reserve format info areas (values written after masking)
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { isFunc[8][i] = true; isFunc[i][8] = true; }
  }
  isFunc[8][8] = true;
  for (let i = 0; i < 8; i++) { isFunc[8][size - 1 - i] = true; isFunc[size - 1 - i][8] = true; }
  modules[size - 8][8] = true; // dark module
  isFunc[size - 8][8] = true;

  // Place data bits in the zigzag order
  const codewords = encodeData(bytes, version);
  const dataBits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!isFunc[row][c]) {
          modules[row][c] = bitIdx < dataBits.length ? dataBits[bitIdx] === 1 : false;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }

  // Try all 8 masks, keep the lowest penalty
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(m) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && MASKS[m](r, c)) modules[r][c] = !modules[r][c];
      }
    }
  }

  function writeFormat(mask) {
    const bits = formatBits(mask);
    const bit = (i) => ((bits >> i) & 1) === 1;
    // Copy 1 around the top-left finder: row arm carries b14..b9, column
    // arm carries b0..b5, corner cells b8/b7/b6 (ISO 18004 figure 25).
    for (let i = 0; i <= 5; i++) {
      modules[8][i] = bit(14 - i);
      modules[i][8] = bit(i);
    }
    modules[8][7] = bit(8);
    modules[8][8] = bit(7);
    modules[7][8] = bit(6);
    // Copy 2: b0..b7 right-to-left along the top-right row arm,
    // b14..b8 bottom-to-top up the lower-left column arm.
    for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
    for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = bit(14 - i);
    modules[size - 8][8] = true; // always-dark module
  }

  function penalty() {
    let score = 0;
    // N1: runs of same color >= 5 (rows and cols)
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const cur = axis ? modules[j][i] : modules[i][j];
          const prev = axis ? modules[j - 1][i] : modules[i][j - 1];
          if (cur === prev) {
            run++;
            if (j === size - 1 && run >= 5) score += run - 2;
          } else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
      }
    }
    // N2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
      }
    }
    // N3: finder-like 1011101 with 4 light on either side
    const pat = [true, false, true, true, true, false, true];
    const check = (get) => {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j + 11 <= size; j++) {
          let hitLead = true, hitTrail = true;
          for (let k = 0; k < 7; k++) {
            if (get(i, j + 4 + k) !== pat[k]) { hitLead = false; }
            if (get(i, j + k) !== pat[k]) { hitTrail = false; }
          }
          if (hitLead) {
            let light = true;
            for (let k = 0; k < 4; k++) if (get(i, j + k)) light = false;
            if (light) score += 40;
          }
          if (hitTrail) {
            let light = true;
            for (let k = 7; k < 11; k++) if (get(i, j + k)) light = false;
            if (light) score += 40;
          }
        }
      }
    };
    check((i, j) => modules[i][j]);
    check((i, j) => modules[j][i]);
    // N4: dark ratio
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  let bestMask = forcedMask ?? 0;
  if (forcedMask === null) {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      writeFormat(m);
      const s = penalty();
      if (s < bestScore) { bestScore = s; bestMask = m; }
      applyMask(m); // un-apply (XOR mask is its own inverse)
    }
  }
  applyMask(bestMask);
  writeFormat(bestMask);

  return { size, modules, version, mask: bestMask };
}

// Render as an SVG string (modules in currentColor, quiet zone included).
export function qrSvg(text) {
  const { size, modules } = qrMatrix(text);
  const quiet = 4;
  const total = size + quiet * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img"><path d="${path}" fill="currentColor"/></svg>`;
}
