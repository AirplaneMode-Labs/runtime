// The signed test manifest for the browser model proof (test/browser/model.spec.ts):
// 'dev.airplanemode.test-models' 0.1.0, signed with the RFC 8032 test key (public, non-secret test
// data: trusted only with allowTestKeys, loopback pages only), seven entries sorted by id:
//   ort.wasm, smollm2-135m-instruct.config, smollm2-135m-instruct.descriptor,
//   smollm2-135m-instruct.generation-config, smollm2-135m-instruct.onnx-q4,
//   smollm2-135m-instruct.tokenizer, smollm2-135m-instruct.tokenizer-config
// Every size and sha256 is recomputed from the cached files and must equal test/tools/models.json
// and src/backends/ort-pins.ts before it is signed (test/tools/model-manifest.mjs).
//
//   node test/browser/model-fixture.mjs [--cache .cache/models] [--hindi]
// writes <cache>/test-models/manifest.json and <cache>/test-models/smollm2-135m-instruct.descriptor.json;
// with --hindi, <cache>/hindi-smoke/manifest.json for the local Qwen3-1.7B smoke run (hindi-smoke.spec.ts)

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RFC8032_SEED_HEX, signManifest } from '../tools/lib.mjs';
import { buildModelManifest } from '../tools/model-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export const TEST_MODEL_MANIFEST_ID = 'dev.airplanemode.test-models';
export const TEST_MODEL_DESCRIPTOR_ENTRY = 'smollm2-135m-instruct.descriptor';
export const TEST_MODEL_MANIFEST_PATH = '/models/test-models/manifest.json';

export function buildTestModelFixture({ cacheDir = resolve(repoRoot, '.cache/models') } = {}) {
  const signedAt = '2026-11-09T00:00:00Z';
  return buildModelManifest({
    cacheDir,
    modelKey: 'smollm2-135m-instruct',
    manifestId: TEST_MODEL_MANIFEST_ID,
    manifestVersion: '0.1.0',
    publisher: 'Airplane Mode Labs (test models, RFC 8032 test key)',
    outDir: resolve(cacheDir, 'test-models'),
    descriptorEntryId: TEST_MODEL_DESCRIPTOR_ENTRY,
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
    createdAt: signedAt,
    sign: (body) => signManifest(body, RFC8032_SEED_HEX, signedAt),
  });
}

export const HINDI_SMOKE_MANIFEST_ID = 'dev.airplanemode.hindi-smoke';
export const HINDI_SMOKE_DESCRIPTOR_ENTRY = 'qwen3-1.7b.tjs-webgpu-q4f16';

/**
 * The local-only Hindi smoke manifest (D1-09): Qwen3-1.7B q4f16 through Transformers.js on WebGPU.
 * Never used by CI, Pages or a demo; the weights are fetched into the gitignored cache by
 * `node test/tools/fetch-model.mjs qwen3-1.7b-webgpu-q4f16`. The descriptor demands a WebGPU device with
 * shader-f16 and 8 GB of RAM, and turns Qwen3's thinking mode off.
 */
export function buildHindiSmokeFixture({ cacheDir = resolve(repoRoot, '.cache/models') } = {}) {
  const signedAt = '2026-11-09T00:00:00Z';
  return buildModelManifest({
    cacheDir,
    modelKey: 'qwen3-1.7b-webgpu-q4f16',
    manifestId: HINDI_SMOKE_MANIFEST_ID,
    manifestVersion: '0.1.0',
    publisher: 'Airplane Mode Labs (Hindi smoke run, RFC 8032 test key)',
    outDir: resolve(cacheDir, 'hindi-smoke'),
    descriptorEntryId: HINDI_SMOKE_DESCRIPTOR_ENTRY,
    descriptorFile: 'qwen3-1.7b.tjs-webgpu-q4f16.descriptor.json',
    descriptor: {
      id: 'qwen3-1.7b.tjs-webgpu-q4f16',
      engine: 'transformers-js',
      task: 'text-generation',
      devices: ['webgpu'],
      dtype: 'q4f16',
      contextLength: 40960,
      generation: { maxNewTokens: 128, chatTemplateKwargs: { enable_thinking: false } },
    },
    minProfile: { gpu: 'webgpu', backendTier: 'webgpu-f16', ramGb: 8 },
    entryIds: {
      'chat_template.jinja': 'qwen3-1.7b.chat-template',
      'config.json': 'qwen3-1.7b.config',
      'generation_config.json': 'qwen3-1.7b.generation-config',
      'onnx/model_q4f16.onnx': 'qwen3-1.7b.onnx-q4f16',
      'tokenizer.json': 'qwen3-1.7b.tokenizer',
      'tokenizer_config.json': 'qwen3-1.7b.tokenizer-config',
    },
    ortEntryId: 'ort.wasm',
    createdAt: signedAt,
    sign: (body) => signManifest(body, RFC8032_SEED_HEX, signedAt),
  });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const i = process.argv.indexOf('--cache');
  const cacheDir = i >= 0 ? resolve(process.argv[i + 1]) : resolve(repoRoot, '.cache/models');
  try {
    const r = process.argv.includes('--hindi')
      ? buildHindiSmokeFixture({ cacheDir })
      : buildTestModelFixture({ cacheDir });
    console.log(
      `signed ${r.entries.length} entries (${r.totalBytes} bytes) -> ${r.manifestPath}\n` +
        r.entries.map((e) => `  ${e.id} ${e.size} ${e.sha256.slice(0, 12)}`).join('\n'),
    );
  } catch (e) {
    console.error(`model-fixture: ${e.message}`);
    process.exit(1);
  }
}
