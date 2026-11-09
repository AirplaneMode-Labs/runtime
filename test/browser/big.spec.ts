// The Sprint 1 "done when" at full scale: a 700 MB asset downloads in Chrome, survives a page
// refresh mid-download, and evicts cleanly when the origin quota is hit. Skipped unless RUNTIME_BIG=1.
//
// Start the server first (T1):
//   npm run demo:build
//   node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints \
//     --asset big=734003200 --asset a=734003200 --asset b=419430400 --asset c=524288000
// then:
//   RUNTIME_BIG=1 RUNTIME_BIG_OUT=<output dir> npm run test:browser
// Reports (wall time, MB/s, peak JS heap, resume request, evictions) land in RUNTIME_BIG_OUT.

import { test, expect } from 'playwright/test';
import { downloadAndVerify, quotaEviction, reloadResume, type Store } from './helpers';

// Quota proof per store:
//   [opfs]      CDP Storage.overrideQuotaForOrigin to 1.5 GiB, no quotaBytes injection: Chrome
//               itself throws QuotaExceededError and the manager evicts B reactively.
//   [indexeddb] quotaBytes injection (?quota=1610612736). Measured on Chrome for macOS, Nov 2026
//               (T1 t1-quota-indexeddb.json): with the same CDP override and 1,677,721,600 B of
//               IndexedDB Blob chunks stored, Storage.getUsageAndQuota reported indexeddb usage
//               1,053,040,640 B (about 63 %) and never threw QuotaExceededError;
//               navigator.storage.estimate().quota stayed at the 10 GiB profile default
//               (10,737,418,240 -> 11,790,458,880) so an estimate()-only manager would never have
//               seen pressure. The manager floors its usage figure by its own accounting
//               (usage = max(estimate().usage, accounted bytes), reported as usageSource on
//               asset.quota), and that accounting is exercised through quotaBytes with the outcome
//               asserted identically (asset.evict b reason quota, a and c verified, index exactly
//               a and c, no part). The report JSON records CDP usage vs
//               stored bytes and estimate().quota before and after. Real-quota IndexedDB eviction
//               is measured on the 8 GB Windows laptop (runtime README Limitations, FINDINGS.md).

const MiB = 1024 * 1024;
const BIG = 734003200; // 700 MiB
const A = 734003200;
const B = 419430400; // 400 MiB
const C = 524288000; // 500 MiB
const QUOTA = 1536 * MiB; // 1.5 GiB
const OUT = process.env['RUNTIME_BIG_OUT'];
// bytes/s while steering into the 38-42 % window: at 50 ms progress interval a sample is 8 MiB
// apart and the 28 MiB window holds about three samples.
const THROTTLE = 160 * MiB;

test.describe('700 MB proof', () => {
  test.skip(
    process.env['RUNTIME_BIG'] !== '1',
    'set RUNTIME_BIG=1 and start the range server with the big assets',
  );

  for (const store of ['opfs', 'indexeddb'] as const satisfies readonly Store[]) {
    test(`[${store}] downloads 700 MB and verifies against the independent digest`, async ({
      page,
      baseURL,
    }) => {
      if (!baseURL) throw new Error('baseURL missing');
      const report = await downloadAndVerify(page, baseURL, store, 'big', BIG, OUT);
      expect(report.mbPerSecond).toBeGreaterThan(0);
      console.log(
        `[${store}] big: ${report.wallMs} ms, ${report.mbPerSecond} MB/s, peak JS heap ${report.peakJsHeapBytes} B`,
      );
    });

    test(`[${store}] survives a reload at 38-42 % and resumes with one Range request`, async ({
      page,
      baseURL,
    }) => {
      if (!baseURL) throw new Error('baseURL missing');
      await reloadResume(
        page,
        baseURL,
        store,
        'big',
        BIG,
        { throttleBps: THROTTLE, expectResume: true },
        OUT,
      );
    });

    const mode = store === 'opfs' ? 'cdp' : 'quotaBytes';
    test(`[${store}] 1.5 GiB ${mode === 'cdp' ? 'CDP quota' : 'quotaBytes injection'}: 700 + 400, touch A, 500 evicts exactly B`, async ({
      page,
      baseURL,
    }) => {
      if (!baseURL) throw new Error('baseURL missing');
      await quotaEviction(
        page,
        baseURL,
        store,
        {
          a: { id: 'a', size: A },
          b: { id: 'b', size: B },
          c: { id: 'c', size: C },
          quotaBytes: QUOTA,
          mode,
        },
        OUT,
      );
    });
  }
});
