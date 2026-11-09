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
Google Chrome; no browser download. CI runs the suite on Linux only, with the Google Chrome
preinstalled on ubuntu-latest (the job logs `google-chrome --version` and fails if it is missing);
configured, not yet executed.

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
`evidence/sprint-1/D3/evidence/idb-usage-diag.log` in the workspace folder.

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
- Consequence for the manager (owned by D1): quota decisions never take `usage` from `estimate()`
  alone. `usage = max(estimate().usage, accounted bytes)`, where the accounted bytes are the sum of
  the index row sizes plus the bytes already written to in-flight parts, and the `asset.quota` event
  names the source of the figure in `usageSource` (`estimate` or `accounted`). Without that floor the
  under-reported IndexedDB figure would keep `usage + bytes + headroom` below `quotaBytes` and the
  injected quota would never fire; with it the `quotaBytes` proof is honest and the real store is
  protected from overshooting the browser's quota. `quota` itself stays the browser's estimate (or
  the `quotaBytes` override), not the enforced limit.

Real-quota IndexedDB eviction, disk-pressure behaviour and IndexedDB throughput for 700 MB are
measured on the 8 GB Windows laptop, not here (runtime README Limitations, FINDINGS.md).

## Egress

Every spec collects `page.on('request')` URLs and the server's `/__requests` log; both may contain
only the demo's own files (`/`, `/app/*`), `/manifest.json` and `/assets/*` on 127.0.0.1. A signed
manifest whose entry points at another origin is refused with `AssetError 'policy'` and
`asset.download.blocked` before any request leaves the page.

## Model proof (`model.spec.ts`, `npm run test:model`)

The Sprint 2 done-when in real Chrome: the same prompt, "What is the capital of France? Answer in one
word." (`maxTokens` 16, `temperature` 0), answered with SmolLM2-135M-Instruct (q4) on the WebGPU path and
on a forced WebAssembly path, behind an aborting network gate.

```sh
node test/tools/fetch-model.mjs smollm2-135m-instruct       # once; the cache .cache/models is gitignored
RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 RUNTIME_MODEL_OUT=<dir> npm run test:model
RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model   # the WebAssembly leg only (CI)
```

`playwright.model.config.ts` builds the demo, signs `dev.airplanemode.test-models` 0.1.0 with the public
RFC 8032 test key into `.cache/models/test-models/` (`model-fixture.mjs`; every size and sha256 is
recomputed and must equal `test/tools/models.json` and `src/backends/ort-pins.ts` before signing) and
starts the range server on 127.0.0.1:8790 with its `/models/` route: real files under
`realpath(.cache/models)`, regular files only, no symlink anywhere on the path, GET and HEAD only,
Range and If-Range supported (`range-server.test.mjs` covers traversal, symlinks and POST).

The page under test is `models.html?models=test`; its loopback-only hook `window.__models` (absent on
any non-loopback host) loads the manifest the range server serves and calls `loadWithFallback()`.

The gate: `page.route('**/*')` aborts every request whose origin is not the page origin and records it;
`context.on('request')` records every request; a `securitypolicyviolation` listener records CSP
violations; the test fails on any aborted request, any violation, any worker (the engine runs on one
thread with the proxy off) and any request to Hugging Face, a CDN, GitHub or a Google host. Only
`GET` requests for the manifest and its entries may touch `/models/`. Leg A requires the `webgpu` rung
with `executionProviders` including `webgpu` (`RUNTIME_REQUIRE_WEBGPU=1` turns a missing adapter from a
skip into a failure), leg B `forceRung: 'wasm'` with `['wasm']`; both must emit `asset.verify.ok` for
all seven entries and `backend.egress.refused` zero times. Extra tests: an injected probe to
`https://huggingface.co/x` is refused with `egress_refused` and an event whose attrs are exactly
`{adapter, origin: 'https://huggingface.co'}`; with `navigator.gpu` undefined the chain selects the wasm
rung; with Chrome started with `--js-flags=--jitless` (which hides `WebAssembly`) and no `navigator.gpu`
the refusal message names WebGPU, WebAssembly and the Chrome built-in model in plain text.
Fix round 1 adds three real-engine tests under the same gate. T1-S2-01: an init script makes
`GPUAdapter.prototype.requestDevice` reject, so the adapter's own probe fails and the default chain
records the WebGPU rung as `unavailable` and answers on wasm; and an init script that rejects only a
`requestDevice()` called with a descriptor (the probe passes, ONNX Runtime's own call fails, which is a
failure after session creation started), after which the chain refuses with the "Reload the page and
choose WebAssembly to try again." sentence, the Force WASM retry in the same page refuses with it too,
and a fresh page with `forceRung: 'wasm'` answers. T1-S2-02: the hook aborts from inside `onToken` on
the wasm rung (`abortAfterTokens`), asserts `finishReason: 'abort'` within a few tokens and that a
second generate works.
`model-run.json` (in `RUNTIME_MODEL_OUT`, default `test-results/`) records load, prefill and decode
milliseconds, tokens per second, bytes downloaded, the peak `JSHeapUsedSize`, both outputs verbatim, the
full request list and the ORT files requested per leg.

`hindi-smoke.spec.ts` (`RUNTIME_HINDI_SMOKE=1 npm run test:hindi-smoke`) is local only, never CI or
Pages: it loads Qwen3-1.7B q4f16 (1.43 GB, fetched with `node test/tools/fetch-model.mjs
qwen3-1.7b-webgpu-q4f16`) through the default chain on WebGPU and records five synthetic Hindi prompts
and their verbatim, unscored outputs to `hindi-smoke.json`.
