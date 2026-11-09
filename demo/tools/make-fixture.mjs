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
import { ephemeralSigner, verifySig } from '../../test/tools/lib.mjs';
import {
  buildModelManifest,
  readModelsJson,
  readOrtPins,
} from '../../test/tools/model-manifest.mjs';

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

const MIT_ORT = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

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

/** DEMO_MODELS=1: builds demo/public/models/ signed with the per-build key. */
function bundleModels(signer) {
  const modelKey = 'smollm2-135m-instruct';
  const cache = path.resolve(repo, '.cache', 'models');
  const models = readModelsJson();
  const m = models.models[modelKey];
  const pins = readOrtPins();
  const out = path.resolve(publicDir, 'models');
  removeBundledModels();
  mkdirSync(path.join(out, 'ort'), { recursive: true });
  for (const f of m.files) {
    const from = path.join(cache, modelKey, ...f.path.split('/'));
    if (!existsSync(from))
      throw new Error(`${from} is missing: run node test/tools/fetch-model.mjs ${modelKey}`);
    const to = path.join(out, modelKey, ...f.path.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  const ortFrom = path.join(cache, 'ort', pins.wasmFile);
  if (!existsSync(ortFrom))
    throw new Error(`${ortFrom} is missing: run node test/tools/fetch-model.mjs ${modelKey}`);
  copyFileSync(ortFrom, path.join(out, 'ort', pins.wasmFile));

  const createdAt = rfc3339Now();
  // buildModelManifest recomputes every size and sha256 from the copied files and compares them with
  // models.json and ort-pins.ts before signing; a mismatch throws and fails the build.
  const built = buildModelManifest({
    cacheDir: out,
    modelKey,
    manifestId: 'dev.airplanemode.demo-models',
    manifestVersion: '0.1.0',
    publisher: 'Airplane Mode Labs (demo test model, per-build key)',
    outDir: out,
    descriptorEntryId: 'smollm2-135m-instruct.descriptor',
    descriptorFile: 'smollm2-135m-instruct.descriptor.json',
    descriptor: {
      id: 'smollm2-135m-instruct',
      engine: 'transformers-js',
      task: 'text-generation',
      devices: ['wasm', 'webgpu'],
      dtype: 'q4',
      contextLength: 8192,
    },
    entryIds: {
      'config.json': 'smollm2-135m-instruct.config',
      'generation_config.json': 'smollm2-135m-instruct.generation-config',
      'onnx/model_q4.onnx': 'smollm2-135m-instruct.onnx-q4',
      'tokenizer.json': 'smollm2-135m-instruct.tokenizer',
      'tokenizer_config.json': 'smollm2-135m-instruct.tokenizer-config',
    },
    ortEntryId: 'ort.wasm',
    createdAt,
    sign: (body) => signer.sign(body, createdAt),
  });
  if (!verifySig(built.manifest, built.manifest.signatures[0].sig, signer.publicKeyHex))
    throw new Error('models manifest signature self-check failed');

  const apache = readFileSync(path.resolve(repo, 'LICENSE'), 'utf8');
  writeFileSync(
    path.join(out, 'LICENSE-SmolLM2-135M-Instruct.txt'),
    `${apache.trimEnd()}\n\n${m.repo}@${m.revision}\n`,
  );
  writeFileSync(path.join(out, 'LICENSE-onnxruntime-web.txt'), MIT_ORT);
  const provenance = {
    note: 'Files of the test model bundled in this build. The model is a third-party model (Apache-2.0); nothing here was modified. Sizes and sha256 equal test/tools/models.json at build time.',
    model: {
      repo: m.repo,
      revision: m.revision,
      licence: m.licence,
      files: m.files.map((f) => ({
        path: `${modelKey}/${f.path}`,
        size: f.size,
        sha256: f.sha256,
      })),
    },
    runtime: {
      package: 'onnxruntime-web',
      version: pins.version,
      licence: 'MIT',
      wasm: {
        path: `ort/${pins.wasmFile}`,
        size: built.entries.find((e) => e.id === 'ort.wasm').size,
        sha256: pins.wasmSha256,
      },
      factory: { path: `app/ort/${pins.factoryFile}`, sha256: pins.factorySha256 },
    },
    manifest: { id: built.manifest.id, version: built.manifest.version, createdAt },
  };
  writeFileSync(path.join(out, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  writeFileSync(
    path.join(out, 'trust-root.json'),
    JSON.stringify(
      {
        bundled: true,
        keyId: signer.keyId,
        publicKeyHex: signer.publicKeyHex,
        manifestPath: 'models/manifest.json',
        descriptorEntryId: 'smollm2-135m-instruct.descriptor',
        totalBytes: built.totalBytes,
        modelName: 'SmolLM2-135M-Instruct (q4, English, Apache-2.0)',
        note: 'public key of the per-build signing key; the private half was never written to disk',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `models/  ${built.entries.length} signed entries, ${built.totalBytes} B, manifest dev.airplanemode.demo-models`,
  );
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

  copyOrtFactory();
  copyNotices();
  if (process.env['DEMO_MODELS'] === '1') bundleModels(signer);
  else removeBundledModels();

  for (const e of entries) console.log(`${e.id}  ${e.size} B  sha256 ${e.sha256}`);
  console.log(`manifest.json  createdAt ${createdAt}  keyId ${signature.keyId}`);
  console.log(`wrote ${out}`);
}

main();
