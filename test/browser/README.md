# Browser proof (Playwright, Chrome channel)

The Sprint 1 "done when" for the asset manager, run against the synthetic range test server in
real Chrome: download, verify against an independent digest, resume after a mid-download reload,
reject corruption, evict for quota, and contact nothing but 127.0.0.1.

## Run

```sh
npm run test:browser                      # 64 MiB specs: asset.spec.ts + capability.spec.ts
RUNTIME_BENCH_OUT=/path/to/out npm run test:browser   # also write the report JSON files
```

`playwright.config.ts` builds `demo/dist` and starts three range servers (8787 honest with test
endpoints, 8788 `--corrupt-hash`, 8789 `--ignore-range`). Channel `chrome` uses the installed
Google Chrome; no browser download. CI runs the suite on Linux only after
`npx playwright install --with-deps chrome`.

The 700 MB version (`big.spec.ts`) runs only with `RUNTIME_BIG=1` against a server started by
hand; the exact commands are in the header of `big.spec.ts`.

## Demo test hooks

`demo/main.ts` exposes `window.__runtime` only on 127.0.0.1 / localhost. Query parameters:

| Parameter    | Effect                                                                                |
| ------------ | ------------------------------------------------------------------------------------- |
| `store`      | `opfs` (default) or `indexeddb`                                                       |
| `quota`      | `quotaBytes` test override passed to the `AssetManager` (quota source `quotaBytes`)   |
| `progressMs` | `progressIntervalMs` of the manager; the demo defaults to 50 ms (library default 250) |

The page shows the manager's quota source (`navigator.storage.estimate()` or `quotaBytes`), and
`__runtime.quotaSource()` returns `'estimate'` or `'quotaBytes'`.

## Resume window (reload at 38-42 %)

`helpers.ts reloadResume` throttles the download through CDP, polls the demo's progress record and
reloads inside the 38-42 % window. With the demo's 50 ms progress interval, 16 MiB/s on 64 MiB
(0.8 MiB per sample in a 2.56 MiB window) and 160 MiB/s on 700 MiB (8 MiB per sample in a 28 MiB
window) each give about three samples inside the window. Whole chunks may land between the last
sample and the reload, so the sidecar's `bytesWritten` is asserted to be at most one `chunkSize`
ahead of the last sample. After the reload exactly one `/assets/<id>` request is expected, with
`Range: bytes=<bytesWritten>-` and `If-Range` equal to the server's strong ETag.

## Quota proof: why OPFS and IndexedDB differ

Measured on Chrome for macOS (stable channel, Playwright 1.65, November 2026). Raw figures: the
`quota-<store>.json` reports written by `quotaEviction`, T1's `t1-quota-indexeddb.json`, and
`/private/tmp/airplanemode-team/D3/evidence/idb-usage-diag.log`.

- `Storage.overrideQuotaForOrigin` (CDP) is enforced for OPFS: writes past it throw
  `QuotaExceededError`, and `Storage.getUsageAndQuota` reports the override. The OPFS proof uses
  it with no `quotaBytes` injection, so Chrome itself is the quota authority. Because
  `estimate().quota` ignores the override, the manager's proactive `makeRoom` check never fires
  and the CDP proof relies only on the reactive `QuotaExceededError` path. The override must
  therefore sit strictly between a + b and a + b + c including the one-chunk commit transient:
  with a = 64, b = 48, c = 64 MiB the spec uses 160 MiB (112 fits, c crosses the limit at 176 so
  Chrome throws during c's append and the manager evicts b, a + c = 128 plus an 8 MiB chunk fits
  again). The IndexedDB case keeps 224 MiB because the manager's own accounting adds the 64 MiB
  headroom (112 + 64 must fit, 176 + 64 must not, 128 + 64 must fit).
- `navigator.storage.estimate().quota` ignores the override in both stores (10 GiB before and
  after), and on this machine it grows with usage (quota minus usage stays constant), so an
  `estimate()`-only manager never sees pressure from it.
- For IndexedDB Chrome under-reports usage: both `estimate().usage` and the CDP `indexeddb`
  breakdown report a constant 62.6 % of the Blob bytes stored (64 MiB stored -> 42,061,824 B;
  1,677,721,600 B stored -> 1,053,040,640 B), and the figure does not catch up over time. With a
  1.5 GiB override and 1.6 GB stored Chrome never threw `QuotaExceededError`, so the CDP scenario
  cannot evict on IndexedDB.
- The IndexedDB proof therefore passes `quota=<bytes>` to the demo so the manager's own quota
  accounting (`quotaBytes`) is exercised, and asserts the same outcome: `asset.evict` for b with
  reason `quota`, a and c verified, the index exactly a and c, no part file. The report still
  records CDP usage versus stored bytes and `estimate().quota` before and after so the gap stays
  visible, and for both stores it records `estimate().usage` next to the manager's accounted
  usage (`__runtime.accountedUsage()`: index row bytes plus in-flight part bytes) as
  `estimateUsageAfterAB` / `accountedUsageAfterAB` and `estimateUsageAfter` /
  `accountedUsageAfter`, with their ratio `estimateOverAccounted*` (1 for OPFS, about 0.63 for
  IndexedDB on this machine).
- Consequence for the manager (owned by D1): while `makeRoomLocked` takes `usage` from
  `estimate()` alone, the under-reported IndexedDB figure keeps `usage + bytes + headroom` below
  `quotaBytes` and the injected quota never fires either. Flooring usage by the manager's own
  accounting (sum of index row sizes plus in-flight part bytes) makes the `quotaBytes` proof
  honest and protects the real store from overshooting the browser's quota.

Real-quota IndexedDB eviction, disk-pressure behaviour and IndexedDB throughput for 700 MB are
measured on the 8 GB Windows laptop, not here (runtime README Limitations, FINDINGS.md).

## Egress

Every spec collects `page.on('request')` URLs and the server's `/__requests` log; both may contain
only the demo's own files (`/`, `/app/*`), `/manifest.json` and `/assets/*` on 127.0.0.1. A signed
manifest whose entry points at another origin is refused with `AssetError 'policy'` and
`asset.download.blocked` before any request leaves the page.
