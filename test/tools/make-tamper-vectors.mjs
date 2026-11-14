#!/usr/bin/env node
// Generates the tamper vectors of manifest spec v0.1 (manifest 0.1.1, spec release 0.4.0):
//
//   spec/vectors/tamper/          tamper-01..15 plus tamper.json (the table every implementation runs)
//   spec/vectors/tamper-assets/   three signed manifests, three .bin files and expect.json (runtime-
//                                 specific asset integrity cases)
//
// Everything is deterministic: signatures are Ed25519 (RFC 8032) over the RFC 8032 section 7.1 test
// seeds (public, non-secret test data), so a rerun reproduces every byte. control-plane vendors the
// folders byte for byte. The base manifest is the four entries of vector 05, signed with key 1.
//
//   node test/tools/make-tamper-vectors.mjs [--check]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { RFC8032_TEST_KEYS, addLToS, keyIdOf, signManifest, verifySig } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(here, '../../spec');
const outDir = resolve(spec, 'vectors/tamper');
const assetsDir = resolve(spec, 'vectors/tamper-assets');

const NOW = '2026-11-14T00:00:00Z';
const SIGNED_AT = '2026-11-01T00:00:00Z';
const key = (n) => RFC8032_TEST_KEYS.find((k) => k.name === n);
const KEY1 = key('rfc8032-1');
const KEY2 = key('rfc8032-2');
const pubB64 = (k) => Buffer.from(k.publicHex, 'hex').toString('base64');

const v05 = JSON.parse(readFileSync(resolve(spec, 'vectors/05-four-entries.json'), 'utf8'));
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

const clone = (v) => structuredClone(v);
const sigBy = (manifest, k) => signManifest(manifest, k.seedHex, SIGNED_AT);
const signedBy = (manifest, ...ks) => ({
  ...manifest,
  signatures: ks.map((k) => sigBy(manifest, k)),
});
const pretty = (v) => JSON.stringify(v, null, 2) + '\n';
const flipBit = (b64) => {
  const bytes = Buffer.from(b64, 'base64');
  bytes[10] ^= 0x01;
  return bytes.toString('base64');
};

const base = signedBy(unsignedBase, KEY1);

const files = new Map();
const rows = [];
const add = (file, text, row) => {
  files.set(`tamper/${file}`, text);
  rows.push({
    file,
    trust: row.trust,
    allowTestKeys: row.allowTestKeys ?? true,
    now: NOW,
    state: row.state ?? null,
    requiresState: row.requiresState ?? false,
    expect: row.expect,
  });
};
const refused = (signatures) => ({
  valid: false,
  stage: 'verify',
  reason: 'no_valid_signature',
  signatures,
});
const STATE = { version: '1.1.0', createdAt: '2026-11-01T00:00:00Z' };

// 01 one hex character of entries[1].sha256 changed after signing
{
  const m = clone(base);
  const h = m.entries[1].sha256;
  m.entries[1].sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1);
  add('tamper-01-entry-sha-byte.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['bad_signature']),
  });
}
// 02 entries[0].size + 1 after signing
{
  const m = clone(base);
  m.entries[0].size += 1;
  add('tamper-02-entry-size.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['bad_signature']),
  });
}
// 03 one bit of sig flipped
{
  const m = clone(base);
  m.signatures[0].sig = flipBit(m.signatures[0].sig);
  add('tamper-03-sig-bitflip.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['bad_signature']),
  });
}
// 04 keyId and publicKey of key 2, sig made by key 1; both keys are trusted
{
  const m = clone(base);
  m.signatures[0].keyId = keyIdOf(Buffer.from(KEY2.publicHex, 'hex'));
  m.signatures[0].publicKey = pubB64(KEY2);
  add('tamper-04-swapped-key.json', pretty(m), {
    trust: ['rfc8032-1', 'rfc8032-2'],
    expect: refused(['bad_signature']),
  });
}
// 05 keyId of key 1, publicKey of key 2
{
  const m = clone(base);
  m.signatures[0].publicKey = pubB64(KEY2);
  add('tamper-05-publickey-mismatch.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['key_mismatch']),
  });
}
// 06 validly signed by key 2, which is not in the trust set
add('tamper-06-untrusted-key.json', pretty(signedBy(unsignedBase, KEY2)), {
  trust: ['rfc8032-1'],
  expect: refused(['untrusted_key']),
});
// 07 the signed file cut at floor(len / 2) (ASCII only, so characters equal bytes)
{
  const text = pretty(base);
  add('tamper-07-truncated.txt', text.slice(0, Math.floor(text.length / 2)), {
    trust: ['rfc8032-1'],
    expect: { valid: false, stage: 'parse', reason: 'invalid_json' },
  });
}
// 08 rollback: version 1.0.0, validly signed, against stored state {1.1.0, 2026-11-01}
add('tamper-08-rollback.json', pretty(signedBy({ ...unsignedBase, version: '1.0.0' }, KEY1)), {
  trust: ['rfc8032-1'],
  state: STATE,
  requiresState: true,
  expect: { valid: false, stage: 'verify', reason: 'downgrade', signatures: ['valid'] },
});
// 09 replay: the same version with an older createdAt, validly signed by key 1
{
  const m = signedBy({ ...unsignedBase, createdAt: '2026-10-01T00:00:00Z' }, KEY1);
  const { signatures, ...body } = m;
  if (!verifySig(body, signatures[0].sig, KEY1.publicHex))
    throw new Error('tamper-09 must verify under key 1');
  add('tamper-09-replay-older-createdAt.json', pretty(m), {
    trust: ['rfc8032-1'],
    state: STATE,
    requiresState: true,
    expect: { valid: false, stage: 'verify', reason: 'downgrade', signatures: ['valid'] },
  });
}
// 10 expired at the vector time (validly signed, so only the expiry is wrong)
add(
  'tamper-10-expired.json',
  pretty(signedBy({ ...unsignedBase, expiresAt: '2026-11-10T00:00:00Z' }, KEY1)),
  { trust: ['rfc8032-1'], expect: { valid: false, stage: 'verify', reason: 'expired' } },
);
// 11 key rotation: a valid signature by an untrusted new key, then one by the trusted old key
add('tamper-11-rotation-ok.json', pretty(signedBy(unsignedBase, KEY2, KEY1)), {
  trust: ['rfc8032-1'],
  expect: { valid: true, signatures: ['untrusted_key', 'valid'] },
});
// 12 signatures stripped
add('tamper-12-stripped.json', pretty({ ...unsignedBase, signatures: [] }), {
  trust: ['rfc8032-1'],
  expect: refused([]),
});
// 13 key 1's signature labelled "none"
{
  const m = clone(base);
  m.signatures[0].alg = 'none';
  add('tamper-13-alg-none.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['unknown_alg']),
  });
}
// 14 a trust set holding a test key and allowTestKeys false: refused before anything is parsed
add('tamper-14-test-key-refused.json', pretty(base), {
  trust: ['rfc8032-2'],
  allowTestKeys: false,
  expect: { valid: false, reason: 'test_key_refused' },
});
// 15 S replaced by S + L (little-endian), still 64 bytes
{
  const m = clone(base);
  m.signatures[0].sig = addLToS(Buffer.from(m.signatures[0].sig, 'base64')).toString('base64');
  add('tamper-15-noncanonical-s.json', pretty(m), {
    trust: ['rfc8032-1'],
    expect: refused(['bad_signature']),
  });
}
files.set('tamper/tamper.json', JSON.stringify(rows));

// ---- tamper-assets: runtime-specific, signed manifests over three byte files -----------------
const SIZE = 4096;
const assetOk = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) assetOk[i] = (i * 31 + 7) % 256;
const assetFlip = Buffer.from(assetOk);
assetFlip[2048] ^= 0x01;
const assetTruncated = Buffer.from(assetOk.subarray(0, SIZE - 1));
const okSha = createHash('sha256').update(assetOk).digest('hex');
const assetManifest = (url) =>
  signedBy(
    {
      spec: 'airplanemode.manifest/0.1',
      id: 'tamper-assets',
      version: '1.0.0',
      publisher: 'Airplane Mode Labs (vectors)',
      createdAt: '2026-11-01T00:00:00Z',
      entries: [
        {
          id: 'asset-ok',
          kind: 'data',
          url,
          sha256: okSha,
          size: SIZE,
          version: '1.0.0',
          licence: 'Apache-2.0',
          minProfile: {},
        },
      ],
      signatures: [],
    },
    KEY1,
  );
files.set('tamper-assets/asset-ok.bin', assetOk);
files.set('tamper-assets/asset-flip.bin', assetFlip);
files.set('tamper-assets/asset-truncated.bin', assetTruncated);
files.set('tamper-assets/manifest-ok.json', pretty(assetManifest('asset-ok.bin')));
files.set('tamper-assets/manifest-flip.json', pretty(assetManifest('asset-flip.bin')));
files.set('tamper-assets/manifest-truncated.json', pretty(assetManifest('asset-truncated.bin')));
const NORMATIVE_REFUSED = { refused: true, bytesToConsumer: 0, getBlob: 'rejects', blobUrl: false };
// informative: what @airplanemode/runtime returns for the case. Another implementation may return a
// different code and still conform; only the normative fields bind.
files.set(
  'tamper-assets/expect.json',
  JSON.stringify({
    'manifest-ok.json': {
      normative: { refused: false, bytesToConsumer: SIZE, getBlob: 'resolves', blobUrl: true },
      informative: { runtimeCode: null, runtimeReason: null },
    },
    'manifest-flip.json': {
      normative: NORMATIVE_REFUSED,
      informative: { runtimeCode: 'hash_mismatch', runtimeReason: null },
    },
    'manifest-truncated.json': {
      normative: NORMATIVE_REFUSED,
      informative: { runtimeCode: 'network', runtimeReason: 'content-length' },
    },
  }),
);

// JSON that carries arrays of strings is formatted with the repository's prettier configuration, so
// the committed bytes survive `npm run fmt:check`.
const prettierOptions = {
  ...((await resolveConfig(resolve(outDir, 'x.json'))) ?? {}),
  parser: 'json',
};
for (const name of ['tamper/tamper.json', 'tamper-assets/expect.json'])
  files.set(name, await format(files.get(name), prettierOptions));

const check = process.argv.includes('--check');
let bad = 0;
const root = resolve(spec, 'vectors');
if (!check) {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
}
for (const [name, body] of files) {
  const path = resolve(root, name);
  const want = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(want)) {
      console.error(`stale: ${name}`);
      bad++;
    }
  } else writeFileSync(path, want);
}
if (check) {
  for (const dir of ['tamper', 'tamper-assets']) {
    const extra = existsSync(resolve(root, dir))
      ? readdirSync(resolve(root, dir)).filter(
          (f) => !files.has(`${dir}/${f}`) && f !== 'README.md',
        )
      : [];
    for (const f of extra) {
      console.error(`unexpected: ${dir}/${f}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`tamper vectors up to date (${files.size} files)`);
} else console.log(`wrote ${files.size} files under ${root}`);
