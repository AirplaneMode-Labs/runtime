// Asset manager browser proof at 64 MiB scale (the 700 MB version is big.spec.ts). Each test gets a
// fresh browser context, so a fresh OPFS / IndexedDB.

import { test, expect, type Page } from 'playwright/test';
import { RFC8032_SEED_HEX, signManifest } from '../tools/lib.mjs';
import {
  assertEgress,
  assertServerLogEgress,
  assetRequests,
  call,
  digest,
  downloadAndVerify,
  entryOf,
  events,
  expectCode,
  fetchManifest,
  files,
  isPartFile,
  list,
  named,
  openDemo,
  quotaEviction,
  reloadResume,
  resetLog,
  rowFor,
  serverLog,
  type Store,
} from './helpers';

const MiB = 1024 * 1024;
const SMALL = 64 * MiB;
const SIZES = { a: 64 * MiB, b: 48 * MiB, c: 64 * MiB };
// Quota arithmetic. OPFS (CDP Storage.overrideQuotaForOrigin): navigator.storage.estimate().quota
// ignores the override, so the manager's proactive makeRoom check never fires and the CDP proof
// relies only on the reactive QuotaExceededError path (Chrome throws on the append that crosses
// the limit, the manager evicts one LRU row and retries). The quota must therefore lie strictly
// between a + b and a + b + c including the one-chunk commit transient: a 64 + b 48 = 112 MiB fits,
// c pushes the origin to 176 MiB so Chrome throws during c's append, and a + c = 128 MiB (plus an
// 8 MiB chunk at commit) fits again. 160 MiB satisfies all three. IndexedDB (quotaBytes injection,
// manager's own accounting with the default 64 MiB headroom): 112 + 64 = 176 > 160 would evict too
// early, so that case uses its own value: a + b + headroom = 176 must fit, a + b + c + headroom =
// 240 must not, a + c + headroom = 192 must fit, hence 224 MiB. The 700 MB version uses 1.5 GiB.
const QUOTA_CDP = 160 * MiB;
const QUOTA_INJECTED = 224 * MiB;
const CORRUPT_BASE = 'http://127.0.0.1:8788';
const IGNORE_BASE = 'http://127.0.0.1:8789';
// bytes/s while steering into the 38-42 % reload window. The demo's manager emits progress every
// 50 ms, so at 16 MiB/s a sample is 0.8 MiB apart and the 2.56 MiB window holds about three samples.
const THROTTLE = 16 * MiB;
const BENCH_OUT = process.env['RUNTIME_BENCH_OUT'];

const must = (baseURL: string | undefined): string => {
  if (!baseURL) throw new Error('baseURL missing');
  return baseURL;
};

for (const store of ['opfs', 'indexeddb'] as const satisfies readonly Store[]) {
  test.describe(`store=${store}`, () => {
    test('downloads 64 MiB, verifies, and records the independent sha256', async ({
      page,
      baseURL,
    }) => {
      const report = await downloadAndVerify(page, must(baseURL), store, 'small', SMALL, BENCH_OUT);
      expect(report.sha256).toBe(digest('small', SMALL));
    });

    test('reload at 38-42 % then resume with exactly one Range request', async ({
      page,
      baseURL,
    }) => {
      await reloadResume(
        page,
        must(baseURL),
        store,
        'small',
        SMALL,
        { throttleBps: THROTTLE, expectResume: true },
        BENCH_OUT,
      );
    });

    // OPFS: the quota comes from Chrome itself (CDP Storage.overrideQuotaForOrigin) and only the
    // reactive QuotaExceededError path can evict. IndexedDB: the quotaBytes injection, because
    // Chrome under-reports IndexedDB usage and never throws for it; the manager floors usage by its
    // own accounting (index rows plus in-flight parts) so the injected quota fires; see
    // CHROME_IDB_QUOTA_NOTE in helpers.ts and test/browser/README.md.
    const mode = store === 'opfs' ? 'cdp' : 'quotaBytes';
    test(`${mode === 'cdp' ? 'CDP origin quota' : 'quotaBytes injection'}: a + b, touch a, then c evicts exactly b`, async ({
      page,
      baseURL,
    }) => {
      await quotaEviction(
        page,
        must(baseURL),
        store,
        {
          a: { id: 'a', size: SIZES.a },
          b: { id: 'b', size: SIZES.b },
          c: { id: 'c', size: SIZES.c },
          quotaBytes: mode === 'cdp' ? QUOTA_CDP : QUOTA_INJECTED,
          mode,
        },
        BENCH_OUT,
      );
    });
  });
}

test('corrupt manifest hash: hash_mismatch, no .bin, no row, getBlob not_verified', async ({
  page,
}) => {
  await openDemo(page, CORRUPT_BASE, 'opfs');
  const manifest = await fetchManifest(CORRUPT_BASE);
  const lie = entryOf(manifest, 'small').sha256;
  expect(lie).not.toBe(digest('small', SMALL));
  await call(page, 'loadManifest');
  await expectCode(page, 'ensure', 'hash_mismatch', 'small');

  const evs = await events(page);
  const failed = named(evs, 'asset.verify.failed');
  expect(failed.length).toBeGreaterThanOrEqual(1);
  expect(failed[0]?.attrs['reason']).toBe('hash_mismatch');
  expect(failed[0]?.attrs['entryId']).toBe('small');
  expect(named(evs, 'asset.verify.ok')).toEqual([]);

  expect(await rowFor(page, 'small')).toBeUndefined();
  expect(await call<boolean>(page, 'has', 'small')).toBe(false);
  const all = await files(page);
  expect(all.filter((f) => f.path.endsWith('.bin'))).toEqual([]);
  expect(all.filter((f) => f.path.includes(lie))).toEqual([]);
  await expectCode(page, 'getBlob', 'not_verified', 'small');
});

test('host that ignores Range: resume restarts from byte zero and still verifies', async ({
  page,
}) => {
  await reloadResume(page, IGNORE_BASE, 'opfs', 'small', SMALL, {
    throttleBps: THROTTLE,
    expectResume: false,
  });
});

test('truncated committed .bin: next getBlob rejects not_verified and the row is removed', async ({
  page,
  baseURL,
}) => {
  const base = must(baseURL);
  await openDemo(page, base, 'opfs');
  await call(page, 'loadManifest');
  await call(page, 'ensure', 'small');
  const row = await rowFor(page, 'small');
  expect(row).toBeDefined();
  if (!row) return;
  const newSize = await call<number>(page, 'truncateBin', row.sha256);
  expect(newSize).toBe(SMALL - 1);
  await expectCode(page, 'getBlob', 'not_verified', 'small');
  expect(await rowFor(page, 'small')).toBeUndefined();
  const evs = await events(page);
  const failed = named(evs, 'asset.verify.failed');
  expect(
    failed.some((e) => e.attrs['entryId'] === 'small' && e.attrs['reason'] === 'size_changed'),
  ).toBe(true);
});

test('egress: only demo files, /manifest.json and /assets/*; a foreign-origin entry is blocked before any request', async ({
  page,
  baseURL,
}) => {
  const base = must(baseURL);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await resetLog(base);

  await openDemo(page, base, 'opfs');
  await call(page, 'loadManifest');
  await call(page, 'ensure', 'hello-data');
  expect((await rowFor(page, 'hello-data'))?.sha256).toBe(digest('hello-data', 1 * MiB));

  // A signed manifest whose only entry points at another origin.
  const foreign: Record<string, unknown> = {
    spec: 'airplanemode.manifest/0.1',
    id: 'dev.airplanemode.range-server.foreign',
    version: '1.0.0',
    publisher: 'Airplane Mode Labs range test server',
    createdAt: '2026-11-09T00:00:00Z',
    entries: [
      {
        id: 'evil',
        kind: 'data',
        url: 'https://example.invalid/evil.bin',
        sha256: digest('evil', 16),
        size: 16,
        version: '1.0.0',
        licence: 'Apache-2.0',
        minProfile: {},
      },
    ],
    signatures: [],
  };
  // RFC 8032 test vector seed: public test data; the demo trusts it only because allowTestKeys is on.
  foreign['signatures'] = [signManifest(foreign, RFC8032_SEED_HEX, '2026-11-09T00:00:00Z')];

  await resetLog(base);
  const before = urls.length;
  await call(page, 'loadManifest', foreign);
  await expectCode(page, 'ensure', 'policy', 'evil');
  const blocked = named(await events(page), 'asset.download.blocked');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.attrs['entryId']).toBe('evil');
  expect(blocked[0]?.attrs['reason']).toBe('policy');
  expect(blocked[0]?.attrs['origin']).toBe('https://example.invalid');
  expect(assetRequests(await serverLog(base)), 'server log for the blocked entry').toEqual([]);
  expect(
    urls.slice(before).filter((u) => !u.startsWith(base)),
    'no request left the origin',
  ).toEqual([]);
  expect(urls.some((u) => u.includes('example.invalid'))).toBe(false);
  expect(await rowFor(page, 'evil')).toBeUndefined();
  expect((await list(page)).map((r) => r.entryId)).toEqual(['hello-data']);

  assertEgress(urls, base);
  assertServerLogEgress(await serverLog(base));
});

test('range server rejects foreign Host and hides test endpoints without the flag', async ({
  request,
}) => {
  // The honest server has test endpoints; a server started without the flag answers 404 (covered
  // in range-server.test.mjs). Here: the browser-facing contract on this origin.
  const r = await request.get('http://127.0.0.1:8787/__requests');
  expect(r.status()).toBe(200);
  const r2 = await request.get('http://127.0.0.1:8787/assets/small?x=1');
  expect(r2.status()).toBe(404);
});

export type { Page };
