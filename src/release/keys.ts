/**
 * Keys of the release tool (manifest 0.1.4, "Release manifests").
 *
 * - The release-keys file (`docs/release-keys.json`, RELEASE_KEYS_SPEC) is read with the strict scan of the manifest
 *   parser (no repeated member, no lone surrogate, no float: json-scan.ts and checkParsed), never a bare JSON.parse,
 *   and every shape rule of the spec is enforced here: exactly the members `spec` and `keys`, each key exactly
 *   `keyId` and `publicKey`, at most RELEASE_KEYS_MAX keys, canonical padded base64 of 32 bytes. Each key is
 *   normalised to its bytes (normaliseKeyBytes), then checked against the five RFC 8032 test keys, then against the
 *   weak-key rule, and only then are a keyId that is not the SHA-256 of the key and a repeated keyId looked at.
 * - The rehearsal key is RFC 8032 section 7.1 TEST 1, a published, non-secret test vector. Its seed is a literal in
 *   this file and nothing can name another one: the tool has no option that reads a key file. The seed signs
 *   `-rehearsal` manifests only (tool.ts refuses any other id before it gets here).
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  RFC8032_TEST_KEY_IDS,
  RFC8032_TEST_PUBLIC_KEYS_HEX,
  type Manifest,
  type Signature,
} from '../../spec/manifest';
import { RELEASE_KEYS_MAX, RELEASE_KEYS_SPEC } from '../../spec/release';
import { signedBytes } from '../canonical';
import { isWeakEd25519PublicKey } from '../ed25519-point';
import { checkParsed, decodeBase64, normaliseKeyBytes, parseJsonText } from '../manifest';
import { ReleaseStop } from './fsutil';

/** RFC 8032 section 7.1 TEST 1 seed: PUBLIC, NON-SECRET test data. The only key this tool can sign with. */
const TEST1_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
/** The PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_PREFIX_HEX = '302e020100300506032b657004220420';

const TEST_PUBLIC_KEYS: readonly Uint8Array[] = RFC8032_TEST_PUBLIC_KEYS_HEX.map(
  (h) => new Uint8Array(Buffer.from(h, 'hex')),
);
const TEST_KEY_ID_SET: ReadonlySet<string> = new Set(RFC8032_TEST_KEY_IDS);

/** The raw TEST 1 public key and its keyId. */
export const TEST1_PUBLIC: Uint8Array = TEST_PUBLIC_KEYS[0]!;
export const TEST1_KEY_ID: string = RFC8032_TEST_KEY_IDS[0];

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** True when the keyId or the raw 32 key bytes are one of the five RFC 8032 section 7.1 test keys. */
export function isRfc8032TestKey(keyId: unknown, raw: unknown): boolean {
  if (typeof keyId === 'string' && TEST_KEY_ID_SET.has(keyId)) return true;
  const bytes = normaliseKeyBytes(raw);
  return (
    bytes instanceof Uint8Array &&
    bytes.length === 32 &&
    TEST_PUBLIC_KEYS.some((p) => same(p, bytes))
  );
}

export interface ReleaseKey {
  keyId: string;
  raw: Uint8Array;
}

const bad = (message: string): ReleaseStop => new ReleaseStop('bad_release_keys', message);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const hasExactly = (o: Record<string, unknown>, names: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === names.length && names.every((n) => own.includes(n));
};

/**
 * Parses the text of a release-keys file. Throws ReleaseStop: `bad_release_keys`, `test_key_refused`,
 * `weak_key_refused` or `no_trusted_key` (a file with no keys).
 */
export function parseReleaseKeys(text: string): ReleaseKey[] {
  let doc: unknown;
  try {
    doc = parseJsonText(text); // a repeated member name, at any depth, is refused here
    checkParsed(doc, ''); // no float, no lone surrogate, no digit-leading or odd key, plain objects only
  } catch (e) {
    throw bad(`not a valid release-keys document: ${(e as Error).message}`);
  }
  if (!isPlainObject(doc) || !hasExactly(doc, ['spec', 'keys']))
    throw bad('the file must have exactly the members "spec" and "keys"');
  if (doc['spec'] !== RELEASE_KEYS_SPEC) throw bad(`spec must be ${RELEASE_KEYS_SPEC}`);
  const list = doc['keys'];
  if (!Array.isArray(list)) throw bad('"keys" must be an array');
  if (list.length > RELEASE_KEYS_MAX) throw bad(`at most ${RELEASE_KEYS_MAX} keys`);
  const keys: ReleaseKey[] = [];
  for (const k of list as unknown[]) {
    if (!isPlainObject(k) || !hasExactly(k, ['keyId', 'publicKey']))
      throw bad('each key must have exactly "keyId" and "publicKey"');
    const { keyId, publicKey } = k;
    if (typeof keyId !== 'string' || typeof publicKey !== 'string')
      throw bad('"keyId" and "publicKey" must be strings');
    const decoded = decodeBase64(publicKey); // canonical padded base64 only
    const raw = normaliseKeyBytes(decoded);
    if (!(raw instanceof Uint8Array) || raw.length !== 32)
      throw bad('"publicKey" must be canonical padded base64 of 32 bytes');
    keys.push({ keyId, raw });
  }
  // test keys first, weak keys second, over every key, before any other consistency rule
  for (const k of keys)
    if (isRfc8032TestKey(undefined, k.raw))
      throw new ReleaseStop('test_key_refused', 'the release-keys file holds an RFC 8032 test key');
  for (const k of keys)
    if (isWeakEd25519PublicKey(k.raw))
      throw new ReleaseStop('weak_key_refused', 'the release-keys file holds a weak Ed25519 key');
  const seen = new Set<string>();
  for (const k of keys) {
    if (createHash('sha256').update(k.raw).digest('hex') !== k.keyId)
      throw bad('a keyId is not the SHA-256 of its publicKey');
    if (seen.has(k.keyId)) throw bad('a keyId is repeated');
    seen.add(k.keyId);
  }
  if (keys.length === 0)
    throw new ReleaseStop('no_trusted_key', 'the release-keys file has no keys');
  return keys;
}

/**
 * One TEST 1 signature over the manifest (without its signatures member), in the spec's wire form. signedAt is
 * the manifest's createdAt, so the output is deterministic. node:crypto signs; Ed25519 is deterministic.
 */
export function signWithTestKey1(manifest: Manifest): Signature {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8_PREFIX_HEX, 'hex'), Buffer.from(TEST1_SEED_HEX, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  // the derived public key must be TEST 1's: a mismatch would mean this file was edited
  if (!same(pub, TEST1_PUBLIC))
    throw new Error('internal error: TEST 1 seed and public key disagree');
  const sig = sign(null, signedBytes(manifest), key);
  return {
    alg: 'ed25519',
    keyId: TEST1_KEY_ID,
    publicKey: Buffer.from(pub).toString('base64'),
    sig: Buffer.from(sig).toString('base64'),
    signedAt: manifest.createdAt,
  };
}
