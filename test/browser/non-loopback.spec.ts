// Sprint 7, D1-07 (R3, R4; S1 condition): on a published (non-loopback) origin the demo cannot be told to trust the RFC 8032
// test key. The demo is built exactly as pages.yml builds it and served under /runtime/ (test/browser/subpath-server.mjs), and
// Chrome is pointed at it through a host name that is NOT loopback (--host-resolver-rules maps runtime-demo.example to
// 127.0.0.1, and the secure-context override is needed only because that name is plain http; it changes nothing the page's own
// isLocal check reads: location.hostname). It shows that:
//   - ?manifest=range is ignored (the range note shows, the source stays the bundled fixture),
//   - the test hooks (window.__runtime) are absent,
//   - the bundled fixture still verifies (so a refusal below is the flag's doing, not a broken page),
//   - with the 'add the RFC 8032 test key' box ticked the manifest is refused with test_key_refused,
//   - allowTestKeys-looking URL parameters change nothing,
//   - no request leaves the origin.
//
//   npm run test:demo -- non-loopback.spec.ts

import { chromium, expect, test } from 'playwright/test';

const HOST = 'runtime-demo.example';
const ORIGIN = `http://${HOST}:8791`;
const BASE = `${ORIGIN}/runtime/index.html`;

test('a non-loopback origin ignores ?manifest=range and refuses the test key (R3)', async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: [
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
    ],
  });
  try {
    for (const query of [
      '?manifest=range',
      '?manifest=range&allowTestKeys=true',
      '?allowTestKeys=1&range=1&trust=test',
    ]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const foreign: string[] = [];
      const errors: string[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.origin !== ORIGIN && u.protocol !== 'data:' && u.protocol !== 'blob:')
          foreign.push(r.url());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}${query}`);
      expect(new URL(page.url()).hostname, query).toBe(HOST);

      // not loopback: the range mode is off and the page says so when it was asked for
      await expect(page.locator('#source-label')).toContainText('bundled fixture', {
        timeout: 30_000,
      });
      if (query.includes('manifest=range'))
        await expect(page.locator('#range-note')).not.toHaveClass(/hidden/);
      expect(await page.evaluate(() => '__runtime' in window), `${query}: test hooks`).toBe(false);

      // the fixture verifies: the page works on this origin
      await page.locator('#btn-load').click();
      await expect(page.locator('#out-manifest')).toContainText('"ok": true', { timeout: 60_000 });

      // with the published test key added to the trust set, the manifest is refused before anything is parsed
      await page.locator('#chk-testkey').check();
      await page.locator('#btn-load').click();
      await expect(page.locator('#out-manifest')).toContainText('test_key_refused', {
        timeout: 60_000,
      });
      await expect(page.locator('#out-manifest')).not.toContainText('"ok": true');

      expect(foreign, `${query}: requests that left the origin`).toEqual([]);
      expect(errors, `${query}: page errors`).toEqual([]);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
