/**
 * Precise SemVer 2.0 comparison for the manifest downgrade rule.
 * Build metadata is not part of the manifest version grammar and is rejected.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(version: string): SemVer {
  const m = RE.exec(version);
  if (!m) throw new RangeError(`not a SemVer 2.0 version: ${JSON.stringify(version)}`);
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

function cmpNum(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns -1 if a < b, 0 if equal, 1 if a > b, per SemVer 2.0 section 11. */
export function compareSemver(a: string | SemVer, b: string | SemVer): -1 | 0 | 1 {
  const va = typeof a === 'string' ? parseSemver(a) : a;
  const vb = typeof b === 'string' ? parseSemver(b) : b;
  const core =
    cmpNum(va.major, vb.major) || cmpNum(va.minor, vb.minor) || cmpNum(va.patch, vb.patch);
  if (core !== 0) return core;
  // A version without prerelease is higher than one with.
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1;
  if (vb.prerelease.length === 0) return -1;
  const n = Math.min(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = va.prerelease[i]!;
    const y = vb.prerelease[i]!;
    if (typeof x === 'number' && typeof y === 'number') {
      const c = cmpNum(x, y);
      if (c !== 0) return c;
    } else if (typeof x === 'number') {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (typeof y === 'number') {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII lexical
    }
  }
  return cmpNum(va.prerelease.length, vb.prerelease.length);
}
