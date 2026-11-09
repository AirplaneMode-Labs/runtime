/**
 * Manifest contract 0.1.0 (airplanemode.manifest/0.1).
 *
 * Normative JSON Schema: manifest.schema.json ($id urn:airplanemode:spec:manifest:0.1.0).
 * Canonicalisation, signing, verification order, trust roots and the downgrade rule are
 * specified in spec/README.md. This file is the TypeScript mirror of the schema.
 */

import type { BackendTier } from './capability-profile';

/** Wire-format discriminator. Consumers reject any other value. */
export const MANIFEST_SPEC = 'airplanemode.manifest/0.1' as const;
export type ManifestSpec = typeof MANIFEST_SPEC;

/** `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` (SemVer 2.0 without build metadata). */
export type SemVerString = string;

/** `YYYY-MM-DDTHH:MM:SSZ` (RFC 3339, UTC, whole seconds). */
export type Rfc3339Utc = string;

/** A signed list of model or data files. */
export interface Manifest {
  spec: ManifestSpec;
  /** `^[a-z0-9][a-z0-9.-]{2,127}$`; stable across versions; keys the downgrade state. */
  id: string;
  /** SemVer 2.0 version of the manifest. */
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
   * fragment. Every other scheme (data:, blob:, file:, javascript:, ...) is schema-invalid.
   */
  url: string;
  /** Lowercase hex SHA-256 of the complete file. */
  sha256: string;
  /** Exact size in bytes, 0..2^53-1. */
  size: number;
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
   * Standard padded base64 of the raw 32-byte public key. Informational only, never a source of
   * trust: a verifier compares it with the trusted key bytes for keyId and treats a mismatch as an
   * invalid signature (reason key_mismatch).
   */
  publicKey?: string;
  /** Standard padded base64 of the 64-byte signature. */
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
