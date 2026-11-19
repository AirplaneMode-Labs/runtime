#!/usr/bin/env node
// Builds a signed demo model bundle for a consumer repository (dockit, the runtime demo). Not part of the
// published package (package.json `files` does not list scripts/); the owner and CI run it from a checkout.
//
//   node scripts/bundle-models.mjs --set <dockit|runtime-demo> --out <dir> --root <dir> \
//        --manifest-id <id> --ort-dir <dir> --trust-root-out <file> [--max-bytes 943718400] \
//        [--cache <dir>] [--package <package.json>]
//
//   --set            which models: 'dockit' (Qwen3-0.6B q8 and multilingual-e5-small q8; manifest id
//                    'dev.airplanemode.dockit-models', entries pinned) or 'runtime-demo' (SmolLM2-135M q4 and
//                    multilingual-e5-small; id 'dev.airplanemode.runtime-demo-models')
//   --out            where the bundle is written; it must resolve (after realpath) strictly inside --root
//   --root           the consumer's public directory: nothing is written outside it except trust-root.ts
//   --manifest-id    must equal the set's id: a mix-up of the two sets is a usage error
//   --ort-dir        a directory holding the pinned ONNX Runtime Web .wasm and .mjs (checked against ort-pins.ts)
//   --trust-root-out the generated src/generated/trust-root.ts of the consumer (its basename must be trust-root.ts)
//   --cache          the fetch-model cache (default <repo>/.cache/models); every file is re-hashed against models.json
//   --package        the consumer's package.json (default <root>/../package.json): its version is the manifest version
//
// What it writes under --out: manifest.json (one ed25519 signature), the files of every model, ort/ (the ORT
// wasm and its .mjs factory), one descriptor per model, LICENSE-*.txt and PROVENANCE.json. The manifest:
// distinct id per set, version = the consumer's package.json version, publisher 'AirplaneMode-Labs demo
// build', createdAt = the build time (UTC, whole seconds), NO expiresAt (the demo must work offline and the
// trust root changes with every build), EVERY file the engine can read an entry with sha256, size and licence
// (.onnx, the ORT .wasm and .mjs, tokenizer.json, tokenizer_config.json, config.json, generation_config.json,
// chat_template.jinja, special_tokens_map.json), entry urls relative to the manifest directory (no leading '/',
// no '..', no backslash, no '//', no scheme), pin:true for dockit.
//
// The signing key is generated in memory for this run and NEVER exported: no KeyObject.export, no file, no
// log line. Only the public half leaves the process, in the manifest and in trust-root.ts (exactly one
// { keyId, publicKeyB64 }). No RFC 8032 test key is used and cp-sign is never run. The signature proves that
// the manifest and the bundle came from the same build, not who published it.
//
// node:path only, no shell globs: the CI matrix includes Windows. Exit status 2 for a usage error.

import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signedBytes } from '../test/tools/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

export const DESCRIPTOR_MEDIA_TYPE = 'application/vnd.airplanemode.model+json';
export const PUBLISHER = 'AirplaneMode-Labs demo build';
export const DEFAULT_MAX_BYTES = 943718400; // 900 MiB
const MANIFEST_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** The id of every entry kind, by the file path inside a model. */
const ENTRY_SUFFIX = {
  'onnx/model_quantized.onnx': 'onnx',
  'onnx/model_q4.onnx': 'onnx',
  'tokenizer.json': 'tokenizer',
  'tokenizer_config.json': 'tokenizer-config',
  'config.json': 'config',
  'generation_config.json': 'generation-config',
  'chat_template.jinja': 'chat-template',
  'special_tokens_map.json': 'special-tokens',
};
const ENTRY_KIND = {
  onnx: 'model',
  tokenizer: 'tokenizer',
  'tokenizer-config': 'tokenizer',
};

const E5 = {
  key: 'multilingual-e5-small-wasm-q8',
  name: 'multilingual-e5-small',
  descriptor: {
    task: 'feature-extraction',
    devices: ['wasm'],
    dtype: 'q8',
    contextLength: 512,
  },
  minProfile: { backendTier: 'wasm-simd' },
  licenceFile: 'LICENSE-multilingual-e5-small.txt',
};

/** The largest minProfile.ramGb a bundle may carry: navigator.deviceMemory is capped at 8 by browsers (TD-57). */
export const MAX_RAM_GB = 8;

/** The two sets (TD-33, TD-34, TD-35). */
export const SETS = Object.freeze({
  dockit: {
    manifestId: 'dev.airplanemode.dockit-models',
    pin: true,
    models: [
      {
        key: 'qwen3-0.6b-wasm-q8',
        name: 'qwen3-0.6b',
        descriptor: {
          task: 'text-generation',
          devices: ['wasm'],
          dtype: 'q8',
          contextLength: 2048,
          generation: { maxNewTokens: 256, chatTemplateKwargs: { enable_thinking: false } },
        },
        minProfile: { backendTier: 'wasm-simd', ramGb: 4, storageFreeGb: 2 },
        licenceFile: 'LICENSE-Qwen3-0.6B.txt',
      },
      E5,
    ],
  },
  'runtime-demo': {
    manifestId: 'dev.airplanemode.runtime-demo-models',
    pin: false,
    models: [
      {
        key: 'smollm2-135m-instruct',
        name: 'smollm2-135m-instruct',
        descriptor: {
          task: 'text-generation',
          devices: ['wasm', 'webgpu'],
          dtype: 'q4',
          contextLength: 8192,
        },
        minProfile: {},
        licenceFile: 'LICENSE-SmolLM2-135M-Instruct.txt',
      },
      E5,
    ],
  },
});

export class BundleUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleUsageError';
  }
}
const usage = (m) => new BundleUsageError(m);

// ---- paths ------------------------------------------------------------------------------------------

/** realpath of `p` even when it does not exist yet: the nearest existing ancestor is resolved, the rest appended. */
function realish(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Throws a usage error unless `out` is strictly inside `root` after every symlink is resolved. */
export function assertInside(root, out) {
  if (!existsSync(root)) throw usage(`--root ${root} does not exist`);
  const realRoot = realpathSync(root);
  // a link at the final component or on the way (lstat) is judged by its target
  const realOut = realish(out);
  const rel = relative(realRoot, realOut);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw usage(`--out ${out} is not inside --root ${root} (resolved: ${realOut})`);
  return { realRoot, realOut };
}

// ---- hashing and licence texts --------------------------------------------------------------------------

async function sha256Of(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function apacheText() {
  return readFileSync(join(repoRoot, 'LICENSE'), 'utf8');
}

const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
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

function licenceText(model, entry) {
  const head = `${entry.licence} licence of ${model.name}\nSource: ${entry.repo} at revision ${entry.revision}\n`;
  if (entry.licence === 'Apache-2.0')
    return `${head}${entry.licenceNote ? `Note: ${entry.licenceNote}\n` : ''}\n${apacheText()}`;
  if (entry.licence === 'MIT')
    return `${head}${entry.licenceNote ? `Note: ${entry.licenceNote}\n` : ''}\nMIT License\n\nNo copyright line is published in the source repository and none is invented here.\n\n${MIT_PERMISSION}`;
  return `${head}See the source repository for the licence text.\n`;
}

const MIT_ORT = `MIT License\n\nCopyright (c) Microsoft Corporation\n\n${MIT_PERMISSION}`;

// ---- the build -------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {'dockit'|'runtime-demo'} o.set
 * @param {string} o.out
 * @param {string} o.root
 * @param {string} o.manifestId
 * @param {string} o.ortDir
 * @param {string} o.trustRootOut
 * @param {number} [o.maxBytes]
 * @param {string} [o.cache]
 * @param {string} [o.packagePath]
 * @param {object} [deps]  tests: models (models.json contents), pins, generateKeyPair, now, log
 */
export async function bundleModels(o, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const set = Object.hasOwn(SETS, o.set ?? '') ? SETS[o.set] : undefined;
  if (!set) throw usage(`--set must be one of ${Object.keys(SETS).join(', ')}`);
  if (o.manifestId !== set.manifestId)
    throw usage(`--manifest-id for --set ${o.set} must be ${set.manifestId}`);
  // capability profile 0.1.1 clamps ramGb to at most 8, so a minProfile.ramGb above 8 is schema-valid but can
  // never be satisfied (MANIFEST.md, Manifest 0.1.3): the bundler refuses to emit one, before anything is read
  for (const m of set.models)
    if (!(
      m.minProfile.ramGb === undefined ||
      (Number.isFinite(m.minProfile.ramGb) && m.minProfile.ramGb <= MAX_RAM_GB)
    ))
      throw usage(
        `${m.name}: minProfile.ramGb ${m.minProfile.ramGb} is above ${MAX_RAM_GB}, which no browser reports (capability profile 0.1.1)`,
      );
  if (!MANIFEST_ID.test(o.manifestId)) throw usage('--manifest-id is not a manifest id');
  for (const k of ['out', 'root', 'ortDir', 'trustRootOut'])
    if (typeof o[k] !== 'string' || o[k] === '')
      throw usage(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw usage('--max-bytes must be a positive integer');
  const { realOut } = assertInside(o.root, o.out);
  const out = realOut;
  if (basename(o.trustRootOut) !== 'trust-root.ts')
    throw usage('--trust-root-out must be a file named trust-root.ts');
  const trustOut = resolve(o.trustRootOut);
  if (trustOut.startsWith(out + sep))
    throw usage(
      '--trust-root-out must not be inside the bundle: the trust root is compiled in, not shipped',
    );

  const packagePath = o.packagePath ?? resolve(o.root, '..', 'package.json');
  if (!existsSync(packagePath)) throw usage(`${packagePath} does not exist (--package)`);
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw usage('the consumer package.json version is not strict SemVer without build metadata');

  const models =
    deps.models ?? JSON.parse(readFileSync(join(here, '../test/tools/models.json'), 'utf8'));
  const pins = deps.pins ?? readOrtPins();
  const cache = resolve(o.cache ?? join(repoRoot, '.cache/models'));
  const ortDir = resolve(o.ortDir);

  // ---- plan: every source file exists with the pinned size, and the total fits, BEFORE anything is copied
  const plan = [];
  let total = 0;
  for (const m of set.models) {
    const entry = Object.hasOwn(models.models, m.key) ? models.models[m.key] : undefined;
    if (!entry) throw usage(`models.json has no model ${m.key}`);
    for (const f of entry.files) {
      const src = join(cache, m.key, ...f.path.split('/'));
      if (!existsSync(src))
        throw usage(`${src} is missing: run node test/tools/fetch-model.mjs ${m.key}`);
      if (statSync(src).size !== f.size)
        throw usage(
          `${m.key}/${f.path}: size ${statSync(src).size} differs from models.json (${f.size})`,
        );
      if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? ''))
        throw usage(`${m.key}/${f.path}: models.json has no sha256`);
      plan.push({ model: m, entry, file: f, src, dest: `${m.name}/${f.path}` });
      total += f.size;
    }
  }
  const ortFiles = [
    { name: pins.wasmFile, sha256: pins.wasmSha256, kind: 'wasm', id: 'ort.wasm' },
    { name: pins.factoryFile, sha256: pins.factorySha256, kind: 'other', id: 'ort.factory' },
  ];
  for (const f of ortFiles) {
    f.src = join(ortDir, f.name);
    if (!existsSync(f.src)) throw usage(`${f.src} is missing (--ort-dir)`);
    f.size = statSync(f.src).size;
    total += f.size;
  }
  if (total > maxBytes)
    throw usage(`the bundle would be ${total} bytes, over --max-bytes ${maxBytes}`);

  // ---- write (the output directory is replaced: a stale bundle is never mixed with a new one)
  if (existsSync(out)) {
    if (lstatSync(out).isSymbolicLink()) throw usage(`--out ${o.out} is a symbolic link`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  const entries = [];
  const provenance = { files: [], models: {}, ort: {} };
  for (const p of plan) {
    const dest = join(out, ...p.dest.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p.src, dest);
    // hash what was written: the bundle's own bytes are the bytes that are signed
    const sha = await sha256Of(dest);
    if (sha !== p.file.sha256 || statSync(dest).size !== p.file.size)
      throw new Error(`${p.dest}: the copied file does not match models.json`);
    const suffix = ENTRY_SUFFIX[p.file.path];
    if (!suffix) throw usage(`no entry id for ${p.file.path}`);
    const id = `${p.model.name}.${suffix}`;
    entries.push({
      id,
      kind: ENTRY_KIND[suffix] ?? 'other',
      url: p.dest,
      sha256: sha,
      size: p.file.size,
      version: '1.0.0',
      licence: p.entry.licence,
      minProfile: p.model.minProfile,
      ...(set.pin ? { pin: true } : {}),
    });
    p.id = id;
    provenance.files.push({
      path: p.dest,
      size: p.file.size,
      sha256: sha,
      repo: p.entry.repo,
      revision: p.entry.revision,
      licence: p.entry.licence,
    });
  }
  for (const f of ortFiles) {
    const dest = join(out, 'ort', f.name);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.src, dest);
    const sha = await sha256Of(dest);
    if (sha !== f.sha256)
      throw usage(`ort/${f.name}: sha256 ${sha} differs from ort-pins.ts (${f.sha256})`);
    entries.push({
      id: f.id,
      kind: f.kind,
      url: `ort/${f.name}`,
      sha256: sha,
      size: f.size,
      version: pins.version.replace(/\+.*$/, ''),
      licence: 'MIT',
      minProfile: {},
      ...(set.pin ? { pin: true } : {}),
    });
    provenance.files.push({
      path: `ort/${f.name}`,
      size: f.size,
      sha256: sha,
      repo: 'npm:onnxruntime-web',
      revision: pins.version,
      licence: 'MIT',
    });
  }
  // one descriptor per model (a manifest entry itself: kind model, the descriptor media type)
  for (const m of set.models) {
    const mine = plan.filter((p) => p.model === m);
    const ortPath = `runtime/${pins.wasmFile}`;
    const files = [
      ...mine.map((p) => ({ path: p.file.path, entryId: p.id })),
      { path: ortPath, entryId: 'ort.wasm' },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const src = mine[0].entry;
    const descriptor = {
      spec: 'airplanemode.model/0.2',
      id: m.name,
      engine: 'transformers-js',
      task: m.descriptor.task,
      devices: m.descriptor.devices,
      dtype: m.descriptor.dtype,
      files,
      runtimeWasm: ortPath,
      contextLength: m.descriptor.contextLength,
      ...(m.descriptor.generation ? { generation: m.descriptor.generation } : {}),
      ...(m.descriptor.sessionOptions ? { sessionOptions: m.descriptor.sessionOptions } : {}),
      source: { repo: src.repo, revision: src.revision },
      licence: src.licence,
    };
    const bytes = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n', 'utf8');
    if (bytes.length > 65536) throw new Error('descriptor exceeds 65536 bytes');
    const file = `${m.name}.descriptor.json`;
    writeFileSync(join(out, file), bytes);
    entries.push({
      id: `${m.name}.descriptor`,
      kind: 'model',
      mediaType: DESCRIPTOR_MEDIA_TYPE,
      url: file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      version: '1.0.0',
      licence: src.licence,
      minProfile: m.minProfile,
      ...(set.pin ? { pin: true } : {}),
    });
    total += bytes.length;
    writeFileSync(join(out, m.licenceFile), licenceText(m, src));
    provenance.models[m.name] = {
      repo: src.repo,
      revision: src.revision,
      licence: src.licence,
      descriptorEntry: `${m.name}.descriptor`,
    };
  }
  writeFileSync(join(out, 'LICENSE-onnxruntime-web.txt'), MIT_ORT);
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- sign: the key lives in this process only; nothing of it is serialised or logged
  const now = deps.now ? deps.now() : new Date();
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = {
    spec: 'airplanemode.manifest/0.1',
    id: set.manifestId,
    version,
    publisher: PUBLISHER,
    createdAt,
    entries,
    signatures: [],
  };
  const pair = (deps.generateKeyPair ?? (() => generateKeyPairSync('ed25519')))();
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const rawPublic = spki.subarray(spki.length - 32);
  const keyId = createHash('sha256').update(rawPublic).digest('hex');
  const sig = nodeSign(null, signedBytes(body), pair.privateKey);
  body.signatures = [
    {
      alg: 'ed25519',
      keyId,
      publicKey: rawPublic.toString('base64'),
      sig: sig.toString('base64'),
      signedAt: createdAt,
    },
  ];
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(body, null, 2) + '\n');
  provenance.manifest = { id: set.manifestId, version, createdAt, entries: entries.length };
  provenance.ort = {
    version: pins.version,
    wasmSha256: pins.wasmSha256,
    factorySha256: pins.factorySha256,
    ...lockedOrt(pins.version),
  };
  writeFileSync(join(out, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  mkdirSync(dirname(trustOut), { recursive: true });
  writeFileSync(
    trustOut,
    `// Generated by runtime scripts/bundle-models.mjs for ONE build (manifest ${set.manifestId} ${version}, ${createdAt}).\n` +
      "// The public half of this build's in-memory signing key, compiled in and never fetched. Git-ignored: do not commit.\n" +
      '// It proves only that the manifest and the bundle came from the same build, not who published it.\n' +
      `export const TRUST_ROOT = { keyId: '${keyId}', publicKeyB64: '${rawPublic.toString('base64')}' } as const;\n`,
  );
  const totalBytes = total + statSync(join(out, 'manifest.json')).size;
  log(`bundle ${o.set}: ${entries.length} entries, manifest ${set.manifestId} ${version}`);
  log(`total bytes: ${totalBytes} (${(totalBytes / 1048576).toFixed(1)} MiB, limit ${maxBytes})`);
  return { totalBytes, manifest: body, out, keyId, trustRootOut: trustOut };
}

/** The npm tarball integrity of onnxruntime-web from package-lock.json (offline), when the lockfile holds exactly the pinned version. */
function lockedOrt(version) {
  try {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    const e = lock.packages?.['node_modules/onnxruntime-web'];
    if (e?.version === version && typeof e.integrity === 'string')
      return {
        npmIntegrity: e.integrity,
        resolved: e.resolved,
        attestations: 'absent (npm view, 14 Nov 2026)',
        crossCheck:
          'the wasm and the factory re-hash to the pins in src/backends/ort-pins.ts (test/ort-pins.test.ts) and the browser model proof (npm run test:model) passes with these pins',
      };
  } catch {
    // no lockfile next to the script (a vendored checkout): the pins above still hold
  }
  return {};
}

function readOrtPins() {
  const text = readFileSync(join(repoRoot, 'src/backends/ort-pins.ts'), 'utf8');
  const pin = (key) => {
    const m = new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`).exec(text);
    if (!m) throw new Error(`src/backends/ort-pins.ts: ${key} not found`);
    return m[1];
  };
  return {
    version: pin('ORT_WEB_VERSION'),
    wasmFile: pin('ORT_WASM_FILE'),
    wasmSha256: pin('ORT_WASM_SHA256'),
    factoryFile: pin('ORT_FACTORY_FILE'),
    factorySha256: pin('ORT_FACTORY_SHA256'),
  };
}

function parseArgs(argv) {
  const o = {};
  const flags = {
    '--set': 'set',
    '--out': 'out',
    '--root': 'root',
    '--manifest-id': 'manifestId',
    '--ort-dir': 'ortDir',
    '--trust-root-out': 'trustRootOut',
    '--max-bytes': 'maxBytes',
    '--cache': 'cache',
    '--package': 'packagePath',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) throw usage(`unknown argument ${argv[i]}`);
    const v = argv[++i];
    if (v === undefined) throw usage(`${argv[i - 1]} needs a value`);
    o[key] = key === 'maxBytes' ? Number(v) : v;
  }
  return o;
}

export async function main(argv, deps = {}) {
  try {
    await bundleModels(parseArgs(argv), deps);
    return 0;
  } catch (e) {
    if (e instanceof BundleUsageError) {
      console.error(`bundle-models: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
