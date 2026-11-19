/**
 * Manifest parsing and verification (manifest spec v0.1, manifest 0.1.3). See spec/MANIFEST.md.
 *
 * 0.1.3: a trust set holding a weak Ed25519 public key (not the canonical encoding of a prime-order point other
 * than the identity: see src/ed25519-point.ts) is refused with ManifestError('weak_key_refused') BEFORE anything
 * is parsed, right after the test-key check, with no option to skip it; and again for the key a signature
 * actually uses (step 5), so a trust Map whose iterator hides a key is still caught. The check reads only the 32
 * key bytes, never the keyId, and keeps no state. A key that is not 32 bytes keeps its 0.1.2 outcome.
 *
 * 0.1.2: an optional `expectId` pins the manifest id. An invalid value throws TypeError('invalid expectId')
 * before anything is parsed (a caller error, no reason); a validly signed manifest of another id is refused
 * with `unexpected_id` after the signature check and BEFORE the downgrade state is read, so the state store
 * is neither read nor written for it. Without expectId every verdict is the 0.1.1 verdict.
 *
 * test keys (before anything is parsed) -> parse (repeated members, floats, > 2^53-1, digit-leading
 * keys, lone surrogates; over the whole document, signatures[] included) -> schema (the manifest schema
 * with the published Signature schema applied to every signatures[] item, calendar-valid timestamps)
 * -> expiry -> signatures (S < L, then Ed25519) -> downgrade rule. The reason of a refusal is the first
 * stage that fails (MANIFEST_REJECT_PRECEDENCE). verifyManifest takes the manifest text or an
 * already-parsed object and re-runs the parse and schema stage on it, so malformed input (or malformed
 * signature material) is a rejection with a reason, never an exception; the only throw is the test-key
 * refusal. An unreadable downgrade-state store fails closed (reason 'state'), and the store is written
 * only after a valid signature and a passed downgrade check.
 */

import type { EventSink } from '../spec/event';
import {
  MANIFEST_SPEC,
  RFC8032_TEST_KEY_IDS,
  RFC8032_TEST_PUBLIC_KEYS_HEX,
  WEAK_KEY_REFUSED_MESSAGE,
  type Manifest,
  type ManifestRejectReason,
  type SignatureInvalidReason,
} from '../spec/manifest';
import { CANONICAL_KEY_PATTERN } from '../spec/manifest';
import { CanonicalError, signedBytes } from './canonical';
import { isWeakEd25519PublicKey } from './ed25519-point';
import { newEvent } from './events';
import { hasRepeatedMember } from './json-scan';
import { SCHEMAS, validateSchema } from './schema';
import { compareSemver, parseSemver } from './semver';
import { sha256, toHex } from './sha256';

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
  readonly reason: ManifestRejectReason;
  readonly path: string | undefined;

  constructor(reason: ManifestRejectReason, message: string, path?: string) {
    super(message);
    this.reason = reason;
    this.path = path;
  }
}

/**
 * keyId of RFC 8032 section 7.1 TEST 1 (the key that signs the examples and vectors). All five test
 * keys are refused in a trust set unless allowTestKeys === true: see RFC8032_TEST_KEY_IDS.
 */
export const RFC8032_TEST_KEY_ID: string = RFC8032_TEST_KEY_IDS[0];

const TEST_KEY_ID_SET: ReadonlySet<string> = new Set(RFC8032_TEST_KEY_IDS);
const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
const TEST_PUBLIC_KEYS: readonly Uint8Array[] = RFC8032_TEST_PUBLIC_KEYS_HEX.map(hexBytes);

/** The order of the Ed25519 base point L = 2^252 + 27742317777372353535851937790883648493, little-endian. */
const ED25519_L_LE = Uint8Array.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
]);

/**
 * True when the 32-byte little-endian S half of a 64-byte Ed25519 signature is >= L (RFC 8032 section
 * 5.1.7 requires S < L). Checked here, before WebCrypto, so the verdict does not depend on the engine.
 */
export function isNonCanonicalS(sig: Uint8Array): boolean {
  for (let i = 31; i >= 0; i--) {
    const s = sig[32 + i]!;
    const l = ED25519_L_LE[i]!;
    if (s !== l) return s > l;
  }
  return true; // S == L
}

/**
 * S1-121: a trust value is judged by its bytes, never by its realm or view type. Any ArrayBuffer.isView value or
 * ArrayBuffer of exactly 32 bytes (from this realm or another) is copied into a fresh same-realm Uint8Array; any
 * other value is returned unchanged and keeps its 0.1.2 outcome. Pure: no cache, nothing stored on the trust set.
 */
export function normaliseKeyBytes(value: unknown): unknown {
  try {
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength !== 32) return value;
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + 32));
    }
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
      const buf = value as ArrayBuffer;
      if (buf.byteLength !== 32) return value;
      return new Uint8Array(buf.slice(0));
    }
  } catch {
    // a hostile or detached value: left as it is
  }
  return value;
}

/** True when `keyId` or the raw 32 bytes `bytes` are one of the five RFC 8032 section 7.1 test keys. */
function isTestKey(keyId: unknown, raw: unknown): boolean {
  if (typeof keyId === 'string' && TEST_KEY_ID_SET.has(keyId)) return true;
  const bytes = normaliseKeyBytes(raw);
  return (
    bytes instanceof Uint8Array &&
    bytes.length === 32 &&
    TEST_PUBLIC_KEYS.some((pub) => bytesEqual(pub, bytes))
  );
}

function refuseTestKey(
  message = 'trust set contains an RFC 8032 test key; pass allowTestKeys: true in tests only',
): never {
  throw new ManifestError('test_key_refused', message);
}

const UNCHECKABLE_TRUST =
  'trust set is not a Map or cannot be iterated, so it cannot be shown to be free of RFC 8032 test keys; it is refused like one that holds one (pass allowTestKeys: true in tests only)';

/**
 * Throws ManifestError('test_key_refused') when `trust` holds any of the five RFC 8032 section 7.1 test
 * keys, matched by keyId AND by the raw 32 public-key bytes under any keyId, unless `allowTestKeys` is
 * exactly the boolean true (the string 'true', 1 and every other value count as false).
 *
 * Fails closed (S1-089): a trust set that is not a Map, or that cannot be iterated, cannot be shown
 * to be free of test keys, so it is refused too. The signature loop of verifyManifest repeats the check
 * for every key it actually uses, so a Map subclass that hides keys from iteration is caught there.
 */
export function assertTestKeysAllowed(trust: TrustSet, allowTestKeys: unknown): void {
  if (allowTestKeys === true) return;
  if (!(trust instanceof Map)) refuseTestKey(UNCHECKABLE_TRUST);
  let found = false;
  try {
    for (const [keyId, bytes] of trust) {
      if (isTestKey(keyId, bytes)) {
        found = true;
        break;
      }
    }
  } catch {
    refuseTestKey(UNCHECKABLE_TRUST); // iteration threw: the set is hostile or broken, and is never trusted
  }
  if (found) refuseTestKey();
}

function refuseWeakKey(): never {
  throw new ManifestError('weak_key_refused', WEAK_KEY_REFUSED_MESSAGE);
}

/** True when `bytes` is a 32-byte Uint8Array that is a weak key. Any other value is outside the rule. */
function isWeakTrustedKey(raw: unknown): boolean {
  const bytes = normaliseKeyBytes(raw);
  return bytes instanceof Uint8Array && bytes.length === 32 && isWeakEd25519PublicKey(bytes);
}

/**
 * Throws ManifestError('weak_key_refused') when `trust` holds a weak Ed25519 public key (manifest 0.1.3): any
 * 32-byte value that is not the canonical encoding of a prime-order point other than the identity (an identity
 * or small-order point, a mixed-order point, a non-canonical encoding, bytes that are not on the curve). It runs
 * over the iterated trust set, always: there is no opt-out, and `allowTestKeys` does not affect it. It reads only
 * the key bytes, never the keyId, and stores nothing on `trust`.
 *
 * A trust set that cannot be iterated is not checked here; the signature loop of verifyManifest repeats the check
 * for the key it actually uses, so a Map that hides keys from iteration is still caught.
 */
export function assertNoWeakKeys(trust: TrustSet): void {
  let weak = false;
  try {
    for (const [, bytes] of trust) {
      if (isWeakTrustedKey(bytes)) {
        weak = true;
        break;
      }
    }
  } catch {
    return; // not iterable: step 5 guards the key in use
  }
  if (weak) refuseWeakKey();
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KEY_ID = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** No valid manifest or descriptor is nested deeper than 5 levels; a deeper document is refused as schema. */
const MAX_NESTING = 32;

/** Walks a parsed JSON value and rejects floats, out-of-range integers, bad keys and lone surrogates. */
export function checkParsed(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_NESTING)
    throw new ManifestError('schema', `nesting deeper than ${MAX_NESTING} levels`, path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!value.isWellFormed())
      throw new ManifestError('lone_surrogate', `lone surrogate in string at ${path || '/'}`, path);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Object.is(value, -0))
      throw new ManifestError('float', `non-integer number at ${path || '/'}`, path);
    if (value < 0 || value > Number.MAX_SAFE_INTEGER)
      throw new ManifestError('bigint', `integer outside 0..2^53-1 at ${path || '/'}`, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkParsed(v, `${path}/${i}`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    // Only plain objects (BUG-T2-S4-11): a member inherited through a custom prototype is not an own member,
    // so no signature covers it, yet a consumer reading entry.pin or entry.chunkSize would see it. JSON.parse
    // only ever builds plain objects; this guards an already-parsed object handed to the verifier.
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null)
      throw new ManifestError(
        'schema',
        `object at ${path || '/'} does not have the plain Object prototype`,
        path,
      );
    for (const key of Object.keys(value)) {
      if (/^[0-9]/.test(key))
        throw new ManifestError(
          'digit_key',
          `digit-leading object key ${JSON.stringify(key)} at ${path || '/'}`,
          path,
        );
      if (!CANONICAL_KEY_PATTERN.test(key))
        throw new ManifestError(
          'invalid_key',
          `object key ${JSON.stringify(key)} not allowed at ${path || '/'}`,
          path,
        );
      checkParsed((value as Record<string, unknown>)[key], `${path}/${key}`, depth + 1);
    }
    return;
  }
  throw new ManifestError('schema', `unsupported value at ${path || '/'}`, path);
}

/**
 * True when `v` is an RFC 3339 UTC timestamp of the exact form YYYY-MM-DDTHH:MM:SSZ that is also
 * calendar-valid: Date.parse is finite and the value round-trips through toISOString. This is the
 * same rule cp-manifest applies (month, day, hour, minute, second ranges), so both sides reject
 * 2026-99-99T00:00:00Z and 2026-02-29T00:00:00Z.
 */
export function isCalendarValidRfc3339(v: unknown): v is string {
  if (typeof v !== 'string' || !RFC3339.test(v)) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().replace('.000Z', 'Z') === v;
}

const TIMESTAMP_PATHS = ['/createdAt', '/expiresAt'] as const;

/** Enforces calendar validity for createdAt, expiresAt and every signature's signedAt. */
function checkTimestamps(manifest: Manifest): void {
  const obj = manifest as unknown as Record<string, unknown>;
  for (const path of TIMESTAMP_PATHS) {
    const key = path.slice(1);
    const v = obj[key];
    if (v !== undefined && !isCalendarValidRfc3339(v))
      throw new ManifestError(
        'schema',
        `${path}: not a calendar-valid RFC 3339 UTC timestamp`,
        path,
      );
  }
  manifest.signatures.forEach((sig, i) => {
    if (!isCalendarValidRfc3339(sig.signedAt))
      throw new ManifestError(
        'schema',
        `/signatures/${i}/signedAt: not a calendar-valid RFC 3339 UTC timestamp`,
        `/signatures/${i}/signedAt`,
      );
  });
}

/** True when `host` (as URL.host, including port) is a loopback host allowed for http. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/:\d{1,5}$/, '');
  return LOOPBACK.has(bare);
}

/** True when `url` (already resolved) may be fetched: https anywhere, http only to loopback. */
export function isAllowedAssetUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.host);
  return false;
}

/**
 * JSON.parse with the repeated-member rule: an object with a repeated member name, at any depth, is
 * ManifestError('invalid_json') (JSON.parse alone keeps the last member without a word).
 */
export function parseJsonText(text: string): unknown {
  if (hasRepeatedMember(text))
    throw new ManifestError('invalid_json', 'manifest has a repeated member name');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ManifestError('invalid_json', `manifest is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Parses JSON text or an already-parsed value into a Manifest, applying the parse-level rules,
 * the schema, and the entry ordering and uniqueness rules. Throws ManifestError with a reason.
 */
export function parseManifest(input: string | unknown): Manifest {
  const value: unknown = typeof input === 'string' ? parseJsonText(input) : input;
  checkParsed(value, '');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('schema', 'manifest must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (obj['spec'] !== MANIFEST_SPEC) {
    throw new ManifestError(
      'bad_spec',
      `unknown manifest spec ${JSON.stringify(obj['spec'])}; expected ${MANIFEST_SPEC}`,
      '/spec',
    );
  }
  const result = validateSchema(SCHEMAS.manifest, value);
  if (!result.ok) {
    const urlError = result.errors.find((e) => /^\/entries\/\d+\/url$/.test(e.path));
    if (urlError)
      throw new ManifestError('bad_url', `entry url rejected: ${urlError.message}`, urlError.path);
    const first = result.errors[0]!;
    throw new ManifestError('schema', `${first.path || '/'}: ${first.message}`, first.path);
  }
  const manifest = value as Manifest;
  checkTimestamps(manifest);
  // reason precedence: unsorted_entries (any adjacent pair out of order) before duplicate_entries
  for (let i = 1; i < manifest.entries.length; i++) {
    const prev = manifest.entries[i - 1]!.id;
    const cur = manifest.entries[i]!.id;
    if (cur < prev)
      throw new ManifestError(
        'unsorted_entries',
        `entries not sorted by id: ${JSON.stringify(cur)} after ${JSON.stringify(prev)}`,
        `/entries/${i}/id`,
      );
  }
  for (let i = 1; i < manifest.entries.length; i++) {
    const cur = manifest.entries[i]!.id;
    if (cur === manifest.entries[i - 1]!.id)
      throw new ManifestError(
        'duplicate_entries',
        `duplicate entry id ${JSON.stringify(cur)}`,
        `/entries/${i}/id`,
      );
  }
  return manifest;
}

export interface ManifestState {
  version: string;
  createdAt: string;
}

/**
 * True when a stored downgrade state is exactly the shape the rule needs: a valid SemVer 2.0
 * `version` and a calendar-valid RFC 3339 `createdAt`. Storage is same-origin writable, so anything
 * else (a corrupt createdAt used to make the tie-breaker compare NaN and fail open, a corrupt
 * version used to surface as a misattributed `schema` rejection) is treated like an unreadable
 * store (S1-031).
 */
export function isValidManifestState(v: unknown): v is ManifestState {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['version'] !== 'string') return false;
  try {
    parseSemver(o['version']);
  } catch {
    return false;
  }
  return isCalendarValidRfc3339(o['createdAt']);
}

/** Persistence for the downgrade rule, keyed by manifest id. */
export interface ManifestStateStore {
  get(id: string): Promise<ManifestState | undefined>;
  set(id: string, state: ManifestState): Promise<void>;
}

export class InMemoryManifestState implements ManifestStateStore {
  private readonly map = new Map<string, ManifestState>();
  async get(id: string): Promise<ManifestState | undefined> {
    const s = this.map.get(id);
    return s ? { ...s } : undefined;
  }
  async set(id: string, state: ManifestState): Promise<void> {
    this.map.set(id, { ...state });
  }
}

/** The manifest id grammar (spec/manifest.ts Manifest.id): also the grammar of `expectId`. */
const MANIFEST_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;

export interface VerifyOptions {
  /** Epoch milliseconds used for the expiry check; default Date.now(). */
  now?: number;
  /**
   * 0.1.2: the manifest id the caller expects. Must match `^[a-z0-9][a-z0-9.-]{2,127}$`, otherwise
   * verifyManifest throws TypeError('invalid expectId') before parsing. After at least one valid signature
   * and before the downgrade state is read, a manifest with another id is refused: 'unexpected_id'.
   */
  expectId?: string | undefined;
  allowDowngrade?: boolean;
  /**
   * Required when the trust set contains any of the five RFC 8032 test keys (by keyId or by raw bytes).
   * Only the boolean true counts; the default is false.
   */
  allowTestKeys?: boolean;
  state?: ManifestStateStore;
  events?: EventSink;
}

export interface SignatureCheck {
  keyId: string;
  valid: boolean;
  reason?: SignatureInvalidReason;
}

export type VerifyResult =
  | { ok: true; manifest: Manifest; signatures: SignatureCheck[] }
  | { ok: false; reason: ManifestRejectReason; signatures: SignatureCheck[] };

export type TrustSet = ReadonlyMap<string, Uint8Array>;

/**
 * Decodes canonical standard padded base64 (RFC 4648 section 3.5), or answers undefined. atob ignores
 * the pad bits of the last character, so one byte string would have several accepted spellings
 * (BUG-T2-S4-14): the input is refused unless re-encoding the decoded bytes gives exactly the input.
 * The schema patterns of `sig` and `publicKey` already require the canonical last character; this is
 * defence in depth for a signature object that did not pass the schema stage.
 */
export function decodeBase64(s: string): Uint8Array | undefined {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    return undefined;
  try {
    const bin = atob(s);
    if (btoa(bin) !== s) return undefined;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function ed25519Verify(
  pub: Uint8Array,
  sig: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    pub as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sig as BufferSource,
    message as BufferSource,
  );
}

/** Event attrs must be primitives; an unparsed manifest may carry anything, so coerce. */
function attrString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * Verifies a manifest against a trust set (keyId -> raw 32-byte Ed25519 public key).
 *
 * `input` is the manifest text (the parse stage then includes the repeated-member scan) or an
 * already-parsed object (a repeated member cannot be seen there). It is re-checked structurally first
 * (parse rules, schema, timestamps, entry order), so an unparsed or hostile object is a rejection with
 * the parse reason (schema, float, ...), never an exception. Malformed signature members are `schema`
 * (the published Signature schema applies to every signatures[] item). The only throw is
 * ManifestError('test_key_refused'): a trust set holding any of the five RFC 8032 test keys, by keyId or
 * by raw bytes, is refused BEFORE anything is parsed unless opts.allowTestKeys === true (strict boolean;
 * the default is false), and again for the key a signature actually uses. 0.1.3 adds the second throw,
 * ManifestError('weak_key_refused'), raised the same way and with no option to skip it.
 */
export async function verifyManifest(
  input: Manifest | unknown,
  trust: TrustSet,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  // 0.1.2: a caller error, before anything else is looked at (no reason, no event, no state access)
  if (
    opts.expectId !== undefined &&
    !(typeof opts.expectId === 'string' && MANIFEST_ID.test(opts.expectId))
  )
    throw new TypeError('invalid expectId');
  if (opts.allowTestKeys !== true) assertTestKeysAllowed(trust, opts.allowTestKeys);
  // 0.1.3: step 1b, after 1a, before the parse, with no opt-out
  assertNoWeakKeys(trust);
  const now = opts.now ?? Date.now();
  let textError: ManifestError | undefined;
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = parseJsonText(input);
    } catch (e) {
      textError = e instanceof ManifestError ? e : new ManifestError('invalid_json', 'not JSON');
      value = {};
    }
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const fail = (
    reason: ManifestRejectReason,
    signatures: SignatureCheck[],
    eventReason: string = reason,
  ): VerifyResult => {
    opts.events?.emit(
      newEvent({
        source: 'runtime',
        kind: 'error',
        name: 'manifest.verify.failed',
        level: 'warn',
        attrs: {
          manifestId: attrString(typeof raw === 'object' ? raw['id'] : undefined),
          version: attrString(typeof raw === 'object' ? raw['version'] : undefined),
          reason: eventReason,
        },
      }),
    );
    return { ok: false, reason, signatures };
  };

  // Structural check first (S1-012): verifyManifest must never throw for malformed input. The whole
  // document is parsed with the full rules, signatures[] included (a digit-leading key, a float or a
  // lone surrogate inside a signature is the parse reason, TD-26), then validated against the manifest
  // schema, which applies the published Signature schema to every signatures[] item (extra members,
  // required members, the alg, keyId, publicKey, sig and signedAt patterns, calendar-valid signedAt:
  // reason schema). A missing or non-array signatures member is judged by that schema, after the parse
  // stage (MANIFEST_REJECT_PRECEDENCE). An alg token that is not ed25519 stays schema-valid and is
  // ignored below (unknown_alg).
  if (textError) return fail(textError.reason, []);
  // JSON text whose value is itself a string ("\"{...}\"") is not a manifest. parseManifest takes text OR
  // an object, so a string must never reach it a second time: that would parse the inner text without
  // the repeated-member scan of the outer one.
  if (typeof value === 'string') return fail('schema', []);
  let manifest: Manifest;
  try {
    manifest = parseManifest(value);
  } catch (e) {
    if (e instanceof ManifestError) return fail(e.reason, []);
    return fail('schema', []);
  }

  if (manifest.expiresAt !== undefined) {
    const exp = Date.parse(manifest.expiresAt);
    if (!(exp > now)) return fail('expired', []);
  }

  let message: Uint8Array;
  try {
    message = signedBytes(manifest);
  } catch (e) {
    if (e instanceof CanonicalError) {
      const map: Record<string, ManifestRejectReason> = {
        float: 'float',
        bigint: 'bigint',
        digit_key: 'digit_key',
        invalid_key: 'invalid_key',
        lone_surrogate: 'lone_surrogate',
        invalid_type: 'schema',
      };
      return fail(map[e.reason] ?? 'schema', []);
    }
    return fail('schema', []);
  }

  const checks: SignatureCheck[] = [];
  const sigs = Array.isArray(manifest.signatures) ? manifest.signatures : [];
  for (const sig of sigs) {
    const keyId = typeof sig?.keyId === 'string' ? sig.keyId : '';
    const invalid = (reason: SignatureInvalidReason) =>
      checks.push({ keyId, valid: false, reason });
    if (!sig || typeof sig !== 'object') {
      invalid('malformed_sig');
      continue;
    }
    if (sig.alg !== 'ed25519') {
      invalid('unknown_alg');
      continue;
    }
    if (!KEY_ID.test(keyId)) {
      invalid('malformed_key_id');
      continue;
    }
    const trustedRaw = trust.get(keyId);
    if (!trustedRaw) {
      invalid('untrusted_key');
      continue;
    }
    const trusted = normaliseKeyBytes(trustedRaw) as Uint8Array; // S1-121: judged by bytes, any realm or view
    // S1-089: the same refusal as assertTestKeysAllowed, for the key actually used, so a trust object
    // that hides keys from iteration (or reports them under another keyId) cannot smuggle a test key in.
    if (opts.allowTestKeys !== true && isTestKey(keyId, trusted)) refuseTestKey();
    // 0.1.3: the same weak-key refusal for the key actually used, before key_mismatch is evaluated
    if (isWeakTrustedKey(trusted)) refuseWeakKey();
    if (trusted.length !== 32 || toHex(sha256(trusted)) !== keyId) {
      invalid('key_mismatch');
      continue;
    }
    if (sig.publicKey !== undefined) {
      const embedded = decodeBase64(sig.publicKey);
      if (!embedded || !bytesEqual(embedded, trusted)) {
        invalid('key_mismatch');
        continue;
      }
    }
    const sigBytes = decodeBase64(sig.sig);
    if (!sigBytes || sigBytes.length !== 64) {
      invalid('malformed_sig');
      continue;
    }
    // S must be < L (RFC 8032 5.1.7): checked here, before WebCrypto, so every engine agrees
    if (isNonCanonicalS(sigBytes)) {
      invalid('bad_signature');
      continue;
    }
    let ok = false;
    try {
      ok = await ed25519Verify(trusted, sigBytes, message);
    } catch {
      ok = false;
    }
    if (ok) checks.push({ keyId, valid: true });
    else invalid('bad_signature');
  }

  if (!checks.some((c) => c.valid)) return fail('no_valid_signature', checks);

  // 0.1.2: a validly signed manifest of another product. Judged before the state is read or written.
  if (opts.expectId !== undefined && manifest.id !== opts.expectId)
    return fail('unexpected_id', checks);

  if (opts.state) {
    // Fail closed (S1-013): without the stored state the downgrade rule cannot be applied, so the
    // manifest is refused with reason 'state' unless the caller explicitly allows downgrades.
    let prev: ManifestState | undefined;
    let stateOk = true;
    try {
      const stored: unknown = await opts.state.get(manifest.id);
      // undefined means "nothing stored yet"; anything else must be a valid state (S1-031).
      if (stored === undefined) prev = undefined;
      else if (isValidManifestState(stored)) prev = stored;
      else stateOk = false;
    } catch {
      stateOk = false;
    }
    if (!stateOk && opts.allowDowngrade !== true) return fail('state', checks, 'state_unavailable');
    if (prev) {
      let cmp: number;
      try {
        cmp = compareSemver(manifest.version, prev.version);
      } catch {
        return fail('schema', checks);
      }
      const older =
        cmp < 0 || (cmp === 0 && Date.parse(manifest.createdAt) < Date.parse(prev.createdAt));
      if (older && opts.allowDowngrade !== true) return fail('downgrade', checks);
    }
    try {
      await opts.state.set(manifest.id, {
        version: manifest.version,
        createdAt: manifest.createdAt,
      });
    } catch {
      if (opts.allowDowngrade !== true) return fail('state', checks, 'state_unavailable');
    }
  }

  opts.events?.emit(
    newEvent({
      source: 'runtime',
      kind: 'log',
      name: 'manifest.verify.ok',
      level: 'info',
      attrs: {
        manifestId: manifest.id,
        version: manifest.version,
        validSignatures: checks.filter((c) => c.valid).length,
      },
    }),
  );
  return { ok: true, manifest, signatures: checks };
}
