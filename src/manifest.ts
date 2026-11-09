/**
 * Manifest parsing and verification (Manifest 0.1.0). See spec/README.md VERIFICATION ORDER.
 *
 * parse (floats, > 2^53-1, digit-leading keys, lone surrogates) -> schema (incl. calendar-valid
 * timestamps) -> expiry -> signatures -> downgrade rule. verifyManifest re-runs the parse and
 * schema stage on whatever object it is given, so malformed input (or malformed signature
 * material) is a rejection with a reason, never an exception; the only throw is the test-key
 * refusal. An unreadable downgrade-state store fails closed (reason 'state').
 */

import type { EventSink } from '../spec/event';
import {
  MANIFEST_SPEC,
  type Manifest,
  type ManifestRejectReason,
  type SignatureInvalidReason,
} from '../spec/manifest';
import { CANONICAL_KEY_PATTERN } from '../spec/manifest';
import { CanonicalError, signedBytes } from './canonical';
import { newEvent } from './events';
import { SCHEMAS, validateSchema } from './schema';
import { compareSemver } from './semver';
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

/** keyId of the RFC 8032 section 7.1 test key; refused in a trust set unless allowTestKeys. */
export const RFC8032_TEST_KEY_ID =
  '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KEY_ID = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Walks a parsed JSON value and rejects floats, out-of-range integers, bad keys and lone surrogates. */
function checkParsed(value: unknown, path: string): void {
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
    value.forEach((v, i) => checkParsed(v, `${path}/${i}`));
    return;
  }
  if (typeof value === 'object') {
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
      checkParsed((value as Record<string, unknown>)[key], `${path}/${key}`);
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
 * Parses JSON text or an already-parsed value into a Manifest, applying the parse-level rules,
 * the schema, and the entry ordering and uniqueness rules. Throws ManifestError with a reason.
 */
export function parseManifest(input: string | unknown): Manifest {
  let value: unknown;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (e) {
      throw new ManifestError(
        'invalid_json',
        `manifest is not valid JSON: ${(e as Error).message}`,
      );
    }
  } else {
    value = input;
  }
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
  for (let i = 1; i < manifest.entries.length; i++) {
    const prev = manifest.entries[i - 1]!.id;
    const cur = manifest.entries[i]!.id;
    if (cur === prev)
      throw new ManifestError(
        'duplicate_entries',
        `duplicate entry id ${JSON.stringify(cur)}`,
        `/entries/${i}/id`,
      );
    if (cur < prev)
      throw new ManifestError(
        'unsorted_entries',
        `entries not sorted by id: ${JSON.stringify(cur)} after ${JSON.stringify(prev)}`,
        `/entries/${i}/id`,
      );
  }
  return manifest;
}

export interface ManifestState {
  version: string;
  createdAt: string;
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

export interface VerifyOptions {
  /** Epoch milliseconds used for the expiry check; default Date.now(). */
  now?: number;
  allowDowngrade?: boolean;
  /** Required when the trust set contains the RFC 8032 test key. */
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

function decodeBase64(s: string): Uint8Array | undefined {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    return undefined;
  try {
    const bin = atob(s);
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
 * The input is re-checked structurally first (parse rules, schema, timestamps, entry order), so an
 * unparsed or hostile object is a rejection with the parse reason (schema, float, ...), never an
 * exception. Malformed signature material is an invalid signature. The only throw is
 * ManifestError('test_key_refused') when the trust set contains the RFC 8032 test key and
 * allowTestKeys is not set.
 */
export async function verifyManifest(
  input: Manifest | unknown,
  trust: TrustSet,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (trust.has(RFC8032_TEST_KEY_ID) && opts.allowTestKeys !== true) {
    throw new ManifestError(
      'test_key_refused',
      'trust set contains the RFC 8032 test key; pass allowTestKeys: true in tests only',
    );
  }
  const now = opts.now ?? Date.now();
  const raw = (input ?? {}) as Record<string, unknown>;
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

  // Structural check first (S1-012): verifyManifest must never throw for malformed input. The
  // body is parsed with the full rules; the signatures array is only required to be an array, so
  // malformed signature material stays an invalid signature (malformed_sig, malformed_key_id,
  // unknown_alg) rather than a schema rejection, as the verification order requires.
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return fail('schema', []);
  if (!Array.isArray(raw['signatures'])) return fail('schema', []);
  let manifest: Manifest;
  try {
    manifest = parseManifest({ ...raw, signatures: [] });
  } catch (e) {
    if (e instanceof ManifestError) return fail(e.reason, []);
    return fail('schema', []);
  }
  manifest = { ...manifest, signatures: raw['signatures'] as Manifest['signatures'] };

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
    const trusted = trust.get(keyId);
    if (!trusted) {
      invalid('untrusted_key');
      continue;
    }
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

  if (opts.state) {
    // Fail closed (S1-013): without the stored state the downgrade rule cannot be applied, so the
    // manifest is refused with reason 'state' unless the caller explicitly allows downgrades.
    let prev: ManifestState | undefined;
    let stateOk = true;
    try {
      prev = await opts.state.get(manifest.id);
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
