// Independent reference implementation of the manifest canonicalisation and Ed25519 signing
// used by the tool scripts (make-vectors.mjs, sign-example.mjs). It deliberately does NOT import
// the TypeScript sources in src/, so the generated vectors are an independent oracle that
// test/canonical.test.ts checks the library against.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export const PREFIX = 'airplanemode-manifest-v1\n';
export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * RFC 8032 section 7.1 test vector 1. PUBLIC, NON-SECRET test data; must never be trusted
 * outside tests (verifyManifest refuses it unless allowTestKeys; cp-sign unless --allow-test-key).
 */
export const RFC8032_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const RFC8032_PUBLIC_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

/**
 * The five RFC 8032 section 7.1 test key pairs (PUBLIC, NON-SECRET test data), by the names the
 * tamper vectors use for trust sets. 'rfc8032-1' and 'rfc8032-2' are the only two the vectors sign
 * with; all five are refused in a trust set unless allowTestKeys === true. The RFC text wins on any
 * mismatch with this table (test/spec-0.4.test.ts re-derives every public key and keyId).
 */
export const RFC8032_TEST_KEYS = Object.freeze([
  {
    name: 'rfc8032-1',
    label: 'TEST 1',
    seedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  },
  {
    name: 'rfc8032-2',
    label: 'TEST 2',
    seedHex: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicHex: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  },
  {
    name: 'rfc8032-3',
    label: 'TEST 3',
    seedHex: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicHex: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
  },
  {
    name: 'rfc8032-1024',
    label: 'TEST 1024',
    seedHex: 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5',
    publicHex: '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e',
  },
  {
    name: 'rfc8032-sha-abc',
    label: 'TEST SHA(abc)',
    seedHex: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
    publicHex: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
  },
]);

/** The order of the Ed25519 base point: L = 2^252 + 27742317777372353535851937790883648493. */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * Returns the signature with its S half (bytes 32..63, little-endian) replaced by S + L. Still 64
 * bytes, because S < L < 2^253. A verifier that does not require S < L would accept it (it is the
 * classic Ed25519 malleability); RFC 8032 section 5.1.7 says it MUST be rejected.
 */
export function addLToS(sigBytes) {
  const out = Buffer.from(sigBytes);
  const s = BigInt('0x' + Buffer.from(out.subarray(32)).reverse().toString('hex'));
  const t = s + ED25519_L;
  const hex = t.toString(16).padStart(64, '0');
  Buffer.from(hex, 'hex').reverse().copy(out, 32);
  return out;
}

export class CanonicalError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function sortValue(v, path) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (!v.isWellFormed()) throw new CanonicalError('lone_surrogate', `lone surrogate at ${path}`);
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || Object.is(v, -0))
      throw new CanonicalError('float', `non-integer number at ${path}`);
    if (v < 0 || v > MAX_SAFE)
      throw new CanonicalError('bigint', `integer out of range at ${path}`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => sortValue(x, `${path}/${i}`));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (!KEY_PATTERN.test(k)) {
        const reason = /^[0-9]/.test(k) ? 'digit_key' : 'invalid_key';
        throw new CanonicalError(reason, `bad object key ${JSON.stringify(k)} at ${path}`);
      }
      out[k] = sortValue(v[k], `${path}/${k}`);
    }
    return out;
  }
  throw new CanonicalError('invalid_type', `unsupported value at ${path}`);
}

/** Canonical JSON text (restricted RFC 8785 profile). */
export function canonicalize(value) {
  return JSON.stringify(sortValue(value, ''));
}

/** Bytes that are signed: PREFIX || canonical(manifest without `signatures`). */
export function signedBytes(manifest) {
  const { signatures: _ignored, ...body } = manifest;
  return Buffer.from(PREFIX + canonicalize(body), 'utf8');
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function privateKeyFromSeed(seedHex) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

export function keyIdOf(rawPub) {
  return createHash('sha256').update(rawPub).digest('hex');
}

export function signManifest(manifest, seedHex, signedAt) {
  const priv = privateKeyFromSeed(seedHex);
  const pub = rawPublicKey(priv);
  const sig = sign(null, signedBytes(manifest), priv);
  return {
    alg: 'ed25519',
    keyId: keyIdOf(pub),
    publicKey: pub.toString('base64'),
    sig: sig.toString('base64'),
    signedAt,
  };
}

/**
 * Signs with an in-memory KeyObject instead of a seed (demo/tools/make-fixture.mjs: a key pair from
 * generateKeyPairSync that is never exported). Same wire format as signManifest.
 */
export function signManifestWithKey(manifest, privateKeyObject, signedAt) {
  const pub = rawPublicKey(privateKeyObject);
  const sig = sign(null, signedBytes(manifest), privateKeyObject);
  return {
    alg: 'ed25519',
    keyId: keyIdOf(pub),
    publicKey: pub.toString('base64'),
    sig: sig.toString('base64'),
    signedAt,
  };
}

/**
 * A fresh Ed25519 key pair (crypto.generateKeyPairSync) whose signing half lives only inside this
 * closure: callers get the public bytes and a sign() function, never the KeyObject. Used by
 * demo/tools/make-fixture.mjs so each demo build is signed by a key that exists for that build only.
 */
export function ephemeralSigner() {
  const pair = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(pair.privateKey);
  return {
    publicKeyHex: pub.toString('hex'),
    keyId: keyIdOf(pub),
    sign: (manifest, signedAt) => signManifestWithKey(manifest, pair.privateKey, signedAt),
  };
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySig(manifest, sigB64, rawPubHex) {
  const pub = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPubHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, signedBytes(manifest), pub, Buffer.from(sigB64, 'base64'));
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
