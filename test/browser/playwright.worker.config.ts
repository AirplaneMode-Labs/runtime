// Browser proof of the engine worker: worker.spec.ts, isolation.spec.ts and guard-order.spec.ts (and
// tt.spec.ts, which only runs when Trusted Types landed). The server is the model proof's (the demo with
// the signed SmolLM2 test model, plus the isolation manifest) on 127.0.0.1:8790.
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:worker

import { defineConfig } from 'playwright/test';
import { DEFAULT_RESULTS_DIR } from './out-dir';

const PORT = 8790;

export default defineConfig({
  testDir: '.',
  testMatch: ['worker.spec.ts', 'isolation.spec.ts', 'guard-order.spec.ts', 'tt.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: DEFAULT_RESULTS_DIR,
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', trace: 'off' },
  webServer: {
    command:
      'npm run demo:build && node test/browser/model-fixture.mjs --isolation && ' +
      `node test/browser/range-server.mjs --port ${PORT} --serve demo/dist --test-endpoints --asset hello-data=1048576`,
    url: `http://127.0.0.1:${PORT}/models.html`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
