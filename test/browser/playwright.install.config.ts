// Browser proof of the installed tarball (test/browser/install.spec.ts). No web server from here: the
// spec runs scripts/pack-check.mjs, installs the tarball offline into a fresh directory and serves
// that directory itself.
//
//   npm run test:install

import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['install.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: '../../test-results',
  use: { channel: 'chrome', headless: true },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
});
