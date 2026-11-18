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
// Writes demo/public/tamper/ (the Tamper lab): a verbatim copy of spec/vectors/tamper and
// spec/vectors/tamper-assets (see demo/tools/tamper-fixture.mjs). The build fails if any copied file's
// sha256 differs from the spec.
//
// Signing: an Ed25519 key pair from crypto.generateKeyPairSync (test/tools/lib.mjs ephemeralSigner)
// is held in memory only for the duration of this process. The signing half is never exported,
// never put into the environment and never printed; only its public half leaves this process
// (manifest.signatures[0].publicKey and trust-root.json). The signature therefore proves the verification path, not a publisher identity:
// every build gets a fresh key.
//
// Also, on every run:
//   app/ort/<ORT_FACTORY_FILE>           the ONNX Runtime Web wasm factory the backend page loads from its
//                                        own origin, copied from node_modules after its sha256 is checked
//                                        against src/backends/ort-pins.ts (MIT; see THIRD-PARTY-NOTICES.txt)
//   THIRD-PARTY-NOTICES.txt              copy of demo/THIRD-PARTY-NOTICES.txt
//
// With DEMO_MODELS=1 it also bundles the test model (the backend page's "Download test model"):
//   models/                              the files of smollm2-135m-instruct from .cache/models (fetched
//                                        and re-hashed by test/tools/fetch-model.mjs), the ONNX Runtime
//                                        wasm, a descriptor and a manifest 'dev.airplanemode.demo-models'
//                                        signed with the SAME per-build key, LICENSE-SmolLM2-135M-Instruct.txt
//                                        (Apache-2.0 text plus the repo@revision line),
//                                        LICENSE-onnxruntime-web.txt (MIT), PROVENANCE.json (repo, revision,
//                                        path, size and sha256 of every file) and trust-root.json.
//                                        Every signed file's size and sha256 is recomputed and compared with
//                                        test/tools/models.json and ort-pins.ts first: a mismatch fails the build.
// Without DEMO_MODELS=1 any stale demo/public/models/ is removed so a build never ships old weights.
//
// Output path safety: the writer refuses any --out that is not inside <repo>/demo/public/.
// node:path everywhere, no shell globs (the CI matrix includes Windows).
//
//   node demo/tools/make-fixture.mjs [--out demo/public/fixture]
//   DEMO_MODELS=1 node demo/tools/make-fixture.mjs

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStream } from '../../test/tools/xorshift.mjs';
import { DEFAULT_TAMPER_OUT, SPEC_VECTORS_DIR, buildTamperFixture } from './tamper-fixture.mjs';
import { ephemeralSigner, verifySig } from '../../test/tools/lib.mjs';
import { readOrtPins } from '../../test/tools/model-manifest.mjs';
import { bundleModels } from '../../scripts/bundle-models.mjs';

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

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Copies the pinned ONNX Runtime Web factory to public/app/ort/ after checking it against the pin. */
function copyOrtFactory() {
  const pins = readOrtPins();
  const src = path.resolve(repo, 'node_modules', 'onnxruntime-web', 'dist', pins.factoryFile);
  if (!existsSync(src)) throw new Error(`${src} is missing: run npm ci`);
  const sha = sha256File(src);
  if (sha !== pins.factorySha256)
    throw new Error(
      `ONNX Runtime factory ${pins.factoryFile}: sha256 ${sha} differs from ort-pins.ts`,
    );
  const dir = path.resolve(publicDir, 'app', 'ort');
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, path.join(dir, pins.factoryFile));
  console.log(`app/ort/${pins.factoryFile}  sha256 ${sha} (pinned)`);
}

function copyNotices() {
  copyFileSync(
    path.resolve(here, '..', 'THIRD-PARTY-NOTICES.txt'),
    path.join(publicDir, 'THIRD-PARTY-NOTICES.txt'),
  );
}

/** Removes demo/public/models (a build output). The path is literal and inside demo/public. */
function removeBundledModels() {
  const dir = path.resolve(publicDir, 'models');
  if (dir !== path.join(publicDir, 'models')) throw new Error('unexpected models path');
  rmSync(dir, { recursive: true, force: true });
}

/**
 * DEMO_MODELS=1: builds demo/public/models/ with scripts/bundle-models.mjs, the 'runtime-demo' set
 * (SmolLM2-135M q4 and multilingual-e5-small q8; manifest 'dev.airplanemode.runtime-demo-models', no expiresAt,
 * every engine-readable file an entry, relative urls, one signature from a key generated in memory by that
 * script and never exported). The page pins the manifest id with expectManifestId. The demo's own per-build
 * signer is not used for the models: bundle-models owns its key.
 */
async function bundleDemoModels() {
  const out = path.resolve(publicDir, 'models');
  removeBundledModels();
  const built = await bundleModels({
    set: 'runtime-demo',
    out,
    root: publicDir,
    manifestId: 'dev.airplanemode.runtime-demo-models',
    ortDir: path.resolve(repo, '.cache', 'models', 'ort'),
    trustRootOut: path.resolve(repo, 'demo', '.generated', 'trust-root.ts'),
    packagePath: path.resolve(repo, 'package.json'),
  });
  const sig = built.manifest.signatures[0];
  const publicKeyHex = Buffer.from(sig.publicKey, 'base64').toString('hex');
  const descriptorSize = (id) => built.manifest.entries.find((e) => e.id === id).size;
  const entryBytes = (prefix) =>
    built.manifest.entries.filter((e) => e.id.startsWith(prefix)).reduce((n, e) => n + e.size, 0);
  writeFileSync(
    path.join(out, 'trust-root.json'),
    JSON.stringify(
      {
        bundled: true,
        manifestId: built.manifest.id,
        keyId: sig.keyId,
        publicKeyHex,
        manifestPath: 'models/manifest.json',
        descriptorEntryId: 'smollm2-135m-instruct.descriptor',
        embedDescriptorEntryId: 'multilingual-e5-small.descriptor',
        totalBytes: entryBytes('smollm2-135m-instruct.') + entryBytes('ort.'),
        embedBytes: entryBytes('multilingual-e5-small.') + descriptorSize('ort.wasm'),
        bundleBytes: built.totalBytes,
        modelName: 'SmolLM2-135M-Instruct (q4, English, Apache-2.0)',
        embedModelName: 'multilingual-e5-small (q8, 384 dimensions, MIT)',
        note: 'public key of the per-build signing key; the private half lived only in memory inside bundle-models.mjs',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `models/  ${built.manifest.entries.length} signed entries, ${built.totalBytes} B, manifest ${built.manifest.id}`,
  );
}

async function main() {
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

  // the Tamper lab: spec/vectors/tamper and tamper-assets, verbatim; the build fails on any difference
  const tamperFiles = buildTamperFixture({
    vectorsDir: SPEC_VECTORS_DIR,
    outDir: DEFAULT_TAMPER_OUT,
  });
  console.log(`tamper/  ${tamperFiles} spec vector files, sha256 equal to spec/vectors`);

  copyOrtFactory();
  copyNotices();
  if (process.env['DEMO_MODELS'] === '1') await bundleDemoModels();
  else removeBundledModels();

  for (const e of entries) console.log(`${e.id}  ${e.size} B  sha256 ${e.sha256}`);
  console.log(`manifest.json  createdAt ${createdAt}  keyId ${signature.keyId}`);
  console.log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
