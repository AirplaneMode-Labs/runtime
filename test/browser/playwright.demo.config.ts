// Browser proof of the refreshed demo: test/browser/demo.spec.ts (the backend page; needs RUNTIME_MODEL=1)
// test/browser/tamper.spec.ts (the Tamper lab; no model needed) and test/browser/stop.spec.ts (the Stop
// button; needs RUNTIME_MODEL=1). The demo is built exactly as pages.yml
// builds it (DEMO_MODELS=1 npm run demo:build), served under /runtime/ by a server that 404s every other
// path (test/browser/subpath-server.mjs).
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:demo
//   npm run test:demo -- tamper.spec.ts        (the Tamper lab alone)

import { defineConfig } from 'playwright/test';
import { DEFAULT_RESULTS_DIR } from './out-dir';

const PORT = 8791;

export default defineConfig({
  testDir: '.',
  testMatch: ['demo.spec.ts', 'tamper.spec.ts', 'stop.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: DEFAULT_RESULTS_DIR,
  use: { channel: 'chrome', trace: 'off' },
  webServer: {
    command:
      'node test/tools/fetch-model.mjs smollm2-135m-instruct && DEMO_MODELS=1 npm run demo:build && ' +
      `node test/browser/subpath-server.mjs --port ${PORT} --serve demo/dist --base /runtime/`,
    url: `http://127.0.0.1:${PORT}/runtime/models.html`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 8 * 60_000,
  },
});
