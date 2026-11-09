// Browser proof of the backend adapters: the same prompt answered with SmolLM2-135M-Instruct (q4) on
// the WebGPU path and on a forced WebAssembly path, in installed Chrome (channel "chrome"), behind an
// aborting network gate. Local, plus the WASM leg in CI.
//
//   node test/tools/fetch-model.mjs smollm2-135m-instruct     # once; .cache/ is gitignored
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:model
//   RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model   # the CI leg: WebAssembly only
//
// The web server builds the demo (no model bundled), signs the test manifest with the public RFC 8032
// test key into .cache/models/test-models/ and serves demo/dist plus /models/ (real files under
// .cache/models) on 127.0.0.1:8790.
//
// RUNTIME_HINDI_SMOKE=1 also builds the Qwen3 manifest and runs hindi-smoke.spec.ts (see its header).
// RUNTIME_MODEL_OUT=<dir> writes model-run.json / hindi-smoke.json there (default: test-results/).

import { defineConfig } from 'playwright/test';

const PORT = 8790;
// Local only, never CI, Pages or a demo: the Qwen3-1.7B Hindi smoke run (RUNTIME_HINDI_SMOKE=1).
const HINDI = process.env['RUNTIME_HINDI_SMOKE'] === '1';

export default defineConfig({
  testDir: '.',
  testMatch: HINDI ? ['model.spec.ts', 'hindi-smoke.spec.ts'] : ['model.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: '../../test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    headless: process.env['RUNTIME_HEADED'] !== '1',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  webServer: {
    command:
      'npm run demo:build && node test/browser/model-fixture.mjs && ' +
      (HINDI ? 'node test/browser/model-fixture.mjs --hindi && ' : '') +
      `node test/browser/range-server.mjs --port ${PORT} --serve demo/dist --test-endpoints --asset hello-data=1048576`,
    url: `http://127.0.0.1:${PORT}/models.html`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
