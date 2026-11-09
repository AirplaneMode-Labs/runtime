// Builds a signed model manifest (descriptor + files) from a fetched model in the gitignored cache.
// Shared by test/browser/model-fixture.mjs (RFC 8032 test key, loopback tests only) and
// demo/tools/make-fixture.mjs (the per-build ephemeral key of the Pages demo).
//
// Before anything is signed every file's size and sha256 are recomputed from disk and compared with
// test/tools/models.json (and the ORT wasm with src/backends/ort-pins.ts): a cached file that is not
// exactly the pinned one makes the build fail, so a signature never covers unverified bytes.
//
// Layout it expects under <cacheDir>:
//   <modelKey>/<path>            files fetched by fetch-model.mjs
//   ort/<ORT_WASM_FILE>          copied by fetch-model.mjs from node_modules/onnxruntime-web
// and it writes, under <outDir> (a directory inside <cacheDir>):
//   manifest.json, <descriptorFile>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export const DESCRIPTOR_MEDIA_TYPE = 'application/vnd.airplanemode.model+json';

export function readOrtPins() {
  const text = readFileSync(join(repoRoot, 'src/backends/ort-pins.ts'), 'utf8');
  const pin = (key) => {
    const m = new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`).exec(text);
    if (!m)
      throw new Error(
        `src/backends/ort-pins.ts: ${key} not found; run node test/tools/gen-ort-pins.mjs`,
      );
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

export function readModelsJson() {
  return JSON.parse(readFileSync(join(here, 'models.json'), 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * @param {object} spec
 * @param {string} spec.cacheDir       absolute path of .cache/models
 * @param {string} spec.modelKey       key in models.json
 * @param {string} spec.manifestId     manifest id
 * @param {string} spec.manifestVersion
 * @param {string} spec.outDir         absolute directory (inside cacheDir) for manifest.json and the descriptor
 * @param {string} spec.descriptorEntryId  manifest entry id of the descriptor
 * @param {string} spec.descriptorFile file name of the descriptor under outDir
 * @param {object} spec.descriptor     descriptor fields except spec, source and files (id, engine, task, devices, dtype, contextLength, generation?)
 * @param {Record<string,string>} spec.entryIds  model file path -> manifest entry id (every file of the model)
 * @param {string} spec.ortEntryId     manifest entry id of the ORT wasm
 * @param {(manifestBody: object) => object} spec.sign  returns one Signature for the body
 * @param {string} [spec.createdAt]
 * @param {object} [spec.minProfile]   minProfile of every entry (default {})
 * @param {object} [spec.models]       models.json contents (tests); default test/tools/models.json
 * @param {object} [spec.pins]         ORT pins (tests); default src/backends/ort-pins.ts
 * @param {Record<string,{kind:string, licence?:string}>} [spec.kinds] per path overrides
 */
export function buildModelManifest(spec) {
  const models = spec.models ?? readModelsJson();
  const m = models.models[spec.modelKey];
  if (!m) throw new Error(`models.json has no model ${spec.modelKey}`);
  const pins = spec.pins ?? readOrtPins();
  const cacheDir = resolve(spec.cacheDir);
  const outDir = resolve(spec.outDir);
  if (outDir !== cacheDir && !outDir.startsWith(cacheDir + sep))
    throw new Error(`refusing to write outside ${cacheDir}: ${outDir}`);
  mkdirSync(outDir, { recursive: true });

  const minProfile = spec.minProfile ?? {};
  const manifestUrlDir = outDir;
  const rel = (abs) => relative(manifestUrlDir, abs).split(sep).join('/');
  const entries = [];
  const descriptorFiles = [];

  const kindOf = (path) => {
    if (spec.kinds?.[path]?.kind) return spec.kinds[path].kind;
    if (path.endsWith('.onnx') || path.endsWith('.onnx_data')) return 'model';
    if (path.startsWith('tokenizer')) return 'tokenizer';
    return 'other';
  };

  for (const f of m.files) {
    const abs = join(cacheDir, spec.modelKey, ...f.path.split('/'));
    if (!existsSync(abs))
      throw new Error(`${abs} is missing: run node test/tools/fetch-model.mjs ${spec.modelKey}`);
    const size = statSync(abs).size;
    const sha = sha256File(abs);
    if (size !== f.size || sha !== f.sha256)
      throw new Error(
        `${spec.modelKey}/${f.path}: on-disk size ${size} sha256 ${sha} differs from models.json (${f.size} ${f.sha256})`,
      );
    const id = spec.entryIds[f.path];
    if (!id) throw new Error(`no manifest entry id configured for ${f.path}`);
    entries.push({
      id,
      kind: kindOf(f.path),
      url: rel(abs),
      sha256: sha,
      size,
      version: '1.0.0',
      licence: spec.kinds?.[f.path]?.licence ?? m.licence,
      minProfile,
    });
    descriptorFiles.push({ path: f.path, entryId: id });
  }

  const ortAbs = join(cacheDir, 'ort', pins.wasmFile);
  if (!existsSync(ortAbs))
    throw new Error(`${ortAbs} is missing: run node test/tools/fetch-model.mjs ${spec.modelKey}`);
  const ortSha = sha256File(ortAbs);
  if (ortSha !== pins.wasmSha256)
    throw new Error(
      `ort/${pins.wasmFile}: sha256 ${ortSha} differs from ort-pins.ts (${pins.wasmSha256})`,
    );
  const ortSize = statSync(ortAbs).size;
  const ortPath = `runtime/${pins.wasmFile}`;
  entries.push({
    id: spec.ortEntryId,
    kind: 'wasm',
    url: rel(ortAbs),
    sha256: ortSha,
    size: ortSize,
    version: pins.version.replace(/\+.*$/, ''),
    licence: 'MIT',
    minProfile: {},
  });
  descriptorFiles.push({ path: ortPath, entryId: spec.ortEntryId });
  descriptorFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const descriptor = {
    spec: 'airplanemode.model/0.1',
    id: spec.descriptor.id,
    engine: spec.descriptor.engine,
    task: spec.descriptor.task,
    devices: spec.descriptor.devices,
    dtype: spec.descriptor.dtype,
    files: descriptorFiles,
    runtimeWasm: ortPath,
    contextLength: spec.descriptor.contextLength,
    ...(spec.descriptor.generation ? { generation: spec.descriptor.generation } : {}),
    source: { repo: m.repo, revision: m.revision },
    licence: m.licence,
  };
  const descriptorText = JSON.stringify(descriptor, null, 2) + '\n';
  const descriptorBytes = Buffer.from(descriptorText, 'utf8');
  if (descriptorBytes.length > 65536) throw new Error('descriptor exceeds 65536 bytes');
  const descriptorPath = join(outDir, spec.descriptorFile);
  writeFileSync(descriptorPath, descriptorBytes);
  entries.push({
    id: spec.descriptorEntryId,
    kind: 'model',
    mediaType: DESCRIPTOR_MEDIA_TYPE,
    url: spec.descriptorFile,
    sha256: createHash('sha256').update(descriptorBytes).digest('hex'),
    size: descriptorBytes.length,
    version: '1.0.0',
    licence: m.licence,
    minProfile,
  });

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const createdAt = spec.createdAt ?? '2026-11-09T00:00:00Z';
  const body = {
    spec: 'airplanemode.manifest/0.1',
    id: spec.manifestId,
    version: spec.manifestVersion,
    publisher: spec.publisher ?? 'Airplane Mode Labs (test fixture)',
    createdAt,
    entries,
    signatures: [],
  };
  body.signatures = [spec.sign(body)];
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(body, null, 2) + '\n');
  return {
    manifestPath,
    manifest: body,
    descriptor,
    descriptorPath,
    entries,
    pins,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
  };
}
