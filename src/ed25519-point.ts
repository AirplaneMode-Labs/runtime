/**
 * Weak Ed25519 public keys (manifest 0.1.3, MANIFEST.md "Weak keys"; S1-113, TD-68, TD-82).
 *
 * A trusted key must be the canonical 32-byte encoding of a point of the prime-order subgroup other than the
 * identity. `isWeakEd25519PublicKey` decides that from the 32 bytes alone:
 *
 *  1. decode per RFC 8032 section 5.1.3: y < p (canonical), x recovered by the square-root rule, the point on
 *     the curve, and x = 0 with the sign bit set refused;
 *  2. not the identity;
 *  3. not small order: [8]P is not the identity;
 *  4. torsion-free: [L]P is the identity, which refuses mixed-order points.
 *
 * Written in BigInt, in-house, with no dependency. The keys are public, so constant time is not needed. It is a
 * pure function of the bytes: no cache (in particular none keyed by a keyId) and no state. The vectors it is
 * checked against come from an independent affine implementation (test/tools/make-weak-key-vectors.mjs).
 *
 * Arithmetic: twisted Edwards curve -x^2 + y^2 = 1 + d x^2 y^2 over GF(2^255 - 19), extended coordinates
 * (X : Y : Z : T) with T = XY/Z. The addition below (add-2008-hwcd-3) is complete on this curve, so it is valid for
 * every pair of curve points, including equal points, the identity and small-order points.
 */

const P = (1n << 255n) - 19n;
/** The order of the base point: 2^252 + 27742317777372353535851937790883648493. */
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const MASK_255 = (1n << 255n) - 1n;

const mod = (a: bigint): bigint => {
  const r = a % P;
  return r >= 0n ? r : r + P;
};

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);

/** d = -121665 / 121666 mod p. */
const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
/** sqrt(-1) mod p. */
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

interface Point {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
  readonly t: bigint;
}

const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

function add(p: Point, q: Point): Point {
  const a = ((p.y - p.x + P) * (q.y - q.x + P)) % P;
  const b = ((p.y + p.x) * (q.y + q.x)) % P;
  const c = (((p.t * D2) % P) * q.t) % P;
  const d = (2n * p.z * q.z) % P;
  const e = b - a + P;
  const f = d - c + P;
  const g = d + c;
  const h = b + a;
  return {
    x: (e * f) % P,
    y: (g * h) % P,
    z: (f * g) % P,
    t: (e * h) % P,
  };
}

/** Dedicated doubling (dbl-2008-hwcd, a = -1); the vectors and the tests cross-check it against the oracle. */
function double(p: Point): Point {
  const a = (p.x * p.x) % P;
  const b = (p.y * p.y) % P;
  const c = (2n * p.z * p.z) % P;
  const d = P - a; // a * A with a = -1
  const xy = p.x + p.y;
  const e = (xy * xy - a - b + 2n * P) % P;
  const g = d + b;
  const f = (g - c + P) % P;
  const h = (d - b + P) % P;
  return {
    x: (e * f) % P,
    y: (g * h) % P,
    z: (f * g) % P,
    t: (e * h) % P,
  };
}

/** [k]P by left-to-right double and add. */
function mul(k: bigint, p: Point): Point {
  let r = IDENTITY;
  for (let i = k.toString(2).length - 1; i >= 0; i--) {
    r = double(r);
    if ((k >> BigInt(i)) & 1n) r = add(r, p);
  }
  return r;
}

const isIdentity = (p: Point): boolean => p.x % P === 0n && (p.y - p.z) % P === 0n;

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** RFC 8032 section 5.1.3: the point of a 32-byte encoding, or undefined when it does not decode. */
function decode(bytes: Uint8Array): Point | undefined {
  const sign = (bytes[31]! >> 7) & 1;
  const y = leToBigInt(bytes) & MASK_255;
  if (y >= P) return undefined; // a canonical y is below p
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  // x = u v^3 (u v^7)^((p-5)/8)
  const v3 = (v * v * v) % P;
  const v7 = (v3 * v3 * v) % P;
  let x = (((u * v3) % P) * pow((u * v7) % P, (P - 5n) / 8n)) % P;
  const vx2 = (v * ((x * x) % P)) % P;
  if (vx2 !== u) {
    if (vx2 !== (P - u) % P) return undefined; // not a square: y is not on the curve
    x = (x * SQRT_M1) % P;
  }
  if (x === 0n && sign === 1) return undefined;
  if (Number(x & 1n) !== sign) x = (P - x) % P;
  return { x, y, z: 1n, t: (x * y) % P };
}

/**
 * True when the 32 bytes are NOT the canonical encoding of a point of the prime-order subgroup other than the
 * identity: a weak key (MANIFEST.md, Weak keys). A key of any other length is outside the rule and gives false
 * (it keeps its 0.1.2 outcome, `key_mismatch`).
 */
export function isWeakEd25519PublicKey(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  const point = decode(bytes);
  if (!point) return true;
  if (isIdentity(point)) return true;
  // [8]P: three doublings. A small-order point (order 2, 4 or 8) lands on the identity.
  if (isIdentity(double(double(double(point))))) return true;
  // [L]P = O exactly for the prime-order subgroup: anything else carries a torsion component.
  return !isIdentity(mul(L, point));
}
