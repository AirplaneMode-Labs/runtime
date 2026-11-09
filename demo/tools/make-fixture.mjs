#!/usr/bin/env node
// Build-time fixture for the hosted demo (https://airplanemode-labs.github.io/runtime/).
//
// Writes demo/public/fixture/ (Vite copies it to demo/dist/fixture/):
//   demo-a.bin, demo-b.bin, demo-c.bin   synthetic xorshift64* streams (12, 8 and 6 MiB), never a
//                                        model; identical on every build (see test/tools/xorshift.mjs
//                                        and `node test/tools/asset-digest.mjs demo-a 12582912`)
//   manifest.json                        airplanemode.manifest/0.1 describing the three files with
//                                        relative URLs, no expiresAt, exactly one Ed25519 signature
//   trust-root.json                      keyId and raw public key of the key that signed it
//   rfc8032-signed-example.json          copy of spec/examples/manifest.signed.example.json (signed
//                                        with the public RFC 8032 test key; the page shows it refused)
//
// Signing: an Ed25519 key pair from crypto.generateKeyPairSync (test/tools/lib.mjs ephemeralSigner)
// is held in memory only for the duration of this process. The signing half is never exported,
// never put into the environment and never printed; only its public half leaves this process
// (manifest.signatures[0].publicKey and trust-root.json). The signature therefore proves the verification path, not a publisher identity:
// every build gets a fresh key.
//
// Output path safety: the writer refuses any --out that is not inside <repo>/demo/public/.
// node:path everywhere, no shell globs (the CI matrix includes Windows).
//
//   node demo/tools/make-fixture.mjs [--out demo/public/fixture]

import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStream } from '../../test/tools/xorshift.mjs';
import { ephemeralSigner, verifySig } from '../../test/tools/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const publicDir = path.resolve(repo, 'demo', 'public');

const ENTRIES = [
  { id: 'demo-a', size: 12 * 1024 * 1024 },
  { id: 'demo-b', size: 8 * 1024 * 1024 },
  { id: 'demo-c', size: 6 * 1024 * 1024 },
];
const CHUNK_SIZE = 1048576;

function parseArgs(argv) {
  let out = path.resolve(publicDir, 'fixture');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out needs a value');
      out = path.resolve(v);
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { out };
}

/** RFC 3339 UTC with whole seconds, as the manifest contract requires. */
function rfc3339Now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Writes the synthetic stream for `name` to `file`, 1 MiB at a time, hashing as it goes. */
function writeStream(file, name, size) {
  const stream = new AssetStream(name);
  const hash = createHash('sha256');
  const buf = new Uint8Array(1 << 20);
  const fd = openSync(file, 'w');
  try {
    let left = size;
    while (left > 0) {
      const n = Math.min(left, buf.length);
      const chunk = n === buf.length ? buf : buf.subarray(0, n);
      stream.fill(chunk);
      hash.update(chunk);
      let off = 0;
      while (off < n) off += writeSync(fd, chunk, off, n - off);
      left -= n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  if (!path.resolve(out).startsWith(publicDir + path.sep)) {
    console.error(`refusing to write outside ${publicDir}: ${out}`);
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });

  const entries = [];
  for (const { id, size } of [...ENTRIES].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const sha256 = writeStream(path.join(out, `${id}.bin`), id, size);
    entries.push({
      id,
      kind: 'data',
      url: `${id}.bin`,
      sha256,
      size,
      version: '1.0.0',
      licence: 'Apache-2.0',
      minProfile: {},
      chunkSize: CHUNK_SIZE,
    });
  }

  const createdAt = rfc3339Now();
  const manifest = {
    spec: 'airplanemode.manifest/0.1',
    id: 'dev.airplanemode.demo.fixture',
    version: '1.0.0',
    publisher: 'Airplane Mode Labs (demo fixture, synthetic data)',
    createdAt,
    entries,
    signatures: [],
  };

  // Key pair for this build only (generateKeyPairSync inside ephemeralSigner); only its public half
  // is reachable from here.
  const signer = ephemeralSigner();
  const signature = signer.sign(manifest, createdAt);
  const publicKeyHex = signer.publicKeyHex;
  if (signer.keyId !== signature.keyId) throw new Error('keyId self-check failed');
  if (!verifySig(manifest, signature.sig, publicKeyHex))
    throw new Error('signature self-check failed');
  const signed = { ...manifest, signatures: [signature] };
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(signed, null, 2) + '\n');

  const trustRoot = {
    keyId: signature.keyId,
    publicKeyHex,
    note: 'public key of a key generated for this build; the private half was never written to disk or printed',
  };
  writeFileSync(path.join(out, 'trust-root.json'), JSON.stringify(trustRoot, null, 2) + '\n');

  const example = readFileSync(
    path.resolve(repo, 'spec', 'examples', 'manifest.signed.example.json'),
    'utf8',
  );
  writeFileSync(path.join(out, 'rfc8032-signed-example.json'), example);

  for (const e of entries) console.log(`${e.id}  ${e.size} B  sha256 ${e.sha256}`);
  console.log(`manifest.json  createdAt ${createdAt}  keyId ${signature.keyId}`);
  console.log(`wrote ${out}`);
}

main();
