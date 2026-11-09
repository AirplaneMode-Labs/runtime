# @airplanemode/runtime

Downloads, verifies, caches and evicts model and data assets in the browser, measures what the
device can run, and publishes the five open contracts the rest of Airplane Mode Labs is built on.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

## Status

Pre-alpha, `0.1.0-dev`, no release and no tag. Sprint 1 (9 to 22 Nov 2026) delivers the capability
profile, the asset manager (download, resume, cache, evict) and the five contracts under
[`spec/`](spec/README.md). The backend adapters, the WebGPU to WASM fallback chain and the
observability panel are later sprints; see Limitations.

## Install

Not published yet. From a clone:

```sh
npm ci
npm run build          # dist/index.js, dist/spec/index.js and .d.ts files
```

Node 22 or newer is required for the tooling. The library itself targets Chrome (ES2022).

## Quick start

```ts
import { AssetManager, detectCapabilities, satisfies } from '@airplanemode/runtime';

// 1. What can this device run? Never reads navigator.userAgent.
const profile = await detectCapabilities();

// 2. Trust roots are app configuration (keyId -> raw 32-byte Ed25519 public key).
//    They are never fetched with the manifest.
const trust = new Map<string, Uint8Array>([[MY_KEY_ID, MY_PUBLIC_KEY]]);

// 3. Load and verify a signed manifest; assets may only come from its origin.
const assets = new AssetManager({ store: 'auto' });
const manifest = await assets.loadManifest('https://models.example.com/manifest.json', trust);

// 4. Download (resumable, hashed, cached) and use a verified file.
const entry = manifest.entries[0];
if (satisfies(profile, entry.minProfile)) {
  await assets.ensure(entry.id, {
    onProgress: ({ received, total }) => console.log(`${received}/${total}`),
  });
  const blob = await assets.getBlob(entry.id); // rejects not_verified unless hashed and committed
}

// list(), has(), evict(), pin() and reconcile() are all async (they read the stored index).
for (const row of await assets.list()) console.log(row.entryId, row.verifiedAt, row.refcount);

assets.events.subscribe((e) => console.debug(e.name, e.attrs)); // local ring buffer, never sent
```

## How it works

- **Manifest verification.** `parseManifest` rejects floats, integers above 2^53-1, digit-leading
  keys and lone surrogates, validates against `spec/manifest.schema.json` (including calendar-valid
  timestamps), and checks entry order and uniqueness. `verifyManifest` re-runs those checks on its
  input, canonicalises the body (restricted RFC 8785 profile), prepends `airplanemode-manifest-v1\n`
  and checks Ed25519 signatures with WebCrypto against the trust set, then applies the expiry and
  SemVer downgrade rules. Malformed input or signature material is a rejection with a reason, never
  an exception; an unreadable downgrade-state store fails closed (reason `state`). Signatures with
  an unknown `alg` are ignored. `loadManifest(url)` streams the body with a hard 4 MiB cap
  (`AssetError 'network'`, reason `oversize`) and accepts an `AbortSignal`.
- **Download.** Each entry is fetched with `credentials: 'omit'`, `cache: 'no-store'`,
  `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, `mode: 'cors'`, only from the manifest's
  origin (or `allowedOrigins`), and only to `https://` or loopback `http://` URLs. A partial download
  lives as a `<sha>.part` chunk directory plus `<sha>.part.json`; a resume sends one `Range` request
  from `bytesWritten` with `If-Range` when the server gave a strong validator, and restarts from
  zero on a 200, a mismatching `Content-Range`, or a part whose state file is malformed (every
  field is validated before it is trusted) or no longer matches the entry. A part that is already
  complete is verified and committed without any request. Responses are validated (`Content-Range`
  start and total, `Content-Length`, hard oversize cap).
- **Verify before use.** Bytes are hashed while they stream; a resume re-hashes the stored part
  first. Only when the full SHA-256 matches the entry is the part committed to `<sha>.bin` and an
  index row with `verifiedAt` written, in that order; the committed file's size is checked against
  the entry before the row is written. `getBlob` requires that row, checks the stored size, and can
  re-hash on demand. No partial file is ever exposed.
- **Stores.** OPFS (`airplanemode-runtime/v1/`), IndexedDB (`airplanemode-runtime` database,
  chunked Blobs) or memory (tests). Chunk files avoid Chrome's whole-file copy on
  `createWritable({ keepExistingData: true })`, which would make appending to a 700 MB file quadratic.
  The OPFS commit streams the chunks into `<sha>.bin` and removes each chunk as soon as it is in the
  swap file, so a commit needs one chunk of transient space, not a second copy of the asset.
- **Eviction.** Quota comes from `navigator.storage.estimate()` (or `quotaBytes` in tests) with 64 MiB
  headroom. Usage is never the browser's estimate alone: the manager takes the larger of
  `estimate().usage` and the bytes it accounts for itself (every index row's size plus the bytes
  already written to every partial download), because Chrome reports only about 0.627 of the stored
  IndexedDB Blob bytes (T1 measurement). The `asset.quota` event carries that `usage`, the `quota` it
  planned against (the estimate or the `quotaBytes` override) and `usageSource` (`estimate` or
  `accounted`). Least-recently-used rows go first; pinned rows, rows held through `acquire()` and the
  asset being downloaded are never evicted. Before a commit the manager reserves the store's declared
  transient (`commitReserve`: one chunk for OPFS, zero for IndexedDB and memory). A
  `QuotaExceededError` while appending or committing evicts one row and retries up to three times;
  if a commit still fails the half-written file and the part are removed (no orphan, no stuck
  complete part) and `ensure()` rejects with `AssetError 'quota'`. Every store write maps the
  platform quota error to `quota` and any other failure to `store`. The row is removed before the
  file so the index never points at a missing file. `evict(entryId)` refuses an asset that is held
  through `acquire()` or whose download is in flight (`AssetError 'store'`, "asset is held or
  downloading") unless called with `{ force: true }`.
- **Locks.** `ensure()` for one sha and every index read-modify-write run inside
  `navigator.locks` (`airplanemode-runtime:<name>`) or an in-process lock when Web Locks are absent.
- **Events.** Everything emits `airplanemode.event/0.1` records into an in-memory ring buffer with
  `subscribe()`; `newEvent()` enforces the attrs privacy rules in code.

## Contracts

This package is the home of the contracts: Manifest 0.1.0, Capability profile 0.1.0, Event 0.1.0,
Storage API 0.1.0 and Backend adapter 0.1.0, all under [`spec/`](spec/README.md) and exported from
`@airplanemode/runtime/spec`. Other repos vendor them and never edit their copies.

## Benchmarks

Measured on 2026-11-09 by the test lane (T1) on an Apple-silicon development machine (18 cores)
with Google Chrome 157 via Playwright channel "chrome" against the repository range server on
127.0.0.1, using the repository command

```sh
node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints --asset big=734003200
RUNTIME_BIG=1 RUNTIME_BIG_OUT=<dir> npx playwright test -c test/browser/playwright.config.ts big.spec.ts
```

Raw outputs: `/private/tmp/airplanemode-team/T1/download-big-opfs.json`,
`download-big-indexeddb.json`, `resume-big-opfs.json`, `resume-big-indexeddb.json` and
`asset-digest-big.txt` (the independent digest). The quota row cites T1's round-1 retest, run with
`npx playwright test -c specs/playwright.retest1.config.ts specs/t1-retest1.spec.ts` from
`/private/tmp/airplanemode-team/T1/` against the same range server with
`--asset a=734003200 --asset b=419430400 --asset c=524288000` and the origin quota set to 1.5 GiB
through CDP `Storage.overrideQuotaForOrigin` (no `quotaBytes` injection); raw output
`/private/tmp/airplanemode-team/T1/retest1/t1-retest1-quota-opfs.json`. Every row is an
**Apple-silicon development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured**.

| Scenario                                                                              | Result                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 700 MB (734003200 B) full download and SHA-256 verify, OPFS                           | 4060 ms, 180.8 MB/s, peak JS heap 2.79 MB; sha256 equals `node test/tools/asset-digest.mjs big 734003200`                                                                                                           |
| 700 MB full download and SHA-256 verify, IndexedDB                                    | 2561 ms, 286.6 MB/s, peak JS heap 2.80 MB; same sha256                                                                                                                                                              |
| 700 MB, OPFS: reload at 37.7 % (276824064 B written) then resume                      | exactly one `Range: bytes=276824064-` request with `If-Range` = strong ETag, 206, 457179136 B sent; wall time of the resume leg not measured                                                                        |
| 700 MB, IndexedDB: reload at 38.9 % (285212672 B written) then resume                 | exactly one `Range: bytes=285212672-` request, 206, 448790528 B sent; resume leg 2805 ms including the reload                                                                                                       |
| `detectCapabilities()` wall time in Chrome                                            | under 2 s (test/browser/capability.spec.ts passes; exact figure not measured)                                                                                                                                       |
| Quota eviction at a 1.5 GiB origin quota (CDP `Storage.overrideQuotaForOrigin`), OPFS | 9582 ms wall for 700 MB (a) + 400 MB (b), `getBlob(a)`, then 500 MB (c): exactly one `asset.evict` for b with reason `quota`, a and c verified, index exactly a and c, no `.part` left (t1-retest1-quota-opfs.json) |
| Quota eviction at a 1.5 GiB quota, IndexedDB                                          | not measured (T1 retests after the T1R-01 usage-accounting fix in this round)                                                                                                                                       |
| 8 GB Windows no-GPU laptop (any of the above)                                         | not measured                                                                                                                                                                                                        |

## Limitations

- Chrome only this sprint. Firefox and Safari are not tested (OPFS `createWritable`, Web Locks and
  WebCrypto Ed25519 availability differ).
- The IndexedDB fallback keeps chunked Blobs; it exists for browsers or contexts without OPFS.
  Chrome under-reports IndexedDB usage in `navigator.storage.estimate()` (T1 measured 0.627 of the
  stored bytes) and did not throw `QuotaExceededError` for IndexedDB under a 1.5 GiB CDP override,
  so on that store the manager's own accounting (index rows plus in-flight parts, see Eviction) and a
  configured `quotaBytes` are the only pressure it sees; the real IndexedDB ceiling on the 8 GB
  Windows laptop is not measured.
- With the IndexedDB store, `getBlob()` without `rehash: true` does not detect a replaced or
  shortened chunk Blob, because the stored size is the sum of the chunk metadata rather than the
  Blob bytes; pass `rehash: true` or use the OPFS store until Sprint 2 (S1-018).
- `navigator.storage.estimate().quota` does not reflect a per-origin quota override (such as CDP
  `Storage.overrideQuotaForOrigin`), so proactive eviction plans against the browser's estimate
  while the reactive `QuotaExceededError` path (evict one row, retry) is the real guard; the
  `asset.quota` event's `quota` attr is that estimate (or the `quotaBytes` override), not the
  enforced limit.
- `list()` and `has()` are async: they read the stored index rather than an in-memory copy.
- A commit that still fails after the chunk reservation and the evict-and-retry loop removes the
  downloaded part (nothing resumable is left); the next `ensure()` downloads again.
- No cross-tab download coordination beyond Web Locks: two tabs downloading the same asset
  serialise on the lock; refcounts (`acquire()`) are per tab, so another tab may evict an asset this
  tab holds.
- No signature revocation, transparency log or Sigstore; a single valid signature from the trust set
  is sufficient. Recorded as accepted risks in `docs/security/FINDINGS.md`.
- Manifest and asset URLs must be final, non-redirecting URLs (`redirect: 'error'`).
- Hash midstate is not persisted; a resume re-hashes the stored part before continuing.
- Nothing has been measured on the 8 GB Windows laptop yet; Benchmarks reads "not measured".
- Real backend adapters (WebLLM, Transformers.js, Chrome Prompt API) are Sprint 2; only the
  interface and a `MockAdapter` ship now.

## Security and privacy

This library makes no network requests other than the asset and manifest URLs you pass it, and sends no telemetry.

- What is stored where: verified files as `<sha>.bin`, partial downloads as `<sha>.part/` and
  `<sha>.part.json`, and `index.json` (entry ids, hashes, sizes, timestamps, pins, last accepted
  manifest version per id), all under the origin's OPFS directory `airplanemode-runtime/v1/` or the
  IndexedDB database `airplanemode-runtime`. Nothing leaves the origin.
- `navigator.storage.persist()` is requested once, best effort. Without persistent storage Chrome
  may evict the whole origin under disk pressure, so a 700 MB cache can vanish; `reconcile()`
  survives it by rebuilding an empty index.
- Trust roots are application configuration and are never fetched with the manifest. The RFC 8032
  test key is refused unless `allowTestKeys` is set.
- Capability details are allow-listed (vendor, architecture, numeric limits); `navigator.userAgent`
  and `userAgentData` are never read.
- Events never carry URLs with query strings, document text, prompts or user identifiers;
  `newEvent()` enforces this and `test/no-egress.test.ts` greps `src/` for network APIs.
- See `SECURITY.md` for reporting and `docs/security/` for the threat model and findings.

## Develop

```sh
npm ci                 # install scripts are disabled (.npmrc ignore-scripts=true)
npm run ci             # fmt:check, typecheck, vitest, build
npm run test           # Vitest only
npm run test:browser   # Playwright on the installed Chrome (channel "chrome"); no browser download
npm run spec:vectors   # regenerate spec/vectors from test/tools/make-vectors.mjs
npm run spec:sign-example
npm run deps:scripts   # which packages carry install scripts (none are run)
node test/tools/asset-digest.mjs hello-data 1048576   # sha256 of a synthetic asset
```

CI runs the same `npm run ci` on Ubuntu, macOS and Windows; browser tests run on Linux after
`npx playwright install --with-deps chrome`.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`. The open contracts in `spec/` are Apache-2.0 as well and
never move behind the control-plane licence.
