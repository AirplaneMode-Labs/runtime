/**
 * Manifest contract 0.1.2 (airplanemode.manifest/0.1), status "published": this is the plan's
 * "manifest spec v0.1" (pushed 15 Nov 2026 as 0.1.1).
 *
 * 0.1.2 (spec release 0.5.0) is an additive patch of 0.1.1 and changes the verdict of no input unless the
 * caller opts in: `VerifyOptions.expectId` (the verifier throws TypeError 'invalid expectId' for an
 * invalid value, and rejects a validly signed manifest of another id with the new reason `unexpected_id`
 * before it reads the downgrade state); the normative sentence of S1-097 (resolve and re-check every
 * entry url) and the S1-102 sentence (key the downgrade state so that no id collides with an inherited
 * member) in Security considerations; and the normative rules for the manifests the demo builds write
 * (MANIFEST.md, Demo bundles). The wire format is unchanged: every document 0.1.1 accepted or refused
 * has the same verdict without expectId. The schema body is unchanged: only its $id moves.
 *
 * Normative prose: MANIFEST.md (scope, shape, canonicalisation, duplicate members, signing, trust
 * roots, verification order, reason precedence, downgrade, test keys, tamper vectors, security
 * considerations, conformance). Normative JSON Schema: manifest.schema.json ($id
 * urn:airplanemode:spec:manifest:0.1.2; the body is unchanged since 0.1.0). This file is the
 * TypeScript mirror of the schema plus the constants every implementation shares.
 *
 * 0.1.1 is an additive patch of 0.1.0 (spec release 0.4.0): it changes no input that 0.1.0 accepted
 * or refused except where 0.1.0 left the outcome open or implementation-defined. It adds the duplicate-member
 * rule (invalid_json), the explicit S < L rule, the reason precedence (MANIFEST_REJECT_PRECEDENCE)
 * and all five RFC 8032 test keys to the test-key rule (RFC8032_TEST_PUBLIC_KEYS_HEX,
 * RFC8032_TEST_KEY_IDS). "published" means frozen on the wire string: later changes are additive
 * patches that change no accepted or refused input, or a new wire string.
 *
 * Amended in place before the first push (team decision TD-26, 14 Nov 2026; nothing had left the
 * machine): both versions follow strict SemVer 2.0 (SEMVER_PATTERN); the Signature schema is applied
 * to every signatures[] item at the schema stage; a missing or non-array signatures member is judged
 * after the parse stage. The contract version, the release number and the wire string do not change.
 *
 * Amended once more in place before the first push (team decision TD-29, fix round 2, 14 Nov 2026; nothing
 * had left the machine): a member that no schema declares, under ANY name (__proto__, constructor, toString,
 * ...), is `schema` at every level (BUG-T2-S4-11); `sig` and `publicKey` MUST be canonical padded base64
 * (BUG-T2-S4-14, SIGNATURE_SIG_PATTERN, SIGNATURE_PUBLIC_KEY_PATTERN); the forbidden url characters are one
 * explicit set (BUG-T2-S4-15, ENTRY_URL_PATTERN). Fixing these after the push would have changed what a
 * "published" contract accepts and needed a new wire string. Contract version, release number and wire
 * string are unchanged.
 */

import type { BackendTier } from './capability-profile';

/** Wire-format discriminator. Consumers reject any other value. */
export const MANIFEST_SPEC = 'airplanemode.manifest/0.1' as const;
export type ManifestSpec = typeof MANIFEST_SPEC;

/**
 * A version that matches SEMVER_PATTERN: strict SemVer 2.0 without build metadata (no leading zeros in
 * the numeric parts or in a numeric prerelease identifier, no empty identifier).
 */
export type SemVerString = string;

/**
 * The grammar of Manifest.version and ManifestEntry.version, as a regular expression source (team
 * decision TD-26, manifest 0.1.1 amended before the first push): strict SemVer 2.0, no build metadata.
 * `\d` means an ASCII digit 0-9, whatever the regular-expression engine. The same string is the
 * `pattern` of both version members in manifest.schema.json, and the downgrade-state reader uses it too,
 * so a version that is accepted can always be stored and read back.
 */
export const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?$';

/**
 * Pattern (regular-expression source) of `Signature.sig`: canonical standard padded base64 of 64 bytes
 * (RFC 4648 section 3.5). The last character before `==` carries 2 data bits and 4 pad bits, so it is one
 * of A, Q, g, w. Anything else is `schema`: one signature has exactly one accepted encoding (TD-29,
 * BUG-T2-S4-14). The same string is the `pattern` of `sig` in manifest.schema.json.
 */
export const SIGNATURE_SIG_PATTERN = '^[A-Za-z0-9+/]{85}[AQgw]==$';

/**
 * Pattern of `Signature.publicKey`: canonical standard padded base64 of 32 bytes. The last character
 * before `=` carries 4 data bits and 2 pad bits, so it is one of A E I M Q U Y c g k o s w 0 4 8. The same
 * string is the `pattern` of `publicKey` in manifest.schema.json.
 */
export const SIGNATURE_PUBLIC_KEY_PATTERN = '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$';

/**
 * Pattern of `ManifestEntry.url` (TD-29, BUG-T2-S4-15). The forbidden characters are explicit, not `\s`:
 * `?`, `#`, U+0000 to U+0020, U+007F to U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F,
 * U+3000 and U+FEFF; every other code point is allowed. Both verifiers (runtime and cp-manifest)
 * implement exactly this set. The same string is the `pattern` of `url` in manifest.schema.json.
 */
export const ENTRY_URL_PATTERN =
  '^(https://[^?#\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+|http://(127\\.0\\.0\\.1|\\[::1\\]|localhost)(:[0-9]{1,5})?/[^?#\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*|(?![a-zA-Z][a-zA-Z0-9+.-]*:)[^?#\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)$';

/** `YYYY-MM-DDTHH:MM:SSZ` (RFC 3339, UTC, whole seconds). */
export type Rfc3339Utc = string;

/** A signed list of model or data files. */
export interface Manifest {
  spec: ManifestSpec;
  /** `^[a-z0-9][a-z0-9.-]{2,127}$`; stable across versions; keys the downgrade state. */
  id: string;
  /** Strict SemVer 2.0 version of the manifest (SEMVER_PATTERN). */
  version: SemVerString;
  /** 1..200 characters. Informational; trust comes from the signing key. */
  publisher: string;
  /** Authenticated creation time; tie-breaker of the downgrade rule. */
  createdAt: Rfc3339Utc;
  /**
   * Authenticated expiry. A verifier rejects the manifest after this instant.
   * A manifest without expiresAt never expires; publishers SHOULD set it (cp-sign does by default).
   */
  expiresAt?: Rfc3339Utc;
  /** At least one entry; ids unique; sorted by id in byte order. */
  entries: ManifestEntry[];
  /** Empty for an unsigned draft. A verifier requires >= 1 valid signature from a trusted key. */
  signatures: Signature[];
}

export type ManifestEntryKind = 'model' | 'tokenizer' | 'data' | 'wasm' | 'other';

/** One file described by a manifest. */
export interface ManifestEntry {
  /** `^[a-z0-9][a-z0-9._-]{0,127}$`; unique within the manifest. */
  id: string;
  kind: ManifestEntryKind;
  /**
   * Absolute `https://` URL, absolute `http://` URL to 127.0.0.1, [::1] or localhost (tests only),
   * or a relative reference without scheme resolved against the manifest URL. No query string or
   * fragment, and none of the forbidden characters of ENTRY_URL_PATTERN. Every other scheme (data:,
   * blob:, file:, javascript:, ...) is refused with bad_url.
   */
  url: string;
  /** Lowercase hex SHA-256 of the complete file. */
  sha256: string;
  /** Exact size in bytes, 0..2^53-1. */
  size: number;
  /** Strict SemVer 2.0 (SEMVER_PATTERN). */
  version: SemVerString;
  /** SPDX licence expression. */
  licence: string;
  /** Minimum capability profile; `{}` means any device. */
  minProfile: MinProfile;
  /** IANA media type, when known. */
  mediaType?: string;
  /** Download chunk size, 1 MiB..64 MiB; default 8 MiB (8388608). */
  chunkSize?: number;
  /** Pinned entries are never LRU-evicted. Default false. */
  pin?: boolean;
}

/** Default `chunkSize` when an entry does not set one. */
export const DEFAULT_CHUNK_SIZE = 8388608;

/**
 * Minimum requirements of an entry. Integers only. `{}` means any device.
 *
 * satisfies(profile, min) iff (min.gpu absent or 'none' or profile.gpu == 'webgpu')
 *   && profile.ramGb >= min.ramGb && profile.storageFreeGb >= min.storageFreeGb
 *   && profile.cores >= min.cores && rank(profile.backendTier) >= rank(min.backendTier).
 */
export interface MinProfile {
  gpu?: 'webgpu' | 'none';
  ramGb?: number;
  storageFreeGb?: number;
  cores?: number;
  backendTier?: BackendTier;
}

/**
 * The only signature algorithm a 0.1 verifier verifies. The wire field is any token matching
 * ^[a-z0-9][a-z0-9-]{0,31}$ (schema-valid, so manifests can carry future algorithms); verifiers
 * IGNORE signatures with an unknown alg and reject the manifest if none remaining verifies.
 * "none" is never valid.
 */
export type SignatureAlg = 'ed25519';

/**
 * A detached Ed25519 signature over `signedBytes` (see README SIGNING SCHEME).
 *
 * UNAUTHENTICATED FIELDS: signedAt, alg, keyId and publicKey are NOT covered by the signature,
 * because the signatures member is removed before canonicalisation; a verifier MUST NOT use
 * signedAt for any decision; createdAt and expiresAt in the body are the only authenticated
 * timestamps.
 */
export interface Signature {
  /** Verifiers IGNORE signatures with an unknown alg and reject the manifest if none remaining verifies. */
  alg: SignatureAlg | (string & {});
  /** Lowercase hex SHA-256 of the raw 32-byte Ed25519 public key. */
  keyId: string;
  /**
   * Canonical standard padded base64 of the raw 32-byte public key (SIGNATURE_PUBLIC_KEY_PATTERN).
   * Informational only, never a source of
   * trust: a verifier compares it with the trusted key bytes for keyId and treats a mismatch as an
   * invalid signature (reason key_mismatch).
   */
  publicKey?: string;
  /** Canonical standard padded base64 of the 64-byte signature (SIGNATURE_SIG_PATTERN). */
  sig: string;
  /**
   * RFC 3339 UTC time of signing. UNAUTHENTICATED FIELDS: signedAt, alg, keyId and publicKey are
   * NOT covered by the signature, because the signatures member is removed before canonicalisation;
   * a verifier MUST NOT use signedAt for any decision; createdAt and expiresAt in the body are the
   * only authenticated timestamps.
   */
  signedAt: Rfc3339Utc;
}

/** Domain-separation prefix prepended to the canonical body before signing. */
export const MANIFEST_SIGNING_PREFIX = 'airplanemode-manifest-v1\n';

/** Every object key in a manifest (and in any canonicalised document) must match this. */
export const CANONICAL_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Reasons a manifest can be rejected before or during verification. */
export type ManifestRejectReason =
  | 'float'
  | 'bigint'
  | 'digit_key'
  | 'invalid_key'
  | 'lone_surrogate'
  | 'invalid_json'
  | 'bad_spec'
  | 'bad_url'
  | 'schema'
  | 'unsorted_entries'
  | 'duplicate_entries'
  | 'expired'
  | 'no_valid_signature'
  /** 0.1.2: the caller passed expectId and the validly signed manifest has another id. */
  | 'unexpected_id'
  | 'downgrade'
  | 'state'
  | 'test_key_refused';

/** Why an individual signature was judged invalid. */
export type SignatureInvalidReason =
  | 'unknown_alg'
  | 'malformed_key_id'
  | 'untrusted_key'
  | 'key_mismatch'
  | 'malformed_sig'
  | 'bad_signature';

/**
 * The five RFC 8032 section 7.1 test public keys (raw 32 bytes, lowercase hex): TEST 1, TEST 2, TEST 3,
 * TEST 1024 and TEST SHA(abc). Published, non-secret test data: anyone can sign with them. A trust
 * set holding any of them is refused (reason test_key_refused) unless allowTestKeys === true.
 * Derived from the RFC seeds with Node crypto (test/spec-0.4.test.ts); the RFC text wins on any mismatch.
 */
export const RFC8032_TEST_PUBLIC_KEYS_HEX = Object.freeze([
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
  '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e',
  'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
] as const);

/** keyId (lowercase hex SHA-256 of the raw public key) of each key in RFC8032_TEST_PUBLIC_KEYS_HEX, same order. */
export const RFC8032_TEST_KEY_IDS = Object.freeze([
  '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
  '39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f',
  'dac073e0123bdea59dd9b3bda9cf6037f63aca82627d7abcd5c4ac29dd74003e',
  '91384c411e5af29648f17f922b402655b11ecaec1b33fc45796241963f95f202',
  '5f9b247e2a654719f198e4f241d6b0df9a1a937a13ef5ef899f64d9285fce224',
] as const);

/**
 * Reason precedence (normative, MANIFEST.md "Reason precedence"): when several faults hold, the
 * reason is the first stage below that fails. Each group is one stage; shared vectors never combine
 * two parse-stage faults, so the order inside the first group is not tested.
 * test_key_refused is not listed: it is raised before parsing and is the only reason that throws. The
 * TypeError 'invalid expectId' (0.1.2) is a caller error, not a reason.
 *
 *  1. parse stage: invalid_json (including a repeated member name at any depth), lone_surrogate, float,
 *     bigint, digit_key, invalid_key
 *  2. bad_spec (a missing, non-string or unknown spec)
 *  3. bad_url
 *  4. schema (including calendar-invalid timestamps)
 *  5. unsorted_entries
 *  6. duplicate_entries
 *  7. expired
 *  8. no_valid_signature
 *  9. unexpected_id (0.1.2; only when the caller passed expectId; the state store is neither read nor written)
 * 10. downgrade or state
 */
export const MANIFEST_REJECT_PRECEDENCE: readonly (readonly ManifestRejectReason[])[] =
  Object.freeze([
    Object.freeze([
      'invalid_json',
      'lone_surrogate',
      'float',
      'bigint',
      'digit_key',
      'invalid_key',
    ] as const),
    Object.freeze(['bad_spec'] as const),
    Object.freeze(['bad_url'] as const),
    Object.freeze(['schema'] as const),
    Object.freeze(['unsorted_entries'] as const),
    Object.freeze(['duplicate_entries'] as const),
    Object.freeze(['expired'] as const),
    Object.freeze(['no_valid_signature'] as const),
    Object.freeze(['unexpected_id'] as const),
    Object.freeze(['downgrade', 'state'] as const),
  ]);
