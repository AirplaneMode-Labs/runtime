#!/usr/bin/env node
// Generates the weak-key vectors of manifest 0.1.3 (spec release 0.6.0; S1-113, TD-68, TD-82):
//
//   spec/vectors/weak-keys/weak-keys.json                 rows { id, publicKeyHex, keyIdHex, class, expect }
//   spec/vectors/weak-keys/verify.json                    rows { manifest, trust, allowTestKeys, expect }
//   spec/vectors/weak-keys/forged-identity.manifest.json  signature R = identity, S = 0 under the identity key
//   spec/vectors/weak-keys/forged-order8.manifest.json    a 0.1.2-shaped manifest forged under an order-8 key
//   spec/vectors/weak-keys/README.md
//
// EVERY hex value is derived by computation here, with an independent affine Edwards implementation in
// BigInt (it does not import src/ed25519-point.ts, so test/weak-keys.test.ts checks the library against an
// oracle). Small-order points are found by solving the curve and checking the order; mixed_order is the
// RFC 8032 TEST 1 point plus an order-8 point; not_on_curve is the smallest y with no square root;
// noncanonical_y is y + p for the first y in 2..18 that is on the curve. The tool asserts every class:
// for 'ok' rows [L]P = O and P != O; for mixed_order [8]P != O and [L]P != O; for small-order rows [8]P = O.
// The libsodium blocklist is informative only and is not used.
//
// Deterministic: a rerun reproduces every byte. The one generated 'ok' key comes from a fixed, public,
// non-secret derivation (sha256 of a label), like the RFC 8032 test keys.
//
//   node test/tools/make-weak-key-vectors.mjs [--check]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  ED25519_L as L,
  RFC8032_TEST_KEYS,
  keyIdOf,
  privateKeyFromSeed,
  rawPublicKey,
  signedBytes,
  verifySig,
} from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, '../../spec');
const outDir = resolve(spec, 'vectors/weak-keys');

// ---- field and curve (affine, complete addition law; a = -1 twisted Edwards) --------------------------
const P = (1n << 255n) - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (b, e) => {
  let r = 1n;
  let x = mod(b);
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = mod(r * x);
    x = mod(x * x);
    k >>= 1n;
  }
  return r;
};
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
if (mod(SQRT_M1 * SQRT_M1) !== P - 1n) throw new Error('sqrt(-1) wrong');

/** Square root mod p (p = 5 mod 8), or undefined when a is a non-residue. */
function sqrt(a) {
  a = mod(a);
  let r = pow(a, (P + 3n) / 8n);
  if (mod(r * r) === a) return r;
  r = mod(r * SQRT_M1);
  if (mod(r * r) === a) return r;
  return undefined;
}
/** x such that (x, y) is on the curve (the root with the requested parity of x), or undefined. */
function xFromY(y, sign) {
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = sqrt(mod(u * inv(v)));
  if (x === undefined) return undefined;
  if (x === 0n && sign === 1) return undefined;
  if (Number(x & 1n) !== sign) x = mod(P - x);
  return x;
}
const IDENTITY = Object.freeze({ x: 0n, y: 1n });
const eq = (p, q) => p.x === q.x && p.y === q.y;
function add(p, q) {
  const dxy = mod(D * p.x * q.x * p.y * q.y);
  return {
    x: mod((p.x * q.y + p.y * q.x) * inv(1n + dxy)),
    y: mod((p.y * q.y + p.x * q.x) * inv(1n - dxy + P)),
  };
}
const neg = (p) => ({ x: mod(-p.x), y: p.y });
function mul(k, p) {
  let r = IDENTITY;
  let a = p;
  while (k > 0n) {
    if (k & 1n) r = add(r, a);
    a = add(a, a);
    k >>= 1n;
  }
  return r;
}
const onCurve = (p) => mod(-p.x * p.x + p.y * p.y) === mod(1n + D * p.x * p.x * p.y * p.y);

// ---- encoding ---------------------------------------------------------------------------------------
const leBytes = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
const leInt = (b) => BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
/** Canonical encoding: y little-endian, bit 255 = parity of x. */
function encode(p) {
  const b = leBytes(p.y);
  if (p.x & 1n) b[31] |= 0x80;
  return b;
}
/** Encodes y (any value below 2^255) with an explicit sign bit, whether or not it is canonical or on the curve. */
function encodeRaw(y, sign) {
  const b = leBytes(y);
  if (sign) b[31] |= 0x80;
  return b;
}
/** RFC 8032 section 5.1.3, strict: a canonical y, a square root, x = 0 with the sign bit set refused. */
function decodeStrict(b) {
  if (b.length !== 32) return undefined;
  const sign = (b[31] >> 7) & 1;
  const y = leInt(Buffer.from(b)) & ((1n << 255n) - 1n);
  if (y >= P) return undefined;
  const x = xFromY(y, sign);
  return x === undefined ? undefined : { x, y };
}

/** The predicate of MANIFEST.md, Weak keys: true when the 32 bytes are NOT a prime-order point other than the identity. */
function isWeakOracle(b) {
  const p = decodeStrict(b);
  if (!p) return true;
  if (eq(p, IDENTITY)) return true;
  if (eq(mul(8n, p), IDENTITY)) return true;
  return !eq(mul(L, p), IDENTITY);
}

// ---- derive the torsion subgroup ---------------------------------------------------------------------
let t8;
for (let y = 2n; y < 200n && !t8; y++) {
  const x = xFromY(y, 0);
  if (x === undefined) continue;
  const q = mul(L, { x, y }); // L = 5 mod 8, so [L]P generates the torsion part of P
  if (!eq(mul(4n, q), IDENTITY)) t8 = q; // order exactly 8
}
if (!t8) throw new Error('no order-8 point found');
const torsion = Array.from({ length: 8 }, (_, k) => mul(BigInt(k), t8)); // [0]T..[7]T
const order = (p) => [1n, 2n, 4n, 8n].find((o) => eq(mul(o, p), IDENTITY));
{
  const orders = torsion.map((p) => Number(order(p)));
  const want = [1, 8, 4, 8, 2, 8, 4, 8];
  if (JSON.stringify(orders) !== JSON.stringify(want)) throw new Error(`torsion orders ${orders}`);
  if (new Set(torsion.map((p) => encode(p).toString('hex'))).size !== 8)
    throw new Error('torsion points are not distinct');
  for (const p of torsion) if (!onCurve(p)) throw new Error('torsion point off curve');
}
const IDENT_BYTES = encode(IDENTITY);
if (IDENT_BYTES.toString('hex') !== '01' + '00'.repeat(31)) throw new Error('identity encoding');

// ---- rows ---------------------------------------------------------------------------------------------
const hex = (b) => Buffer.from(b).toString('hex');
const keyIdHex = (b) => keyIdOf(Buffer.from(b));
const rows = [];
const addRow = (id, bytes, cls, why) => {
  const weak = cls !== 'valid';
  if (bytes.length !== 32) throw new Error(`${id}: not 32 bytes`);
  if (isWeakOracle(bytes) !== weak)
    throw new Error(`${id}: class ${cls} disagrees with the oracle`);
  rows.push({
    id,
    publicKeyHex: hex(bytes),
    keyIdHex: keyIdHex(bytes),
    class: cls,
    expect: weak ? 'weak_key_refused' : 'ok',
    why,
  });
};

// identity, and the identity with the sign bit set (x = 0 with the sign bit set is not decodable)
addRow('identity', IDENT_BYTES, 'identity', 'the neutral element (0, 1)');
addRow(
  'identity-sign-bit',
  encodeRaw(1n, 1),
  'identity_sign_bit',
  'y = 1 with the sign bit set: x = 0 cannot carry a sign (RFC 8032 section 5.1.3)',
);

// all eight small-order points in canonical form (the identity is row 'identity' above)
const smallOrderNames = [
  null,
  'small-order-8-a',
  'small-order-4-a',
  'small-order-8-b',
  'small-order-2',
  'small-order-8-c',
  'small-order-4-b',
  'small-order-8-d',
];
torsion.forEach((p, k) => {
  let name = smallOrderNames[k];
  if (name === null) return;
  // the order-4 point whose x is even encodes as thirty-two zero bytes: name it so no harness has to know that
  if (order(p) === 4n)
    name = encode(p).equals(Buffer.alloc(32, 0))
      ? 'small-order-4-all-zero'
      : 'small-order-4-sign-bit';
  addRow(name, encode(p), 'small_order', `a point of order ${order(p)} in canonical form`);
});
if (!rows.some((r) => r.publicKeyHex === '00'.repeat(32)))
  throw new Error('the all-zero key is not among the small-order rows');

// non-canonical forms of small-order points: y = p (a point of order 4) and y = p + 1 (the identity)
addRow(
  'small-order-y-eq-p-sign0',
  encodeRaw(P, 0),
  'small_order_noncanonical',
  'y = p reduces to y = 0',
);
addRow(
  'small-order-y-eq-p-sign1',
  encodeRaw(P, 1),
  'small_order_noncanonical',
  'y = p reduces to y = 0',
);
addRow(
  'small-order-y-eq-p-plus-1-sign0',
  encodeRaw(P + 1n, 0),
  'small_order_noncanonical',
  'y = p + 1 reduces to y = 1 (identity)',
);
addRow(
  'small-order-y-eq-p-plus-1-sign1',
  encodeRaw(P + 1n, 1),
  'small_order_noncanonical',
  'y = p + 1 with the sign bit set',
);
addRow(
  'small-order-minus-one-sign1',
  encodeRaw(P - 1n, 1),
  'small_order_noncanonical',
  'y = -1 with the sign bit set: x = 0 cannot carry a sign',
);

// mixed order: the RFC 8032 TEST 1 point plus a small-order point
const test1 = RFC8032_TEST_KEYS[0];
const test1Point = decodeStrict(Buffer.from(test1.publicHex, 'hex'));
if (!test1Point) throw new Error('TEST 1 does not decode');
for (const [name, k, label] of [
  ['mixed-test1-plus-order8', 1, 'order 8'],
  ['mixed-test1-plus-order4', 2, 'order 4'],
  ['mixed-test1-plus-order2', 4, 'order 2'],
]) {
  const m = add(test1Point, torsion[k]);
  if (eq(mul(8n, m), IDENTITY) || eq(mul(L, m), IDENTITY))
    throw new Error(`${name}: not mixed order`);
  addRow(name, encode(m), 'mixed_order', `RFC 8032 TEST 1 plus a point of ${label}`);
}

// not on the curve: the smallest y whose x^2 has no square root
let yOff;
for (let y = 2n; !yOff; y++) if (xFromY(y, 0) === undefined) yOff = y;
addRow(
  'not-on-curve-smallest-y',
  encodeRaw(yOff, 0),
  'not_on_curve',
  `y = ${yOff} has no square root`,
);

// non-canonical y: y + p for the first y in 2..18 on the curve, and the all-ones encoding (y = 2^255 - 1)
let yNc;
for (let y = 2n; y <= 18n && yNc === undefined; y++) if (xFromY(y, 0) !== undefined) yNc = y;
if (yNc === undefined) throw new Error('no y in 2..18 on the curve');
addRow(
  'noncanonical-y-first-on-curve',
  encodeRaw(yNc + P, 0),
  'noncanonical_y',
  `y = ${yNc} + p: the point with y = ${yNc} is on the curve, but y >= p is not canonical`,
);
addRow(
  'noncanonical-y-all-ones',
  Buffer.alloc(32, 0xff),
  'noncanonical_y',
  'all 256 bits set: y = 2^255 - 1 >= p',
);

// accepted rows: the five RFC 8032 test keys (judged with allowTestKeys true) and one generated key
for (const k of RFC8032_TEST_KEYS)
  addRow(
    `ok-${k.name}`,
    Buffer.from(k.publicHex, 'hex'),
    'valid',
    `${k.label}: published RFC 8032 test key; [L]P = O`,
  );
const generatedSeed = createHash('sha256')
  .update('airplanemode weak-key vectors: generated key 1')
  .digest();
const generatedPub = rawPublicKey(privateKeyFromSeed(generatedSeed.toString('hex')));
addRow(
  'ok-generated-1',
  generatedPub,
  'valid',
  'a key made by Ed25519 key generation from a fixed public derivation; [L]P = O',
);
for (const r of rows) {
  if (r.class !== 'valid') continue;
  const p = decodeStrict(Buffer.from(r.publicKeyHex, 'hex'));
  if (!p || eq(p, IDENTITY) || !eq(mul(L, p), IDENTITY))
    throw new Error(`${r.id}: ok row is not prime order`);
}
const refusedCount = rows.filter((r) => r.expect === 'weak_key_refused').length;
if (refusedCount < 16) throw new Error(`only ${refusedCount} refused rows`);
for (const cls of [
  'identity',
  'identity_sign_bit',
  'small_order',
  'small_order_noncanonical',
  'mixed_order',
  'not_on_curve',
  'noncanonical_y',
  'valid',
])
  if (!rows.some((r) => r.class === cls)) throw new Error(`no row of class ${cls}`);

// ---- forged manifests ---------------------------------------------------------------------------------
const SIGNED_AT = '2026-11-01T00:00:00Z';
const base = JSON.parse(readFileSync(resolve(spec, 'vectors/tamper/tamper-base.json'), 'utf8'));
const unsigned = (id, version, publisher) => ({
  spec: 'airplanemode.manifest/0.1',
  id,
  version,
  publisher,
  createdAt: '2026-11-01T00:00:00Z',
  expiresAt: '2027-11-01T00:00:00Z',
  entries: base.entries,
  signatures: [],
});
const sigObject = (pub, sigBytes) => ({
  alg: 'ed25519',
  keyId: keyIdHex(pub),
  publicKey: Buffer.from(pub).toString('base64'),
  sig: Buffer.from(sigBytes).toString('base64'),
  signedAt: SIGNED_AT,
});
const sha512 = (...parts) => createHash('sha512').update(Buffer.concat(parts)).digest();

// (1) forged-identity: R = identity, S = 0 under the identity key verifies every message on a cofactorless verifier
const forgedIdentity = unsigned('forged-identity', '1.0.0', 'Airplane Mode Labs (vectors)');
forgedIdentity.signatures = [
  sigObject(IDENT_BYTES, Buffer.concat([IDENT_BYTES, Buffer.alloc(32, 0)])),
];

// (2) a 0.1.2-shaped manifest forged under an order-8 key: S = 0 and R = -[k]A, where k = H(R || A || M) mod L;
// R ranges over the 8 points of <A>, so a nonce in `publisher` is ground until one of them is a fixed point.
const A8 = torsion[1];
const A8bytes = encode(A8);
let forgedOrder8;
for (let nonce = 0; nonce < 4096 && !forgedOrder8; nonce++) {
  const m = unsigned('weak-key-downgrade', '0.1.2', `Airplane Mode Labs (vectors) ${nonce}`);
  const msg = signedBytes(m);
  for (let j = 0n; j < 8n; j++) {
    const R = mul(j, A8);
    const rBytes = encode(R);
    const k = leInt(sha512(rBytes, A8bytes, msg)) % L;
    if (eq(neg(mul(k, A8)), R)) {
      m.signatures = [sigObject(A8bytes, Buffer.concat([rBytes, Buffer.alloc(32, 0)]))];
      forgedOrder8 = m;
      break;
    }
  }
}
if (!forgedOrder8) throw new Error('no forgery found under the order-8 key');

// Informative: does the platform verifier accept the forgeries (a verifier without the 0.1.3 rule)? The
// result is printed, never asserted, because engines differ; the vectors say what 0.1.3 does.
const platformAccepts = (m) => {
  try {
    return verifySig(
      m,
      m.signatures[0].sig,
      m.signatures[0].publicKey
        ? Buffer.from(m.signatures[0].publicKey, 'base64').toString('hex')
        : '',
    );
  } catch {
    return false;
  }
};

// ---- verify.json --------------------------------------------------------------------------------------
const byId = new Map(rows.map((r) => [r.id, r]));
const trustOf = (...ids) =>
  ids.map((id) => ({ keyIdHex: byId.get(id).keyIdHex, publicKeyHex: byId.get(id).publicKeyHex }));
const THROWS = { throws: 'weak_key_refused' };
const generated = byId.get('ok-generated-1');
const verifyRows = [
  {
    manifest: 'weak-keys/forged-identity.manifest.json',
    trust: trustOf('identity'),
    allowTestKeys: false,
    expect: THROWS,
  },
  {
    manifest: 'weak-keys/forged-identity.manifest.json',
    trust: trustOf('identity'),
    allowTestKeys: true,
    expect: THROWS,
  },
  {
    manifest: 'weak-keys/forged-order8.manifest.json',
    trust: trustOf('small-order-8-a'),
    allowTestKeys: false,
    expect: THROWS,
  },
  {
    // a weak key filed under an unrelated keyId (the keyId of a good key): the predicate never looks at the keyId
    manifest: 'tamper/tamper-base.json',
    trust: [{ keyIdHex: generated.keyIdHex, publicKeyHex: byId.get('small-order-2').publicKeyHex }],
    allowTestKeys: false,
    expect: THROWS,
  },
  {
    // the all-zero key under keyId '0' * 64
    manifest: 'tamper/tamper-base.json',
    trust: [{ keyIdHex: '0'.repeat(64), publicKeyHex: '00'.repeat(32) }],
    allowTestKeys: false,
    expect: THROWS,
  },
  {
    // a weak key beside a good one: one weak key refuses the whole trust set
    manifest: 'tamper/tamper-base.json',
    trust: [...trustOf('ok-rfc8032-1'), ...trustOf('mixed-test1-plus-order8')],
    allowTestKeys: true,
    expect: THROWS,
  },
  {
    // a malformed manifest: the weak key is judged BEFORE the parse, so the verdict is not invalid_json
    manifest: 'tamper/tamper-07-truncated.txt',
    trust: trustOf('identity'),
    allowTestKeys: false,
    expect: THROWS,
  },
  {
    manifest: 'weak-keys/forged-order8.manifest.json',
    trust: trustOf('not-on-curve-smallest-y'),
    allowTestKeys: true,
    expect: THROWS,
  },
  {
    manifest: 'tamper/tamper-base.json',
    trust: trustOf('noncanonical-y-first-on-curve'),
    allowTestKeys: true,
    expect: THROWS,
  },
];

// ---- files --------------------------------------------------------------------------------------------
const pretty = (v) => JSON.stringify(v, null, 2) + '\n';
const files = new Map();
files.set('weak-keys/weak-keys.json', pretty(rows));
files.set('weak-keys/verify.json', pretty(verifyRows));
files.set('weak-keys/forged-identity.manifest.json', pretty(forgedIdentity));
files.set('weak-keys/forged-order8.manifest.json', pretty(forgedOrder8));

const classCounts = new Map();
for (const r of rows) classCounts.set(r.class, (classCounts.get(r.class) ?? 0) + 1);
const classTable = [...classCounts].map(([c, n]) => `| \`${c}\` | ${n} |`).join('\n');
files.set(
  'weak-keys/README.md',
  `# Weak-key vectors (manifest 0.1.3)

Generated by \`node test/tools/make-weak-key-vectors.mjs\` (\`--check\` verifies); vendored byte for byte into
\`control-plane/crates/cp-manifest/tests/fixtures/vectors/\`. Every hex value is derived by computation (see the
tool): small-order points by solving the curve and checking the order, \`mixed_order\` as the RFC 8032 TEST 1
point plus a small-order point, \`not_on_curve\` as the smallest y with no square root, \`noncanonical_y\` as
y + p. The tool asserts each class ([L]P = O and P != O for the accepted rows; [8]P != O and [L]P != O for
mixed order; [8]P = O for small order).

\`weak-keys.json\` has ${rows.length} rows \`{ id, publicKeyHex, keyIdHex, class, expect, why }\`: ${refusedCount} refused
(\`expect\` 'weak_key_refused') and ${rows.length - refusedCount} accepted (\`expect\` 'ok': the five RFC 8032 test keys,
judged with \`allowTestKeys\` true, and one generated key). An implementation gives each row its verdict from the 32
bytes alone; \`keyIdHex\` is informational because the predicate never reads it.

| class | rows |
| ----- | ---- |
${classTable}

\`verify.json\` has ${verifyRows.length} rows \`{ manifest, trust, allowTestKeys, expect: { throws } }\`. \`manifest\` is a path
relative to \`vectors/\`; \`trust\` lists \`{ keyIdHex, publicKeyHex }\` entries (the keyId is filed as given, even when it
is not the hash of the key); every row must throw \`weak_key_refused\` from the verifier, before the manifest is
parsed. Two manifests are forged: \`forged-identity.manifest.json\` carries the signature R = identity, S = 0 under
the identity key, and \`forged-order8.manifest.json\` (a 0.1.2-shaped manifest) a signature found by grinding under
an order-8 key. A verifier without the 0.1.3 rule can accept them; 0.1.3 refuses the trust set.
`,
);

// JSON is formatted with the repository's prettier configuration so the committed bytes survive fmt:check
const prettierOptions = {
  ...((await resolveConfig(resolve(outDir, 'x.json'))) ?? {}),
  parser: 'json',
};
for (const [name, body] of files)
  if (name.endsWith('.json')) files.set(name, await format(body, prettierOptions));
const mdOptions = { ...((await resolveConfig(resolve(outDir, 'x.md'))) ?? {}), parser: 'markdown' };
files.set('weak-keys/README.md', await format(files.get('weak-keys/README.md'), mdOptions));

const check = process.argv.includes('--check');
let bad = 0;
const root = resolve(spec, 'vectors');
if (!check) mkdirSync(outDir, { recursive: true });
for (const [name, body] of files) {
  const path = resolve(root, name);
  const want = Buffer.from(body, 'utf8');
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(want)) {
      console.error(`stale: ${name}`);
      bad++;
    }
  } else writeFileSync(path, want);
}
if (check) {
  const extra = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => !files.has(`weak-keys/${f}`))
    : [];
  for (const f of extra) {
    console.error(`unexpected: weak-keys/${f}`);
    bad++;
  }
  if (bad) process.exit(1);
  console.log(
    `weak-key vectors up to date (${files.size} files, ${rows.length} rows, ${refusedCount} refused)`,
  );
} else {
  console.log(
    `wrote ${files.size} files under ${root} (${rows.length} rows, ${refusedCount} refused)`,
  );
  console.log(
    `informative: platform Ed25519 verify accepts forged-identity: ${platformAccepts(forgedIdentity)}; forged-order8: ${platformAccepts(forgedOrder8)}`,
  );
}
