// Browser proof of the refreshed demo (test/browser/demo.spec.ts): the demo built exactly as pages.yml
// builds it (DEMO_MODELS=1 npm run demo:build), served under /runtime/ by a server that 404s every other
// path (test/browser/subpath-server.mjs).
//
//   RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:demo

import { defineConfig } from 'playwright/test';

const PORT = 8791;

export default defineConfig({
  testDir: '.',
  testMatch: ['demo.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: '../../test-results',
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
