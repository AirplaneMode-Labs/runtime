// Browser proof of the DevTools panel (test/browser/devtools.spec.ts). Same server as the model proof
// (the demo with the signed test model on 127.0.0.1:8790), after building the extension.
//
//   RUNTIME_MODEL=1 npm run test:devtools                              (renderer)
//   RUNTIME_MODEL=1 RUNTIME_DEVTOOLS_HEADED=1 npm run test:devtools    (renderer and DevTools transport)
//
// The test launches its own Chrome with a temporary profile; only the web server comes from here.

import { defineConfig } from 'playwright/test';
import { DEFAULT_RESULTS_DIR } from './out-dir';

const PORT = 8790;

export default defineConfig({
  testDir: '.',
  testMatch: ['devtools.spec.ts'],
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
      'npm run demo:build && npm run devtools:build && node test/browser/model-fixture.mjs && ' +
      `node test/browser/range-server.mjs --port ${PORT} --serve demo/dist --test-endpoints --asset hello-data=1048576`,
    url: `http://127.0.0.1:${PORT}/models.html`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
