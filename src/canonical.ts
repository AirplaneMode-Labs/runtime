/**
 * Canonicalisation for signing: RFC 8785 (JCS) restricted to the profile in spec/README.md.
 *
 * - members sorted by key in ASCII byte order, no whitespace;
 * - strings exactly as JSON.stringify (only `"`, `\` and U+0000..U+001F escaped);
 * - integers only, 0..2^53-1, floats and negative zero rejected;
 * - every object key matches ^[A-Za-z_][A-Za-z0-9_]{0,63}$ (digit-leading keys rejected because
 *   JavaScript enumerates array-index-like keys first regardless of sorting);
 * - string values must be well-formed Unicode (no lone surrogates).
 *
 * JSON.stringify over recursively key-sorted plain objects produces exactly this form, so no JCS
 * library is needed; serde_json with BTreeMap produces the same bytes on the Rust side.
 */

import { CANONICAL_KEY_PATTERN, MANIFEST_SIGNING_PREFIX } from '../spec/manifest';

export type CanonicalReason =
  'float' | 'bigint' | 'digit_key' | 'invalid_key' | 'lone_surrogate' | 'invalid_type';

export class CanonicalError extends Error {
  override readonly name = 'CanonicalError';
  readonly reason: CanonicalReason;
  readonly path: string;

  constructor(reason: CanonicalReason, path: string, message: string) {
    super(message);
    this.reason = reason;
    this.path = path;
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function normalise(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!value.isWellFormed())
      throw new CanonicalError(
        'lone_surrogate',
        path,
        `lone surrogate in string at ${path || '/'}`,
      );
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Object.is(value, -0))
      throw new CanonicalError('float', path, `non-integer number at ${path || '/'}`);
    if (value < 0 || value > MAX_SAFE)
      throw new CanonicalError('bigint', path, `integer outside 0..2^53-1 at ${path || '/'}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => normalise(v, `${path}/${i}`));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (!CANONICAL_KEY_PATTERN.test(key)) {
        const reason: CanonicalReason = /^[0-9]/.test(key) ? 'digit_key' : 'invalid_key';
        throw new CanonicalError(
          reason,
          path,
          `object key ${JSON.stringify(key)} not allowed at ${path || '/'}`,
        );
      }
      out[key] = normalise((value as Record<string, unknown>)[key], `${path}/${key}`);
    }
    return out;
  }
  throw new CanonicalError(
    'invalid_type',
    path,
    `unsupported value of type ${typeof value} at ${path || '/'}`,
  );
}

/** Canonical JSON text of `value` under the restricted profile. Throws CanonicalError. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalise(value, ''));
}

/**
 * The bytes a manifest signature covers: UTF-8(prefix) || canonical(manifest without `signatures`).
 * Accepts any object; the `signatures` member is dropped if present.
 */
export function signedBytes(manifest: unknown): Uint8Array {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CanonicalError('invalid_type', '', 'manifest must be an object');
  }
  const { signatures: _dropped, ...body } = manifest as Record<string, unknown>;
  return new TextEncoder().encode(MANIFEST_SIGNING_PREFIX + canonicalize(body));
}
