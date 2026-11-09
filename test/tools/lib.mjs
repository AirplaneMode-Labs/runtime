// Independent reference implementation of the manifest canonicalisation and Ed25519 signing
// used by the tool scripts (make-vectors.mjs, sign-example.mjs). It deliberately does NOT import
// the TypeScript sources in src/, so the generated vectors are an independent oracle that
// test/canonical.test.ts checks the library against.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

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
