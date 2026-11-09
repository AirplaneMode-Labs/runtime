// Browser proof for the runtime asset manager and capability detector. Channel "chrome" uses the
// installed Google Chrome, so no browser download is needed locally; CI (Linux only) uses the Chrome
// preinstalled on ubuntu-latest and checks `google-chrome --version` first (S1-058).
//
// Three range servers, three origins (so each scenario family gets its own OPFS/IndexedDB):
//   8787  honest server, test endpoints on: download, resume, quota, truncate, egress
//   8788  --corrupt-hash: the manifest lies about sha256
//   8789  --ignore-range: a host that answers every Range request with 200
//
// RUNTIME_BIG=1 switches to big.spec.ts against a server T1 starts by hand (no webServer here):
//   node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints \
//     --asset big=734003200 --asset a=734003200 --asset b=419430400 --asset c=524288000
// RUNTIME_BASE_URL overrides the default http://127.0.0.1:8787.

import { defineConfig } from 'playwright/test';

const BIG = process.env['RUNTIME_BIG'] === '1';
const BASE = process.env['RUNTIME_BASE_URL'] ?? 'http://127.0.0.1:8787';
const SERVER = 'node test/browser/range-server.mjs';
const SMALL_ASSETS =
  '--asset small=67108864 --asset a=67108864 --asset b=50331648 --asset c=67108864 --asset hello-data=1048576';

export default defineConfig({
  testDir: '.',
  testMatch: BIG ? ['big.spec.ts'] : ['asset.spec.ts', 'capability.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: BIG ? 40 * 60_000 : 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../../test-results',
  use: {
    baseURL: BASE,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  ...(BIG
    ? {}
    : {
        webServer: [
          {
            command: `npm run demo:build && ${SERVER} --port 8787 --serve demo/dist --test-endpoints ${SMALL_ASSETS}`,
            url: 'http://127.0.0.1:8787/manifest.json',
            cwd: '../..',
            reuseExistingServer: false,
            timeout: 180_000,
          },
          {
            command: `${SERVER} --port 8788 --serve demo/dist --test-endpoints --corrupt-hash --asset small=67108864`,
            url: 'http://127.0.0.1:8788/manifest.json',
            cwd: '../..',
            reuseExistingServer: false,
            timeout: 60_000,
          },
          {
            command: `${SERVER} --port 8789 --serve demo/dist --test-endpoints --ignore-range --asset small=67108864`,
            url: 'http://127.0.0.1:8789/manifest.json',
            cwd: '../..',
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ],
      }),
});
