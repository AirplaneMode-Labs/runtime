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
// Sprint 5 (spec release 0.5.0, manifest 0.1.2) adds two directories, written and checked here:
//   expect-id/   expect-id.json: eight rows for the expectId verifier option (file names relative to
//                vectors/), over the tamper vectors
//   state-ids/   three validly signed manifests with the ids 'constructor' and 'prototype' and
//                state-ids.json (four rows): the downgrade state must key them without a collision
//
//   node test/tools/make-vectors.mjs [--check]

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RFC8032_SEED_HEX, canonicalize, PREFIX, signManifest } from './lib.mjs';
import { format, resolveConfig } from 'prettier';

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
// A manifest signed with key 1 over its own body (whatever that body holds), optionally with the
// signature object edited afterwards; the signature is therefore correct for the body.
const signedText = (manifest, editSig = (sig) => sig) =>
  negRaw({
    ...manifest,
    signatures: [editSig(signManifest(manifest, RFC8032_SEED_HEX, SIGNED_AT))],
  });
// stage 'parse': rejected by parseManifest / cp-manifest validation with the named reason.
// stage 'verify': schema-valid; rejected by verifyManifest / cp-sign verify under the RFC 8032 trust
// set (allowTestKeys) with the named reason.
// The base64 alphabet, and a copy of `b64` whose last character (before the padding) has its lowest bit set:
// the same bytes under a lenient decoder, but with non-zero pad bits (never canonical).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const dirtyPadBits = (b64) => {
  const at = b64.replace(/=+$/, '').length - 1;
  return b64.slice(0, at) + B64[B64.indexOf(b64[at]) | 1] + b64.slice(at + 1);
};
// tamper-11 (key rotation) with one member of its FIRST signature (the untrusted key's) edited.
const rotation = (edit) => {
  const m = JSON.parse(readFileSync(resolve(vectors, 'tamper/tamper-11-rotation-ok.json'), 'utf8'));
  edit(m.signatures[0]);
  return negRaw(m);
};
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
  // Schema-invalid at parse stage: the unsigned example plus one signature whose bytes are a
  // correct Ed25519 signature under the RFC 8032 seed but whose alg is the upper-case spelling
  // 'ED25519', which is not a token (^[a-z0-9][a-z0-9-]{0,31}$). Both implementations reject the
  // manifest with reason schema before any signature is looked at (S1-011 follow-up, T3 note).
  'neg-bad-alg-token': {
    reason: 'schema',
    text: (() => {
      const sig = signManifest(unsigned, RFC8032_SEED_HEX, SIGNED_AT);
      return negRaw({ ...unsigned, signatures: [{ ...sig, alg: 'ED25519' }] });
    })(),
  },
  // Spec release 0.4.0 (manifest 0.1.1). A missing "spec" member is bad_spec, never schema.
  'neg-missing-spec': {
    reason: 'bad_spec',
    text: negRaw((({ spec: _spec, ...rest }) => rest)(base({}))),
  },
  // Reason precedence (MANIFEST.md): two faults, the earlier stage names the reason. Shared vectors
  // never combine two parse-stage faults, so each pair is one schema-stage fault and one ordering fault.
  'neg-multi-badspec-unsorted': {
    reason: 'bad_spec',
    text: negRaw(base({ spec: 'airplanemode.manifest/0.9', entries: [entry('b'), entry('a')] })),
  },
  'neg-multi-badurl-unsorted': {
    reason: 'bad_url',
    text: negRaw(
      base({
        entries: [entry('b', { url: 'data:application/octet-stream;base64,AA==' }), entry('a')],
      }),
    ),
  },
  // Vector 05 with a valid signature (key 1), plus an extra EARLIER "sha256" member in entries[1].
  // JSON.parse keeps the last member, so the parsed value is exactly vector 05 and its signature
  // verifies; only a duplicate-member scan rejects it (invalid_json, MANIFEST.md Duplicate members).
  'neg-duplicate-member': {
    reason: 'invalid_json',
    text: (() => {
      const m = positive['05-four-entries'];
      const sig = signManifest(m, RFC8032_SEED_HEX, SIGNED_AT);
      const raw = negRaw({ ...m, signatures: [sig] });
      const at = raw.indexOf('"sha256"', raw.indexOf('"id": "m.x"'));
      if (at < 0) throw new Error('neg-duplicate-member: anchor not found');
      return `${raw.slice(0, at)}"sha256": "${'f'.repeat(64)}",\n      ${raw.slice(at)}`;
    })(),
  },
  // Manifest 0.1.1 as amended by team decision TD-26 (before the first push). Each of the first five is a
  // VALIDLY SIGNED manifest (key 1), so the only fault is the one named: the schema stage refuses it
  // before any signature is looked at. The sixth has no signatures member at all.
  //
  // Version grammar is strict SemVer 2.0: a leading zero in a numeric part is schema.
  'neg-version-leading-zero': {
    reason: 'schema',
    text: signedText(base({ version: '01.0.0' })),
  },
  // ... and so is an empty prerelease identifier ('a..b').
  'neg-version-empty-prerelease-id': {
    reason: 'schema',
    text: signedText(base({ version: '1.0.0-a..b' })),
  },
  // An explicit null on an optional member is not "absent": expiresAt is a string or it is not there.
  'neg-null-optional': {
    reason: 'schema',
    text: signedText(base({ expiresAt: null })),
  },
  // The published Signature schema applies to every signatures[] item: an extra member is schema.
  'neg-sig-unknown-member': {
    reason: 'schema',
    text: signedText(base({}), (sig) => ({ ...sig, x: 1 })),
  },
  // ... and so is a signedAt that is not an RFC 3339 UTC timestamp.
  'neg-sig-bad-signedat': {
    reason: 'schema',
    text: signedText(base({}), (sig) => ({ ...sig, signedAt: 'garbage' })),
  },
  // Reason precedence: the parse stage comes before the schema stage, so a document that has BOTH a
  // missing signatures member (schema) and a digit-leading top-level key (parse stage) is digit_key.
  'neg-precedence-digitkey-nosigs': {
    reason: 'digit_key',
    text: negRaw({ ...(({ signatures: _s, ...rest }) => rest)(base({})), '1x': 1 }),
  },

  // Manifest 0.1.1 as amended by fix round 2 (team decision TD-29, 14 Nov 2026), before the first push. Nine
  // vectors, each with exactly ONE fault and each VALIDLY SIGNED apart from that fault (key 1), so the only
  // thing that can refuse it is the rule it names. The five that build on tamper-11 (key rotation: a valid
  // signature of the untrusted key 2, then a valid one of key 1) change one member of signatures[0], the
  // untrusted one, and leave signatures[1] valid: a verifier that merely skips a malformed signature would
  // accept them. They are read from the committed tamper-11 file, which never changes.
  //
  // BUG-T2-S4-11: a member that no schema declares is `schema`, whatever its name. "__proto__" is the worst:
  // JSON.parse makes it an own member, canonicalisation of the old runtime dropped it, so unsigned data
  // rode inside a manifest that verified. The signature below covers the body WITHOUT the member.
  'neg-proto-member-entry': {
    reason: 'schema',
    text: (() => {
      const m = positive['05-four-entries'];
      const raw = negRaw({ ...m, signatures: [signManifest(m, RFC8032_SEED_HEX, SIGNED_AT)] });
      const anchor = '"entries": [\n    {\n';
      const at = raw.indexOf(anchor);
      if (at < 0) throw new Error('neg-proto-member-entry: anchor not found');
      const head = at + anchor.length;
      return `${raw.slice(0, head)}      "__proto__": {\n        "pin": true\n      },\n${raw.slice(head)}`;
    })(),
  },
  // ... and so is "constructor" (an inherited name) in a signature object, the unsigned region.
  'neg-sig-proto-member': {
    reason: 'schema',
    text: signedText(base({}), (sig) => ({ ...sig, constructor: 'x' })),
  },
  // BUG-T2-S4-13 (control-plane's verifier skipped a malformed signature and went on to the valid one): the
  // Signature schema is applied to EVERY signatures[] item, so one malformed item refuses the whole manifest
  // with `schema`, even when another signature is valid and trusted.
  'neg-sig-malformed-keyid-rotation': {
    reason: 'schema',
    text: rotation((s) => {
      s.keyId = s.keyId.toUpperCase();
    }),
  },
  'neg-sig-malformed-sig-rotation': {
    reason: 'schema',
    text: rotation((s) => {
      s.sig = Buffer.from(s.sig, 'base64').subarray(0, 63).toString('base64');
    }),
  },
  'neg-sig-malformed-pubkey-rotation': {
    reason: 'schema',
    text: rotation((s) => {
      s.publicKey = 'AAAA';
    }),
  },
  // BUG-T2-S4-14: one accepted encoding per signature and key. The base64 below decodes (with any lenient
  // decoder, atob included) to the CORRECT signature or key; only the pad bits of the last character are not
  // zero, which RFC 4648 section 3.5 forbids and the schema patterns refuse.
  'neg-sig-noncanonical-base64': {
    reason: 'schema',
    text: signedText(base({}), (sig) => ({ ...sig, sig: dirtyPadBits(sig.sig) })),
  },
  'neg-pubkey-noncanonical-base64': {
    reason: 'schema',
    text: signedText(base({}), (sig) => ({ ...sig, publicKey: dirtyPadBits(sig.publicKey) })),
  },
  // BUG-T2-S4-15: the forbidden url characters are one explicit set (MANIFEST.md Shape). Signed with the url
  // as written, so the schema stage (bad_url) is the only thing that refuses it. The U+00A0 is written as a
  // \u escape in the file so that it survives an editor.
  'neg-url-control-char': {
    reason: 'bad_url',
    text: signedText(base({ entries: [entry('a', { url: 'assets/a\u0001b' })] })),
  },
  'neg-url-unicode-space': {
    reason: 'bad_url',
    text: signedText(base({ entries: [entry('a', { url: 'assets/a\u00a0b' })] })).replace(
      '\u00a0',
      '\\u00a0',
    ),
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

// ---- expect-id/ and state-ids/ (manifest 0.1.2) ------------------------------------------------------------

// The same base the tamper vectors start from: the four entries of vector 05, signed with key 1.
const NOW = '2026-11-14T00:00:00Z';
const STATE_SIGNED_AT = '2026-11-01T00:00:00Z';
const v05 = JSON.parse(readFileSync(resolve(vectors, '05-four-entries.json'), 'utf8'));
const unsignedBase = {
  spec: 'airplanemode.manifest/0.1',
  id: 'tamper-base',
  version: '1.1.0',
  publisher: 'Airplane Mode Labs (vectors)',
  createdAt: '2026-11-01T00:00:00Z',
  expiresAt: '2027-11-01T00:00:00Z',
  entries: v05.entries,
  signatures: [],
};
const pretty = (v) => JSON.stringify(v, null, 2) + '\n';
const withState = { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' };
const eiRow = (file, expectId, expect, extra = {}) => ({
  file,
  trust: ['rfc8032-1'],
  allowTestKeys: true,
  now: NOW,
  state: extra.state ?? null,
  requiresState: extra.requiresState ?? false,
  expectId,
  expect,
});
const refusedAs = (reason) => ({ valid: false, stage: 'verify', reason });
const badExpectId = { valid: false, throws: 'TypeError', message: 'invalid expectId' };
const expectIdRows = [
  eiRow('tamper/tamper-base.json', 'tamper-base', { valid: true }),
  eiRow('tamper/tamper-base.json', 'other-product', refusedAs('unexpected_id')),
  eiRow('tamper/tamper-03-sig-bitflip.json', 'other-product', refusedAs('no_valid_signature')),
  eiRow('tamper/tamper-10-expired.json', 'other-product', refusedAs('expired')),
  eiRow('tamper/tamper-08-rollback.json', 'other-product', refusedAs('unexpected_id'), {
    state: withState,
    requiresState: true,
  }),
  eiRow('tamper/tamper-08-rollback.json', 'tamper-base', refusedAs('downgrade'), {
    state: withState,
    requiresState: true,
  }),
  eiRow('tamper/tamper-base.json', 'BAD ID', badExpectId),
  eiRow('tamper/tamper-base.json', '', badExpectId),
];

// ids that collide with an inherited member of a plain JS object
const stateManifest = (id, version) => {
  const m = { ...unsignedBase, id, version, createdAt: STATE_SIGNED_AT };
  return { ...m, signatures: [signManifest(m, RFC8032_SEED_HEX, STATE_SIGNED_AT)] };
};
const stRow = (file, state, expect) => ({
  file,
  trust: ['rfc8032-1'],
  allowTestKeys: true,
  now: NOW,
  state,
  requiresState: true,
  expect,
});
const stateIdRows = [
  stRow('constructor-1.1.0.json', null, { valid: true }),
  stRow('constructor-1.1.0.json', withState, { valid: true }),
  stRow('constructor-1.0.0.json', withState, refusedAs('downgrade')),
  stRow('prototype-1.1.0.json', null, { valid: true }),
];

const prettierOptions = {
  ...((await resolveConfig(resolve(vectors, 'x.json'))) ?? {}),
  parser: 'json',
};
const dirFiles = new Map([
  ['expect-id/expect-id.json', await format(pretty(expectIdRows), prettierOptions)],
  ['state-ids/constructor-1.1.0.json', pretty(stateManifest('constructor', '1.1.0'))],
  ['state-ids/constructor-1.0.0.json', pretty(stateManifest('constructor', '1.0.0'))],
  ['state-ids/prototype-1.1.0.json', pretty(stateManifest('prototype', '1.1.0'))],
  ['state-ids/state-ids.json', await format(pretty(stateIdRows), prettierOptions)],
]);
for (const [name, content] of dirFiles) files.set(name, content);

const check = process.argv.includes('--check');
let dirty = 0;
if (!check)
  for (const d of ['expect-id', 'state-ids']) mkdirSync(resolve(vectors, d), { recursive: true });
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
  // sub-directories (descriptor/, tamper/, tamper-assets/) have their own generators; expect-id/ and
  // state-ids/ are written here
  const extra = readdirSync(vectors, { withFileTypes: true })
    .filter((d) => d.isFile() && !files.has(d.name) && d.name !== 'README.md')
    .map((d) => d.name);
  for (const d of ['expect-id', 'state-ids'])
    if (existsSync(resolve(vectors, d)))
      for (const f of readdirSync(resolve(vectors, d)))
        if (!files.has(`${d}/${f}`)) extra.push(`${d}/${f}`);
  if (extra.length) console.error(`unexpected files: ${extra.join(', ')}`);
  if (dirty || extra.length) process.exit(1);
  console.log(`${files.size} vector files up to date`);
} else {
  console.log(`wrote ${files.size} files to ${vectors}`);
}
