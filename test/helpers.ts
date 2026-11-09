// Shared test helpers. Signing uses node:crypto (tests only); the RFC 8032 section 7.1 test
// vectors are public, non-secret data.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest, ManifestEntry, Signature } from '../spec/manifest';
import { signedBytes } from '../src/canonical';

export const testDir = dirname(fileURLToPath(import.meta.url));
export const repoDir = resolve(testDir, '..');
export const specDir = resolve(repoDir, 'spec');

/** RFC 8032 test vector 1 (seed and public key). */
export const RFC8032_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const RFC8032_PUBLIC_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
/** RFC 8032 test vector 2: a second key pair for wrong-key cases. */
export const OTHER_SEED_HEX = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
export const OTHER_PUBLIC_HEX = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';

export const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
export const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

export const RFC8032_PUBLIC = hexToBytes(RFC8032_PUBLIC_HEX);
export const OTHER_PUBLIC = hexToBytes(OTHER_PUBLIC_HEX);

export function keyIdOf(pub: Uint8Array): string {
  return createHash('sha256').update(pub).digest('hex');
}
export const RFC8032_KEY_ID = keyIdOf(RFC8032_PUBLIC);
export const OTHER_KEY_ID = keyIdOf(OTHER_PUBLIC);

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519Sign(message: Uint8Array, seedHex: string): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(sign(null, message, key));
}

export function publicKeyOfSeed(seedHex: string): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

export function makeSignature(
  manifest: Manifest,
  seedHex = RFC8032_SEED_HEX,
  opts: { signedAt?: string; includePublicKey?: boolean } = {},
): Signature {
  const pub = publicKeyOfSeed(seedHex);
  const sig = ed25519Sign(signedBytes(manifest), seedHex);
  const s: Signature = {
    alg: 'ed25519',
    keyId: keyIdOf(pub),
    sig: b64(sig),
    signedAt: opts.signedAt ?? '2026-11-09T00:00:00Z',
  };
  if (opts.includePublicKey !== false) s.publicKey = b64(pub);
  return s;
}

/** Returns a copy of `manifest` with one signature under `seedHex` appended. */
export function signManifest(manifest: Manifest, seedHex = RFC8032_SEED_HEX): Manifest {
  return { ...manifest, signatures: [...manifest.signatures, makeSignature(manifest, seedHex)] };
}

export function testTrust(): Map<string, Uint8Array> {
  return new Map([[RFC8032_KEY_ID, RFC8032_PUBLIC]]);
}

export function otherTrust(): Map<string, Uint8Array> {
  return new Map([[OTHER_KEY_ID, OTHER_PUBLIC]]);
}

export const ZERO_SHA = '0'.repeat(64);

export function makeEntry(id: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    id,
    kind: 'data',
    url: `assets/${id}`,
    sha256: ZERO_SHA,
    size: 0,
    version: '1.0.0',
    licence: 'Apache-2.0',
    minProfile: {},
    ...overrides,
  };
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    spec: 'airplanemode.manifest/0.1',
    id: 'dev.airplanemode.test',
    version: '1.0.0',
    publisher: 'Airplane Mode Labs (test)',
    createdAt: '2026-11-09T00:00:00Z',
    entries: [makeEntry('a')],
    signatures: [],
    ...overrides,
  };
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function sha256HexNode(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic pseudo-random bytes for tests (not the asset stream). */
export function pseudoRandomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
