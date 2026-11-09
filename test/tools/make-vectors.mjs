#!/usr/bin/env node
// Generates the shared canonicalisation vectors under spec/vectors/:
//   <n>-<name>.json           a manifest (signatures: [])
//   <n>-<name>.canonical.txt  expected signed bytes: prefix + canonical body (no trailing newline)
//   <n>-<name>.sig.txt        base64 Ed25519 signature under the RFC 8032 section 7.1 test seed
//   neg-<name>.json           inputs both implementations must reject (reasons and the stage,
//                             parse or verify, in negative.json)
//
// control-plane vendors these byte for byte (scripts/sync-fixtures.sh); the Rust cp-manifest and
// the TypeScript runtime must produce identical canonical bytes and identical signatures.
//
//   node test/tools/make-vectors.mjs [--check]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RFC8032_SEED_HEX, canonicalize, PREFIX, signManifest } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = resolve(here, '../../spec/vectors');
const unsigned = JSON.parse(
  readFileSync(resolve(here, '../../spec/examples/manifest.unsigned.example.json'), 'utf8'),
);
const SIGNED_AT = '2026-11-09T00:00:00Z';

const entry = (id, extra = {}) => ({
  id,
  kind: 'data',
  url: `assets/${id}`,
  sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  size: 0,
  version: '0.1.0',
  licence: 'Apache-2.0',
  minProfile: {},
  ...extra,
});

const base = (overrides) => ({
  spec: 'airplanemode.manifest/0.1',
  id: 'dev.airplanemode.vectors',
  version: '0.1.0',
  publisher: 'Airplane Mode Labs (vectors)',
  createdAt: '2026-11-09T00:00:00Z',
  entries: [entry('a')],
  signatures: [],
  ...overrides,
});

const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');

const positive = {
  '01-unsigned-example': unsigned,
  '02-escapes': base({
    publisher: `quote " backslash \\ slash / angle <>& controls ${controls}`,
    entries: [entry('a', { licence: `"\\/\u0000\u001f<>&` })],
  }),
  '03-devanagari': base({
    publisher: 'एयरप्लेन मोड लैब्स',
    entries: [entry('a', { licence: 'अपाचे-2.0' })],
  }),
  '04-minprofile-full': base({
    entries: [
      entry('a', {
        minProfile: {
          gpu: 'webgpu',
          ramGb: 8,
          storageFreeGb: 2,
          cores: 4,
          backendTier: 'webgpu-f32',
        },
      }),
    ],
  }),
  '05-four-entries': base({
    entries: [entry('m-x'), entry('m.x'), entry('m_x'), entry('mx')],
  }),
};

// Negative vectors are written as raw JSON text so that spellings JSON.parse would normalise
// (floats, big integers, surrogate escapes) survive in the file.
const negRaw = (manifest) => JSON.stringify(manifest, null, 2) + '\n';
// stage 'parse': rejected by parseManifest / cp-manifest validation with the named reason.
// stage 'verify': schema-valid; rejected by verifyManifest / cp-sign verify under the RFC 8032 trust
// set (allowTestKeys) with the named reason.
const negative = {
  'neg-digit-key': {
    reason: 'digit_key',
    text: negRaw(base({ entries: [entry('a', { minProfile: { b: 1, 10: 2, a: 3 } })] })),
  },
  'neg-float': {
    reason: 'float',
    text: negRaw(base({ entries: [entry('a', { size: 1 })] })).replace('"size": 1', '"size": 1.5'),
  },
  'neg-bigint': {
    reason: 'bigint',
    text: negRaw(base({ entries: [entry('a', { size: 1 })] })).replace(
      '"size": 1',
      '"size": 9007199254740992',
    ),
  },
  'neg-lone-surrogate': {
    reason: 'lone_surrogate',
    text: negRaw(base({ publisher: 'XSURROGATEX' })).replace('XSURROGATEX', '\\ud800'),
  },
  'neg-unsorted-entries': {
    reason: 'unsorted_entries',
    text: negRaw(base({ entries: [entry('b'), entry('a')] })),
  },
  'neg-dup-entries': {
    reason: 'duplicate_entries',
    text: negRaw(base({ entries: [entry('a'), entry('a')] })),
  },
  'neg-bad-url-http': {
    reason: 'bad_url',
    text: negRaw(base({ entries: [entry('a', { url: 'http://example.com/assets/a' })] })),
  },
  'neg-bad-url-data': {
    reason: 'bad_url',
    text: negRaw(
      base({ entries: [entry('a', { url: 'data:application/octet-stream;base64,AA==' })] }),
    ),
  },
  'neg-bad-url-blob': {
    reason: 'bad_url',
    text: negRaw(base({ entries: [entry('a', { url: 'blob:https://example.com/0000' })] })),
  },
  'neg-bad-spec': {
    reason: 'bad_spec',
    text: negRaw(base({ spec: 'airplanemode.manifest/0.2' })),
  },
  // Calendar-invalid RFC 3339 timestamp: matches the pattern, fails the date check on both sides.
  'neg-bad-date': {
    reason: 'schema',
    text: negRaw(base({ createdAt: '2026-99-99T00:00:00Z' })),
  },
  // Schema-valid: the only signature is a correct Ed25519 signature labelled with an unknown alg.
  // Verifiers must ignore it (never verify it as ed25519) and fail with no_valid_signature.
  'neg-unknown-alg-only': {
    reason: 'no_valid_signature',
    stage: 'verify',
    text: (() => {
      const m = base({});
      const sig = signManifest(m, RFC8032_SEED_HEX, SIGNED_AT);
      return negRaw({ ...m, signatures: [{ ...sig, alg: 'future-pq' }] });
    })(),
  },
};

const files = new Map();
for (const [name, manifest] of Object.entries(positive)) {
  const { signatures: _s, ...body } = manifest;
  const sig = signManifest(manifest, RFC8032_SEED_HEX, SIGNED_AT);
  files.set(`${name}.json`, JSON.stringify({ ...body, signatures: [] }, null, 2) + '\n');
  files.set(`${name}.canonical.txt`, PREFIX + canonicalize(body));
  files.set(`${name}.sig.txt`, sig.sig);
}
const index = [];
for (const [name, { reason, stage, text }] of Object.entries(negative)) {
  files.set(`${name}.json`, text);
  index.push({ file: `${name}.json`, reason, stage: stage ?? 'parse' });
}
files.set('negative.json', JSON.stringify(index, null, 2) + '\n');

const check = process.argv.includes('--check');
let dirty = 0;
for (const [name, content] of files) {
  const path = resolve(vectors, name);
  if (check) {
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) {
      console.error(`out of date: ${name}`);
      dirty++;
    }
  } else {
    writeFileSync(path, content);
  }
}
if (check) {
  const extra = readdirSync(vectors).filter((f) => !files.has(f) && f !== 'README.md');
  if (extra.length) console.error(`unexpected files: ${extra.join(', ')}`);
  if (dirty || extra.length) process.exit(1);
  console.log(`${files.size} vector files up to date`);
} else {
  console.log(`wrote ${files.size} files to ${vectors}`);
}
