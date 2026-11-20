/**
 * SHA256SUMS (manifest 0.1.4, "Release manifests"): ASCII, one line per manifest entry, `<64 lowercase hex>`, two
 * spaces, the basename, a line feed; lines sorted by basename in byte order; LF only; a final line feed. It covers
 * the artefacts only, never the manifest, and is authenticated only through the signed manifest: a verifier
 * regenerates it from the manifest entries and compares the bytes.
 */

import type { ManifestEntry } from '../../spec/manifest';

/** Byte order of two ASCII names (an entry id is `[a-z0-9._-]`, so UTF-16 order is byte order). */
export const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The exact bytes of SHA256SUMS for these entries (sorted here, so the caller's order does not matter). */
export function sumsText(entries: readonly Pick<ManifestEntry, 'id' | 'sha256'>[]): string {
  return [...entries]
    .sort((a, b) => byName(a.id, b.id))
    .map((e) => `${e.sha256}  ${e.id}\n`)
    .join('');
}
