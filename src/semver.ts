/**
 * Precise SemVer 2.0 comparison for the manifest downgrade rule.
 *
 * The grammar is SEMVER_PATTERN of spec/manifest.ts (team decision TD-26): strict SemVer 2.0, no build
 * metadata, no leading zeros, no empty identifier. It is the same grammar the manifest schema applies to
 * Manifest.version and ManifestEntry.version, so every version a verifier accepts can be stored in the
 * downgrade state and read back.
 *
 * Numeric identifiers are compared exactly: they are held as BigInt, never as Number, because a
 * patch or a numeric prerelease identifier above 2^53 would otherwise compare equal to its neighbour
 * and let a rollback through (BUG-T2-S4-05).
 */

import { SEMVER_PATTERN } from '../spec/manifest';

export interface SemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  /** Numeric identifiers as bigint, alphanumeric ones as strings. */
  prerelease: (string | bigint)[];
}

const RE = new RegExp(SEMVER_PATTERN);
const NUMERIC = /^[0-9]+$/;

export function parseSemver(version: string): SemVer {
  if (typeof version !== 'string' || !RE.test(version))
    throw new RangeError(`not a SemVer 2.0 version: ${JSON.stringify(version)}`);
  const dash = version.indexOf('-');
  const core = (dash < 0 ? version : version.slice(0, dash)).split('.');
  const prerelease =
    dash < 0
      ? []
      : version
          .slice(dash + 1)
          .split('.')
          .map((id) => (NUMERIC.test(id) ? BigInt(id) : id));
  return { major: BigInt(core[0]!), minor: BigInt(core[1]!), patch: BigInt(core[2]!), prerelease };
}

function cmp<T extends bigint | string>(a: T, b: T): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns -1 if a < b, 0 if equal, 1 if a > b, per SemVer 2.0 section 11. */
export function compareSemver(a: string | SemVer, b: string | SemVer): -1 | 0 | 1 {
  const va = typeof a === 'string' ? parseSemver(a) : a;
  const vb = typeof b === 'string' ? parseSemver(b) : b;
  const core = cmp(va.major, vb.major) || cmp(va.minor, vb.minor) || cmp(va.patch, vb.patch);
  if (core !== 0) return core;
  // A version without prerelease is higher than one with.
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1;
  if (vb.prerelease.length === 0) return -1;
  const n = Math.min(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = va.prerelease[i]!;
    const y = vb.prerelease[i]!;
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      const c = cmp(x, y);
      if (c !== 0) return c;
    } else if (typeof x === 'bigint') {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (typeof y === 'bigint') {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII lexical
    }
  }
  // all shared identifiers are equal: the longer prerelease list is the higher version
  return va.prerelease.length < vb.prerelease.length
    ? -1
    : va.prerelease.length > vb.prerelease.length
      ? 1
      : 0;
}
