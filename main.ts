// png-squeeze-01 — lossless PNG squeezer, revision 5.
// Written from scratch in this session. Reads 1280x720 RGBA screenshots
// from MAKEFUN_INPUT_DIR (default /input), writes the smallest lossless PNG
// it can find to MAKEFUN_OUTPUT_DIR. Strategy: own PNG decoder/encoder,
// colour-type reduction (palette / grey / grey+alpha / RGB / RGBA / tRNS
// key), per-row filter search (fixed, min-sum, fewest-pairs, brute-force
// deflate trials), zlib screening at level 6 and a level-9 final re-encode
// over several strategies PLUS the program's own optimal-parse DEFLATE
// encoder (deep hash-chain match search, 2-pass DP); the smallest stream
// ships. Fully deterministic.
import { inflateSync, deflateSync, constants as zconst } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC-32 (PNG) ----------
const CRC_TAB = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG writer ----------
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function ihdrData(width: number, height: number, ct: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = ct;
  return d;
}
function assemblePng(width: number, height: number, ct: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [SIG, chunkBytes('IHDR', ihdrData(width, height, ct))];
  if (plte !== null) parts.push(chunkBytes('PLTE', plte));
  if (trns !== null) parts.push(chunkBytes('tRNS', trns));
  parts.push(chunkBytes('IDAT', idat));
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- PNG decoder (type 6 stored input, but handles any accepted type) ----------
function paethPredict(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
const CHANS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function decodePngFile(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0; let height = 0; let ct = 6;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4); ct = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const bpp = CHANS[ct];
  const stride = width * bpp;
  const idat = idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts);
  const raw = inflateSync(idat);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride; const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paethPredict(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (ct === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = (palette as Uint8Array)[e * 3];
      rgba[d + 1] = (palette as Uint8Array)[e * 3 + 1];
      rgba[d + 2] = (palette as Uint8Array)[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- image analysis ----------
type ColourRec = { r: number; g: number; b: number; a: number; word: number; count: number };
function analyseImage(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: ColourRec[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true; let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = (((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true; else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: ColourRec[] = [];
  for (const [w, c] of counts) {
    colours.push({ r: (w >>> 24) & 255, g: (w >>> 16) & 255, b: (w >>> 8) & 255, a: w & 255, word: w, count: c });
  }
  return { opaque, grey, colours };
}
function findTransparentKey(rgba: Uint8Array, grey: boolean): number {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

// ---------- forms ----------
type Form = { ct: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; filters: (number | string)[] };
function luminanceOf(c: ColourRec): number { return 299 * c.r + 587 * c.g + 114 * c.b; }
function buildPalette(rgba: Uint8Array, colours: ColourRec[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0; const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminanceOf(x) - luminanceOf(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const w = (((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
    indices[i] = index.get(w) as number;
  }
  return { plte, trns, indices };
}
function samplesFor(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function enumerateForms(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyseImage(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance'] as const) {
      const p = buildPalette(rgba, colours, order);
      forms.push({
        ct: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? -1 : findTransparentKey(rgba, grey);
  let ct: number; let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  forms.push({ ct, bpp, samples: samplesFor(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ---------- filters ----------
function filterOne(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paethPredict(a, b, c);
  }
}
function signedAbsSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
function pairCount(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}
const BRUTE_CTX = 32768;
function filterSamples(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string, raw?: Uint8Array): Uint8Array {
  const stride = width * bpp;
  const out = raw ?? new Uint8Array(height * (stride + 1));
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) { const r = new Uint8Array(stride + 1); r[0] = t; trials.push(r); }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterOne(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = out.subarray(Math.max(0, at - BRUTE_CTX), at);
    let type = 0; let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterOne(t, cur, prev, bpp, trials[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedAbsSum(trials[t].subarray(1));
      else if (choice === 'pairs') cost = pairCount(trials[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trials[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    out.set(trials[type], at);
  }
  return out;
}

// ---------- DEFLATE tables (RFC 1951) ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE_OF = new Uint16Array(259); // 257..285: does NOT fit in a Uint8
const LEN_EXTRA_OF = new Uint8Array(259);
const DIST_CODE_OF = new Uint8Array(32769);
const DIST_EXTRA_OF = new Uint8Array(32769);
for (let l = 3; l <= 258; l++) {
  let c = 0;
  while (c < 28 && LEN_BASE[c + 1] <= l) c++;
  LEN_CODE_OF[l] = 257 + c; LEN_EXTRA_OF[l] = LEN_EXTRA[c];
}
for (let d = 1; d <= 32768; d++) {
  let c = 0;
  while (c < 29 && DIST_BASE[c + 1] <= d) c++;
  DIST_CODE_OF[d] = c; DIST_EXTRA_OF[d] = DIST_EXTRA[c];
}
// Fixed Huffman code lengths (RFC 1951).
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(32);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
FIXED_DIST_LEN.fill(5);

// ---------- length-limited Huffman ----------
// Build code lengths (<= maxLen) from frequencies: heap tree, then the
// zlib-style overflow fix on length counts, then assign shortest lengths to
// the most frequent symbols. Returns lengths array (0 = unused symbol).
function buildLengths(freq: Uint32Array, maxLen: number): Uint8Array {
  const n = freq.length;
  const lens = new Uint8Array(n);
  let used = 0; let only = -1;
  for (let i = 0; i < n; i++) if (freq[i] > 0) { used++; only = i; }
  if (used === 0) return lens;
  if (used === 1) {
    lens[only] = 1;
    const other = only === 0 ? 1 : 0;
    if (other < n) lens[other] = 1;
    return lens;
  }
  const nf = new Float64Array(2 * n);
  const left = new Int32Array(2 * n).fill(-1);
  const right = new Int32Array(2 * n).fill(-1);
  for (let i = 0; i < n; i++) nf[i] = freq[i];
  const heap: number[] = [];
  const heapLess = (a: number, b: number): boolean => nf[a] < nf[b] || (nf[a] === nf[b] && a < b);
  const heapPush = (v: number): void => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!heapLess(heap[i], heap[p])) break; const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1; const r = l + 1; let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) heapPush(i);
  let next = n;
  while (heap.length > 1) {
    const a = heapPop(); const b = heapPop();
    left[next] = a; right[next] = b;
    nf[next] = nf[a] + nf[b];
    heapPush(next);
    next++;
  }
  const root = heapPop();
  const depth = new Int32Array(2 * n);
  const stack: number[] = [root];
  depth[root] = 0;
  while (stack.length > 0) {
    const v = stack.pop() as number;
    if (v < n) { lens[v] = depth[v]; continue; }
    depth[left[v]] = depth[v] + 1; depth[right[v]] = depth[v] + 1;
    stack.push(left[v]); stack.push(right[v]);
  }
  // Count lengths; fix overflow beyond maxLen.
  // Lengths over maxLen are capped, which over-subscribes the code (Kraft
  // sum > 1). Each repair step splits the longest code below maxLen into
  // two codes one bit longer and drops one code at maxLen: the symbol count
  // is unchanged and the Kraft sum drops by exactly 2^-maxLen, so looping
  // until the Kraft sum is exactly 1 lands on a complete code. (Driving the
  // loop by the overflow count, as an earlier draft did, is WRONG: it drops
  // only overflow/2 codes at maxLen while the excess is larger whenever
  // capped depths exceed maxLen+1 — e.g. 60 capped symbols at depths 16-17
  // leave an excess of 2^-12, an over-subscribed literal code, and an
  // invalid stream. That bug shipped in v3/v5 until caught here.)
  const counts = new Int32Array(maxLen + 2);
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (lens[i] === 0) continue;
    if (lens[i] > maxLen) { overflow++; counts[maxLen]++; }
    else counts[lens[i]]++;
  }
  if (overflow > 0) {
    // Kraft sum in units of 2^-maxLen; a complete code sums to 2^maxLen.
    const kraftUnits = (): number => {
      let s = 0;
      for (let l = 1; l <= maxLen; l++) s += counts[l] * (1 << (maxLen - l));
      return s;
    };
    const target = 1 << maxLen;
    let guard = 0;
    while (kraftUnits() > target && guard++ < 100000) {
      let bits = maxLen - 1;
      while (bits > 0 && counts[bits] === 0) bits--;
      if (bits === 0 || counts[maxLen] === 0) break; // should not happen
      counts[bits]--; counts[bits + 1] += 2; counts[maxLen]--;
    }
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[b] - freq[a] || a - b);
    lens.fill(0);
    let k = 0;
    for (let l = 1; l <= maxLen; l++) {
      for (let j = 0; j < counts[l]; j++) lens[order[k++]] = l;
    }
  }
  return lens;
}
// Canonical Huffman codes from lengths: codes[symbol], lengths as given.
function canonicalCodes(lens: Uint8Array): Uint32Array {
  const max = Math.max(0, ...lens);
  const blCount = new Int32Array(max + 1);
  for (let i = 0; i < lens.length; i++) if (lens[i] > 0) blCount[lens[i]]++;
  const nextCode = new Int32Array(max + 2);
  let code = 0;
  for (let l = 1; l <= max; l++) { code = (code + blCount[l - 1]) << 1; nextCode[l] = code; }
  const codes = new Uint32Array(lens.length);
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return codes;
}

// ---------- bit writer ----------
class BitSink {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  total = 0; // bits written so far
  put(value: number, len: number): void {
    this.acc |= (value & ((1 << len) - 1)) << this.nbits;
    this.nbits += len;
    this.total += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  putCode(code: number, len: number): void {
    // Huffman codes are emitted most-significant-bit first.
    for (let i = len - 1; i >= 0; i--) this.put((code >> i) & 1, 1);
  }
  finish(): Uint8Array {
    if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
    return Uint8Array.from(this.bytes);
  }
  // Append another (unfinished) sink's bitstream to this one, preserving
  // the exact bit position (DEFLATE blocks continue at the next bit).
  appendBits(src: BitSink): void {
    const fullBytes = Math.floor(src.total / 8);
    const remBits = src.total % 8;
    if (this.nbits === 0) {
      for (let i = 0; i < fullBytes; i++) this.bytes.push(src.bytes[i]);
      this.total += fullBytes * 8;
    } else {
      for (let i = 0; i < fullBytes; i++) this.put(src.bytes[i], 8);
    }
    if (remBits > 0) this.put(src.acc & ((1 << remBits) - 1), remBits);
  }
}

function adlerOf(b: Uint8Array): number {
  let a = 1; let bb = 0;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 5552);
    for (; i < end; i++) { a += b[i]; bb += a; }
    a %= 65521; bb %= 65521;
  }
  return ((bb << 16) | a) >>> 0;
}

// ---------- optimal-parse DEFLATE (v5: deep hash-chain match search) ----------
// v3's DP only tried the 2 most recent occurrences per position — far
// shallower than zlib level 9's chains, so its parse never beat zlib-9.
// v5 walks a deep hash chain (32–128 candidates, sized by input length)
// with zlib-style pruning: a candidate must match at offset bestLen to be
// able to beat the best match so far (chains are newest-first, so the first
// candidate at a given length also has the smallest distance); once a good
// match (>= 32) is found the remaining chain is quartered, and at >= 128
// the walk stops. The DP itself is the lazy evaluation: at every position
// it weighs a literal (then a match at i+1) against matches at i.
type Token = { lit: number; len: number; dist: number }; // lit>=0: literal; len>=3: match
const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;
function hash3(d: Uint8Array, i: number): number {
  return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & (HASH_SIZE - 1));
}
function matchLenAt(d: Uint8Array, a: number, b: number, cap: number): number {
  let l = 0;
  while (l + 4 <= cap) {
    const x = d[a + l] | (d[a + l + 1] << 8) | (d[a + l + 2] << 16) | (d[a + l + 3] << 24);
    const y = d[b + l] | (d[b + l + 1] << 8) | (d[b + l + 2] << 16) | (d[b + l + 3] << 24);
    if (x !== y) break;
    l += 4;
  }
  while (l < cap && d[a + l] === d[b + l]) l++;
  return l;
}
// One DP pass over `data` with the given literal/length and distance code
// lengths; returns the token list of the cheapest parse.
function dpParse(data: Uint8Array, litLens: Uint8Array, distLens: Uint8Array): Token[] {
  const n = data.length;
  // Deep chain, sized by input length (deterministic; no clock reads).
  const CHAIN_MAX = n <= 1000000 ? 128 : n <= 2500000 ? 64 : 32;
  const NICE_LEN = 128;
  const GOOD_LEN = 32;
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const fromPos = new Int32Array(n + 1);
  const fromLen = new Int16Array(n + 1);
  const fromDist = new Int32Array(n + 1);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prevOcc = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (i + 2 < n) {
      const h = hash3(data, i);
      if (ci !== Infinity) {
        // Literal (the lazy branch: a match at i+1 stays reachable).
        const litCost = ci + litLens[data[i]];
        if (litCost < cost[i + 1]) { cost[i + 1] = litCost; fromPos[i + 1] = i; fromLen[i + 1] = 1; fromDist[i + 1] = 0; }
        // Deep hash-chain search for the best match at i.
        let bestLen = 0; let bestDist = 0;
        let budget = CHAIN_MAX;
        let cand = head[h];
        while (cand !== -1 && budget > 0) {
          const dist = i - cand;
          if (dist > 32768) break; // newest-first: older candidates are farther
          if (bestLen >= n - i) break; // already matched to the end of data
          // Prune: to beat bestLen the candidate must match at offset bestLen
          // (and bestLen-1); otherwise its length cannot exceed bestLen.
          if (bestLen === 0 || (i + bestLen < n && data[cand + bestLen] === data[i + bestLen] && data[cand + bestLen - 1] === data[i + bestLen - 1])) {
            const cap = Math.min(258, n - i);
            const ml = matchLenAt(data, i, cand, cap);
            if (ml > bestLen) {
              bestLen = ml; bestDist = dist;
              if (ml >= NICE_LEN) break;
              if (ml >= GOOD_LEN) budget = Math.min(budget, Math.max(4, budget >> 2));
            }
          }
          cand = prevOcc[cand];
          budget--;
        }
        if (bestLen >= 3) {
          const dc = DIST_CODE_OF[bestDist];
          const dCost = distLens[dc] + DIST_EXTRA_OF[bestDist];
          // Try the best match at several lengths: a shorter match can win
          // when the next position holds a better match (lazy parse choice).
          for (let L = bestLen; L >= Math.max(3, bestLen - 3); L--) {
            const mc = ci + litLens[LEN_CODE_OF[L]] + LEN_EXTRA_OF[L] + dCost;
            if (mc < cost[i + L]) { cost[i + L] = mc; fromPos[i + L] = i; fromLen[i + L] = L; fromDist[i + L] = bestDist; }
          }
        }
      }
      prevOcc[i] = head[h];
      head[h] = i;
    } else if (ci !== Infinity) {
      const litCost = ci + litLens[data[i]];
      if (litCost < cost[i + 1]) { cost[i + 1] = litCost; fromPos[i + 1] = i; fromLen[i + 1] = 1; fromDist[i + 1] = 0; }
    }
  }
  // Backtrack.
  const tokens: Token[] = [];
  let p = n;
  while (p > 0) {
    const f = fromPos[p];
    const L = fromLen[p];
    if (L === 1) tokens.push({ lit: data[f], len: 0, dist: 0 });
    else tokens.push({ lit: -1, len: L, dist: fromDist[p] });
    p = f;
  }
  tokens.reverse();
  return tokens;
}
function tokenFrequencies(tokens: Token[]): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  for (const t of tokens) {
    if (t.len === 0) litFreq[t.lit]++;
    else { litFreq[LEN_CODE_OF[t.len]]++; distFreq[DIST_CODE_OF[t.dist]]++; }
  }
  litFreq[256]++; // end-of-block
  return { litFreq, distFreq };
}
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// RLE-encode a code-length sequence into (symbol, extraBits, extraLen) triples.
function rleLengths(seq: Uint8Array): { sym: number; extra: number; extraLen: number }[] {
  const out: { sym: number; extra: number; extraLen: number }[] = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    if (v === 0) {
      let run = 0;
      while (i + run < seq.length && seq[i + run] === 0) run++;
      i += run;
      while (run >= 11) { const take = Math.min(run, 138); out.push({ sym: 18, extra: take - 11, extraLen: 7 }); run -= take; }
      if (run >= 3) { out.push({ sym: 17, extra: run - 3, extraLen: 3 }); run = 0; }
      while (run > 0) { out.push({ sym: 0, extra: 0, extraLen: 0 }); run--; }
    } else {
      out.push({ sym: v, extra: 0, extraLen: 0 });
      i++;
      let run = 0;
      while (i + run < seq.length && seq[i + run] === v) run++;
      i += run;
      while (run >= 3) { const take = Math.min(run, 6); out.push({ sym: 16, extra: take - 3, extraLen: 2 }); run -= take; }
      while (run > 0) { out.push({ sym: v, extra: 0, extraLen: 0 }); run--; }
    }
  }
  return out;
}
// Write one block of tokens into the shared `sink`. `last` marks the final
// block. The block is emitted as dynamic if smaller than fixed, else fixed;
// both candidates are built in scratch sinks and the winner's bits are
// appended to the shared sink so blocks continue at the next bit.
function writeBlock(tokens: Token[], last: boolean, sink: BitSink): void {
  const { litFreq, distFreq } = tokenFrequencies(tokens);
  const litLens = buildLengths(litFreq, 15);
  let distLens = buildLengths(distFreq, 15);
  if (tokens.every((t) => t.len === 0)) { distLens = new Uint8Array(32); distLens[0] = 1; }
  // --- dynamic block ---
  const dyn = new BitSink();
  dyn.put(last ? 1 : 0, 1);
  dyn.put(2, 2);
  let hlit = 288; while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 32; while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLens.subarray(0, hlit), 0);
  seq.set(distLens.subarray(0, hdist), hlit);
  const rle = rleLengths(seq);
  const clenFreq = new Uint32Array(19);
  for (const r of rle) clenFreq[r.sym]++;
  const clenLens = buildLengths(clenFreq, 7);
  let hclen = 19; while (hclen > 4 && clenLens[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  dyn.put(hlit - 257, 5);
  dyn.put(hdist - 1, 5);
  dyn.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) dyn.put(clenLens[CLEN_ORDER[k]], 3);
  const clenCodes = canonicalCodes(clenLens);
  for (const r of rle) {
    dyn.putCode(clenCodes[r.sym], clenLens[r.sym]);
    if (r.extraLen > 0) dyn.put(r.extra, r.extraLen);
  }
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  for (const t of tokens) {
    if (t.len === 0) {
      dyn.putCode(litCodes[t.lit], litLens[t.lit]);
    } else {
      const lc = LEN_CODE_OF[t.len];
      dyn.putCode(litCodes[lc], litLens[lc]);
      if (LEN_EXTRA_OF[t.len] > 0) dyn.put(t.len - LEN_BASE[lc - 257], LEN_EXTRA_OF[t.len]);
      const dc = DIST_CODE_OF[t.dist];
      dyn.putCode(distCodes[dc], distLens[dc]);
      if (DIST_EXTRA_OF[t.dist] > 0) dyn.put(t.dist - DIST_BASE[dc], DIST_EXTRA_OF[t.dist]);
    }
  }
  dyn.putCode(litCodes[256], litLens[256]);
  // --- fixed block ---
  const fix = new BitSink();
  fix.put(last ? 1 : 0, 1);
  fix.put(1, 2);
  const fLitCodes = canonicalCodes(FIXED_LIT_LEN);
  const fDistCodes = canonicalCodes(FIXED_DIST_LEN);
  for (const t of tokens) {
    if (t.len === 0) fix.putCode(fLitCodes[t.lit], FIXED_LIT_LEN[t.lit]);
    else {
      const lc = LEN_CODE_OF[t.len];
      fix.putCode(fLitCodes[lc], FIXED_LIT_LEN[lc]);
      if (LEN_EXTRA_OF[t.len] > 0) fix.put(t.len - LEN_BASE[lc - 257], LEN_EXTRA_OF[t.len]);
      const dc = DIST_CODE_OF[t.dist];
      fix.putCode(fDistCodes[dc], 5);
      if (DIST_EXTRA_OF[t.dist] > 0) fix.put(t.dist - DIST_BASE[dc], DIST_EXTRA_OF[t.dist]);
    }
  }
  fix.putCode(fLitCodes[256], 7);
  // Safety net: a dynamic block is only usable when its codes are valid —
  // literal and code-length codes complete (Kraft exactly 1), distance code
  // not over-subscribed (Kraft <= 1; a single length-1 distance code is the
  // legal incomplete case). If not, the fixed block always is.
  const kraftOk = (lens: Uint8Array, maxLen: number, complete: boolean): boolean => {
    let s = 0;
    for (let i = 0; i < lens.length; i++) if (lens[i] > 0) s += 1 << (maxLen - lens[i]);
    return complete ? s === (1 << maxLen) : s <= (1 << maxLen);
  };
  const dynOk = kraftOk(litLens, 15, true) && kraftOk(distLens, 15, false) && kraftOk(clenLens, 7, true);
  if (dynOk && dyn.total <= fix.total) sink.appendBits(dyn);
  else sink.appendBits(fix);
}
// Full optimal-parse DEFLATE of `data`, wrapped as one zlib stream.
function optimalDeflate(data: Uint8Array): Uint8Array {
  // Pass 1 with fixed-Huffman costs, then a second pass with the real costs.
  let tokens = dpParse(data, FIXED_LIT_LEN, FIXED_DIST_LEN);
  const { litFreq, distFreq } = tokenFrequencies(tokens);
  const litLens = buildLengths(litFreq, 15);
  const distLens = buildLengths(distFreq, 15);
  tokens = dpParse(data, litLens, distLens);
  // Split into blocks of at most 120k tokens. All blocks share ONE bit
  // stream: DEFLATE blocks continue at the next bit, not the next byte, so
  // emitting each block from its own BitSink (as an earlier draft did) pads
  // every block to a byte boundary and corrupts every stream with 2+ blocks.
  const BLOCK_TOKENS = 120000;
  const sink = new BitSink();
  for (let s = 0; s < tokens.length; s += BLOCK_TOKENS) {
    const chunk = tokens.slice(s, s + BLOCK_TOKENS);
    writeBlock(chunk, s + BLOCK_TOKENS >= tokens.length, sink);
  }
  const body = sink.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adlerOf(data));
  return out;
}

// ---------- screening + final encode ----------
function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}
function squeezeOne(rgba: Uint8Array): Uint8Array {
  let bestForm: Form | null = null;
  let bestData: Uint8Array | null = null;
  let bestBytes = Infinity;
  let spare: Uint8Array | null = null;
  for (const form of enumerateForms(rgba)) {
    const size = H * (W * form.bpp + 1);
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const buf = spare !== null && spare.length === size ? spare : new Uint8Array(size);
      const data = filterSamples(form.samples, W, H, form.bpp, choice, buf);
      spare = null;
      const z = deflateSync(data, { level: 6, memLevel: 8, strategy: zconst.Z_DEFAULT_STRATEGY });
      const bytes = z.length + overhead;
      if (bytes < bestBytes) {
        if (bestData !== null) spare = bestData;
        bestBytes = bytes; bestForm = form; bestData = data;
      } else spare = data;
    }
  }
  const form = bestForm as Form;
  const data = bestData as Uint8Array;
  // Final re-encode of the winner at level 9 across strategies; keep smallest.
  let bestIdat: Uint8Array | null = null;
  let bestLen = Infinity;
  for (const strat of [zconst.Z_DEFAULT_STRATEGY, zconst.Z_FILTERED, zconst.Z_HUFFMAN_ONLY]) {
    const z = deflateSync(data, { level: 9, memLevel: 9, strategy: strat });
    if (z.length < bestLen) { bestLen = z.length; bestIdat = z; }
  }
  // Own optimal-parse encoder (deep hash chains); keep it only when it wins.
  try {
    const opt = optimalDeflate(data);
    if (opt.length < bestLen) { bestLen = opt.length; bestIdat = opt; }
  } catch {
    // Fall back to the zlib stream on any encoder surprise.
  }
  return assemblePng(W, H, form.ct, form.plte, form.trns, bestIdat as Uint8Array);
}

for (const id of readdirSync(IN_DIR).sort()) {
  const src = join(IN_DIR, id, 'image.png');
  const { rgba } = decodePngFile(new Uint8Array(readFileSync(src)));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'image.png'), squeezeOne(rgba));
}
