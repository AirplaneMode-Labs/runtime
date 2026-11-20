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
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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

// =====================================================================================================
// Release manifests (spec release 0.6.1, manifest 0.1.4 "Release manifests", rules R1 to R5).
//
// An independent oracle: it never imports src/ or spec/. test/tools/make-release-vectors.mjs builds the
// vectors with it, test/spec-0.6.1.test.ts runs every release.json case through oracleReleaseVerify, and
// test/release-tool.test.ts then checks the real tool (src/release/, the bundle) against the same cases.
// It is a verifier written from the specification for the cases in the vectors, not a second product: for
// the weak-key rule it knows the small-order encodings by value (the full predicate is checked by
// test/weak-keys.test.ts against its own Edwards oracle).
// =====================================================================================================

export const RELEASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,118}-release$/;
export const REHEARSAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,116}-rehearsal$/;
export const RELEASE_PUBLISHER = 'Airplane Mode Labs';
export const REHEARSAL_PUBLISHER =
  'Airplane Mode Labs REHEARSAL: signed with the published RFC 8032 test key; not a release';
export const RELEASE_KEYS_SPEC = 'airplanemode.release-keys/0.1';

/**
 * A deterministic, public, NON-SECRET key that is NOT an RFC 8032 test key, used only to build the production
 * path vectors (vk-release, vk-publisher, keys/vector-key.json). The seed is SHA-256 of a fixed phrase and
 * lives only in this file; the vectors carry its public key. Nothing real is ever signed with it.
 */
export const VECTOR_KEY_SEED_HEX = createHash('sha256')
  .update('airplanemode release vector key 1')
  .digest('hex');

/** A synthetic key pair from a label: SHA-256 of 'airplanemode release synthetic key <label>' is the seed. */
export function syntheticSeedHex(label) {
  return createHash('sha256').update(`airplanemode release synthetic key ${label}`).digest('hex');
}

export function publicKeyOfSeedHex(seedHex) {
  return rawPublicKey(privateKeyFromSeed(seedHex));
}

/** Canonical padded standard base64 and the keyId of a raw public key. */
export const keyEntryOf = (rawPub) => ({
  keyId: keyIdOf(rawPub),
  publicKey: Buffer.from(rawPub).toString('base64'),
});

export const RELEASE_MEDIA_TYPES = [
  ['.tar.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.crate', 'application/gzip'],
  ['.whl', 'application/zip'],
  ['.zip', 'application/zip'],
];
export function releaseMediaType(name) {
  for (const [suffix, type] of RELEASE_MEDIA_TYPES) if (name.endsWith(suffix)) return type;
  return 'application/octet-stream';
}

/** The member order of every release file: the order of the interfaces in spec/manifest.ts. */
function orderRelease(m) {
  const sigs = (m.signatures ?? []).map((g) => ({
    alg: g.alg,
    keyId: g.keyId,
    ...(g.publicKey !== undefined ? { publicKey: g.publicKey } : {}),
    sig: g.sig,
    signedAt: g.signedAt,
  }));
  const entries = m.entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    url: e.url,
    sha256: e.sha256,
    size: e.size,
    version: e.version,
    licence: e.licence,
    minProfile: e.minProfile,
    ...(e.mediaType !== undefined ? { mediaType: e.mediaType } : {}),
  }));
  return {
    spec: m.spec,
    id: m.id,
    version: m.version,
    publisher: m.publisher,
    createdAt: m.createdAt,
    ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
    entries,
    signatures: sigs,
  };
}

/** The text of a release-manifest.json: 2-space JSON in the fixed member order, LF, one final LF. */
export function releaseManifestText(m) {
  return JSON.stringify(orderRelease(m), null, 2) + '\n';
}

/** files: [{ name, bytes }]. The unsigned release manifest of those artefacts (entries sorted by name). */
export function buildReleaseManifest({ id, version, publisher, createdAt, licence, files }) {
  const entries = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => ({
      id: f.name,
      kind: 'other',
      url: f.name,
      sha256: sha256Hex(f.bytes),
      size: f.bytes.length,
      version,
      licence,
      minProfile: {},
      mediaType: releaseMediaType(f.name),
    }));
  return {
    spec: 'airplanemode.manifest/0.1',
    id,
    version,
    publisher,
    createdAt,
    entries,
    signatures: [],
  };
}

/** SHA256SUMS: '<64 lowercase hex>  <name>\n' per artefact, sorted by name in byte order, LF only. */
export function releaseSumsText(files) {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${sha256Hex(f.bytes)}  ${f.name}\n`)
    .join('');
}

/** The manifest with one signature of `seedHex` appended; signedAt equals createdAt (deterministic). */
export function signReleaseManifest(manifest, seedHex) {
  const g = signManifest(manifest, seedHex, manifest.createdAt);
  return { ...manifest, signatures: [...manifest.signatures, g] };
}

// ---- the oracle verifier ------------------------------------------------------------------------------

const WEAK_ENCODINGS = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
]);
const TEST_PUBLIC_SET = new Set(RFC8032_TEST_KEYS.map((k) => k.publicHex));

class OracleStop extends Error {
  constructor(kind, reason) {
    super(`${kind}: ${reason}`);
    this.kind = kind;
    this.reason = reason;
  }
}
const usage = (reason) => new OracleStop('usage', reason);
const refuse = (reason) => new OracleStop('refused', reason);

/** A tiny strict JSON parser that rejects repeated members (the oracle's own, independent of src/json-scan.ts). */
export function parseStrictJson(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \n\r\t'.includes(text[i])) i++;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error('key expected');
        const k = str();
        if (seen.has(k)) throw new Error(`repeated member ${k}`);
        seen.add(k);
        ws();
        if (text[i++] !== ':') throw new Error('colon expected');
        Object.defineProperty(o, k, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] === '}') return o;
        throw new Error('object not closed');
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] === ']') return a;
        throw new Error('array not closed');
      }
    }
    if (c === '"') return str();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?|^true|^false|^null/.exec(text.slice(i));
    if (!m) throw new Error('bad value');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const v = value();
  ws();
  if (i !== text.length) throw new Error('trailing data');
  return v;
}

function isRegular(path) {
  const st = lstatSync(path);
  return st.isFile() && !st.isSymbolicLink();
}

function parseKeysFile(text) {
  let doc;
  try {
    doc = parseStrictJson(text);
  } catch {
    throw refuse('bad_release_keys');
  }
  const exact = (o, names) =>
    o !== null &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    Object.keys(o).length === names.length &&
    names.every((n) => Object.prototype.hasOwnProperty.call(o, n));
  if (!exact(doc, ['spec', 'keys']) || doc.spec !== RELEASE_KEYS_SPEC || !Array.isArray(doc.keys))
    throw refuse('bad_release_keys');
  if (doc.keys.length > 8) throw refuse('bad_release_keys');
  const raws = [];
  for (const k of doc.keys) {
    if (
      !exact(k, ['keyId', 'publicKey']) ||
      typeof k.keyId !== 'string' ||
      typeof k.publicKey !== 'string'
    )
      throw refuse('bad_release_keys');
    const raw = Buffer.from(k.publicKey, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== k.publicKey)
      throw refuse('bad_release_keys');
    raws.push(raw);
  }
  for (const raw of raws)
    if (TEST_PUBLIC_SET.has(raw.toString('hex'))) throw refuse('test_key_refused');
  for (const raw of raws)
    if (WEAK_ENCODINGS.has(raw.toString('hex'))) throw refuse('weak_key_refused');
  const ids = new Set();
  for (const [n, k] of doc.keys.entries()) {
    if (keyIdOf(raws[n]) !== k.keyId || ids.has(k.keyId)) throw refuse('bad_release_keys');
    ids.add(k.keyId);
  }
  if (doc.keys.length === 0) throw refuse('no_trusted_key');
  return new Map(doc.keys.map((k, n) => [k.keyId, raws[n]]));
}

/**
 * The oracle verdict for one release.json case. Returns { exit, reason, testKey }. `args` are the case's
 * arguments without --dir; '@keys/<file>' stands for a file under `keysDir`.
 */
export async function oracleReleaseVerify({ command = 'verify', dir, args, keysDir }) {
  const opts = { flags: new Set() };
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a === '--allow-test-key' || a === '--trust-test-key') opts.flags.add(a);
    else opts[a.slice(2)] = args[++n];
  }
  if (opts['trust-file']?.startsWith('@keys/'))
    opts['trust-file'] = join(keysDir, opts['trust-file'].slice(6));
  const allow = opts.flags.has('--allow-test-key');
  const trustTest = opts.flags.has('--trust-test-key');
  try {
    if (command === 'sign') return oracleSign(dir, opts);
    if (opts['expect-id'] === undefined) throw usage('expect_id_required');
    const expectId = opts['expect-id'];
    if ((opts['trust-file'] !== undefined) === trustTest) throw usage('bad_trust_source');
    if ((allow || trustTest) && !REHEARSAL_ID_RE.test(expectId))
      throw usage('test_key_flag_misuse');
    if (allow && opts['trust-file'] !== undefined) throw usage('test_key_flag_misuse');
    if (!RELEASE_ID_RE.test(expectId) && !REHEARSAL_ID_RE.test(expectId))
      throw usage('bad_release_id');
    const dst = lstatSync(dir);
    if (dst.isSymbolicLink() || !dst.isDirectory()) throw refuse('not_regular_file');
    const mPath = join(dir, 'release-manifest.json');
    const sPath = join(dir, 'SHA256SUMS');
    if (!existsSyncLstat(mPath)) throw refuse('manifest_missing');
    if (!existsSyncLstat(sPath)) throw refuse('sums_missing');
    if (!isRegular(mPath) || !isRegular(sPath)) throw refuse('not_regular_file');
    let trust;
    if (trustTest) {
      const raw = Buffer.from(RFC8032_TEST_KEYS[0].publicHex, 'hex');
      trust = new Map([[keyIdOf(raw), raw]]);
    } else {
      trust = parseKeysFile(readFileSync(opts['trust-file'], 'utf8'));
    }
    const hasTest = [...trust.values()].some((raw) =>
      TEST_PUBLIC_SET.has(Buffer.from(raw).toString('hex')),
    );
    if (hasTest && !allow) throw refuse('test_key_refused');
    const manifestText = readFileSync(mPath, 'utf8');
    let m;
    try {
      m = parseStrictJson(manifestText);
    } catch {
      throw refuse('invalid_json');
    }
    const valid = [];
    for (const g of m.signatures ?? []) {
      const raw = trust.get(g.keyId);
      if (!raw || g.alg !== 'ed25519') continue;
      if (verifySig(m, g.sig, Buffer.from(raw).toString('hex'))) valid.push(g);
    }
    if (valid.length === 0) throw refuse('no_valid_signature');
    if (m.id !== expectId) throw refuse('unexpected_id');
    const usedTest = valid.some((g) =>
      TEST_PUBLIC_SET.has(Buffer.from(trust.get(g.keyId)).toString('hex')),
    );
    if (usedTest && !REHEARSAL_ID_RE.test(m.id)) throw refuse('test_key_release_id');
    const wantPublisher = RELEASE_ID_RE.test(m.id) ? RELEASE_PUBLISHER : REHEARSAL_PUBLISHER;
    if (m.publisher !== wantPublisher) throw refuse('publisher_mismatch');
    const names = readdirSync(dir).sort();
    for (const n of names) if (!isRegular(join(dir, n))) throw refuse('not_regular_file');
    for (const e of m.entries) {
      if (!names.includes(e.id)) throw refuse('artifact_missing');
      const bytes = readFileSync(join(dir, e.id));
      if (bytes.length !== e.size) throw refuse('artifact_size_mismatch');
      if (sha256Hex(bytes) !== e.sha256) throw refuse('artifact_hash_mismatch');
    }
    const known = new Set([...m.entries.map((e) => e.id), 'release-manifest.json', 'SHA256SUMS']);
    for (const n of names) if (!known.has(n)) throw refuse('artifact_extra');
    const sums = m.entries.map((e) => `${e.sha256}  ${e.id}\n`).join('');
    if (readFileSync(sPath).toString('latin1') !== sums) throw refuse('sums_mismatch');
    return { exit: 0, reason: null, testKey: usedTest };
  } catch (e) {
    if (e instanceof OracleStop)
      return { exit: e.kind === 'usage' ? 2 : 3, reason: e.reason, testKey: undefined };
    throw e;
  }
}

function existsSyncLstat(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function oracleSign(dir, opts) {
  if (opts['test-key'] !== 'rfc8032-1') throw usage('test_key_flag_misuse');
  const dst = lstatSync(dir);
  if (dst.isSymbolicLink() || !dst.isDirectory()) throw usage('not_regular_file');
  const m = parseStrictJson(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
  if (!REHEARSAL_ID_RE.test(m.id)) throw usage('test_key_release_id');
  if ((m.signatures ?? []).length > 0) throw usage('already_signed');
  if (m.publisher !== REHEARSAL_PUBLISHER) throw usage('publisher_mismatch');
  return { exit: 0, reason: null, testKey: true };
}

/**
 * Copies releaseDir/<dirName> to destDir and applies one mutation (see spec/vectors/release/README.md for the
 * vocabulary). Returns { dir }: the directory to pass as --dir (a link to destDir for 'symlink-dir').
 * Link operations that the platform refuses THROW: a containment test that cannot run must fail, never skip.
 */
export async function applyReleaseMutation(releaseDir, dirName, destDir, mutation, { work }) {
  cpSync(join(releaseDir, dirName), destDir, { recursive: true });
  const op = mutation?.op ?? 'none';
  const file = (n) => join(destDir, n);
  const textOf = (n) => readFileSync(file(n), 'utf8');
  const link = (kind, target, path) => {
    try {
      if (kind === 'dir' && process.platform === 'win32') symlinkSync(target, path, 'junction');
      else symlinkSync(target, path, kind === 'dir' ? 'dir' : 'file');
    } catch (e) {
      throw new Error(
        `cannot create a ${kind} link on ${process.platform} (${e.code ?? 'error'}): the not_regular_file case cannot run here and must not be skipped`,
      );
    }
  };
  switch (op) {
    case 'none':
      break;
    case 'flip-byte': {
      const b = readFileSync(file(mutation.file));
      b[mutation.offset ?? 0] ^= 0x01;
      writeFileSync(file(mutation.file), b);
      break;
    }
    case 'truncate': {
      const b = readFileSync(file(mutation.file));
      writeFileSync(file(mutation.file), b.subarray(0, b.length - (mutation.bytes ?? 1)));
      break;
    }
    case 'remove':
      rmSync(file(mutation.file));
      break;
    case 'add-file':
      writeFileSync(file(mutation.file), mutation.content);
      break;
    case 'sums-edit': {
      const lines = textOf('SHA256SUMS').split('\n');
      const l = lines[mutation.line ?? 0];
      lines[mutation.line ?? 0] = (l[0] === '0' ? '1' : '0') + l.slice(1);
      writeFileSync(file('SHA256SUMS'), lines.join('\n'));
      break;
    }
    case 'sums-crlf':
      writeFileSync(file('SHA256SUMS'), textOf('SHA256SUMS').replace(/\n/g, '\r\n'));
      break;
    case 'sums-reorder': {
      const lines = textOf('SHA256SUMS').split('\n').filter(Boolean).reverse();
      writeFileSync(file('SHA256SUMS'), lines.join('\n') + '\n');
      break;
    }
    case 'manifest-publisher-edit': {
      const m = JSON.parse(textOf('release-manifest.json'));
      m.publisher = `${m.publisher} (edited)`;
      writeFileSync(file('release-manifest.json'), JSON.stringify(m, null, 2) + '\n');
      break;
    }
    case 'symlink-artifact': {
      const real = join(work, `real-${mutation.file}`);
      renameSync(file(mutation.file), real);
      link('file', real, file(mutation.file));
      break;
    }
    case 'junction-artifact': {
      const real = join(work, `real-dir-${mutation.file}`);
      mkdirSync(real);
      rmSync(file(mutation.file));
      link('dir', real, file(mutation.file));
      break;
    }
    case 'subdir':
      mkdirSync(file(mutation.name ?? 'sub'));
      break;
    case 'symlink-dir': {
      const l = join(work, 'dirlink');
      link('dir', destDir, l);
      return { dir: l };
    }
    default:
      throw new Error(`unknown mutation ${op}`);
  }
  return { dir: destDir };
}
