// Synthetic asset byte stream shared by the range server (D3), asset-digest.mjs and tests.
//
// Contract (runtime range-server contract): bytes for asset <name> are the xorshift64* stream
// (little-endian u64 words) seeded with 0x9E3779B97F4A7C15 XOR FNV-1a-64(name), truncated to
// <bytes>. Two implementations live here: a BigInt reference (slow, obviously correct) and a
// 32-bit-pair implementation (fast) that the Vitest suite checks against the reference.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
const SEED_CONST = 0x9e3779b97f4a7c15n;
const MULT = 0x2545f4914f6cdd1dn;
const MULT_HI = 0x2545f491;
const MULT_LO = 0x4f6cdd1d;

/** FNV-1a-64 over the UTF-8 bytes of `name`, as a BigInt. */
export function fnv1a64(name) {
  const bytes = new TextEncoder().encode(name);
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Stream seed for an asset name (BigInt). */
export function seedFor(name) {
  return SEED_CONST ^ fnv1a64(name);
}

/** Reference generator: yields successive u64 words as BigInt. */
export function* xorshift64starBig(seed) {
  let x = BigInt.asUintN(64, seed);
  for (;;) {
    x ^= x >> 12n;
    x ^= (x << 25n) & MASK64;
    x ^= x >> 27n;
    yield (x * MULT) & MASK64;
  }
}

/** Reference: first `n` bytes of the stream as Uint8Array (BigInt based, slow). */
export function streamBytesBig(name, n) {
  const out = new Uint8Array(n);
  const gen = xorshift64starBig(seedFor(name));
  for (let off = 0; off < n; off += 8) {
    const w = gen.next().value;
    for (let i = 0; i < 8 && off + i < n; i++) out[off + i] = Number((w >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

// --- fast 32-bit-pair implementation --------------------------------------------------------

/** High 32 bits of the 64-bit product of two u32 values. */
function mulHi32(a, b) {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const lo = a0 * b0;
  const mid = a1 * b0 + a0 * b1 + Math.floor(lo / 0x10000);
  return (a1 * b1 + Math.floor(mid / 0x10000)) >>> 0;
}

/**
 * Stateful fast generator. `fill(out)` writes the next out.length bytes of the stream.
 * Produces exactly the same bytes as streamBytesBig for the same name.
 */
export class AssetStream {
  constructor(name) {
    const seed = seedFor(name);
    this.hi = Number((seed >> 32n) & 0xffffffffn) >>> 0;
    this.lo = Number(seed & 0xffffffffn) >>> 0;
    this.carry = new Uint8Array(8);
    this.carryLen = 0;
  }

  /** Advance the state and return the next output word as [hi, lo] u32 pair. */
  nextWord() {
    let hi = this.hi;
    let lo = this.lo;
    // x ^= x >> 12
    let nlo = ((lo >>> 12) | (hi << 20)) >>> 0;
    let nhi = hi >>> 12;
    hi ^= nhi;
    lo ^= nlo;
    hi >>>= 0;
    lo >>>= 0;
    // x ^= x << 25
    nhi = ((hi << 25) | (lo >>> 7)) >>> 0;
    nlo = (lo << 25) >>> 0;
    hi = (hi ^ nhi) >>> 0;
    lo = (lo ^ nlo) >>> 0;
    // x ^= x >> 27
    nlo = ((lo >>> 27) | (hi << 5)) >>> 0;
    nhi = hi >>> 27;
    hi = (hi ^ nhi) >>> 0;
    lo = (lo ^ nlo) >>> 0;
    this.hi = hi;
    this.lo = lo;
    // out = x * MULT mod 2^64
    const outLo = Math.imul(lo, MULT_LO) >>> 0;
    const outHi = (mulHi32(lo, MULT_LO) + Math.imul(lo, MULT_HI) + Math.imul(hi, MULT_LO)) >>> 0;
    return [outHi, outLo];
  }

  /** Fill `out` with the next bytes of the stream. */
  fill(out) {
    let i = 0;
    const n = out.length;
    while (this.carryLen > 0 && i < n) {
      out[i++] = this.carry[8 - this.carryLen];
      this.carryLen--;
    }
    while (i + 8 <= n) {
      const [hi, lo] = this.nextWord();
      out[i] = lo & 0xff;
      out[i + 1] = (lo >>> 8) & 0xff;
      out[i + 2] = (lo >>> 16) & 0xff;
      out[i + 3] = lo >>> 24;
      out[i + 4] = hi & 0xff;
      out[i + 5] = (hi >>> 8) & 0xff;
      out[i + 6] = (hi >>> 16) & 0xff;
      out[i + 7] = hi >>> 24;
      i += 8;
    }
    if (i < n) {
      const [hi, lo] = this.nextWord();
      const w = this.carry;
      w[0] = lo & 0xff;
      w[1] = (lo >>> 8) & 0xff;
      w[2] = (lo >>> 16) & 0xff;
      w[3] = lo >>> 24;
      w[4] = hi & 0xff;
      w[5] = (hi >>> 8) & 0xff;
      w[6] = (hi >>> 16) & 0xff;
      w[7] = hi >>> 24;
      let k = 0;
      while (i < n) out[i++] = w[k++];
      this.carryLen = 8 - k;
    }
    return out;
  }
}

/** Fast: first `n` bytes of the stream for `name`. */
export function streamBytes(name, n) {
  return new AssetStream(name).fill(new Uint8Array(n));
}

/**
 * Fast: bytes [start, end) of the stream for `name` (end exclusive). Advances from the start
 * of the stream, so cost is O(end); fine for the test server's sizes.
 */
export function streamRange(name, start, end) {
  const s = new AssetStream(name);
  const skipWords = Math.floor(start / 8);
  for (let i = 0; i < skipWords; i++) s.nextWord();
  const rem = start - skipWords * 8;
  if (rem > 0) s.fill(new Uint8Array(rem));
  return s.fill(new Uint8Array(end - start));
}
