# @airplanemode/runtime

Downloads, verifies, caches and evicts model and data assets in the browser, measures what the
device can run, runs a model on the best backend the device has (WebGPU, then WebAssembly, then,
if you opt in, the Chrome built-in model) and publishes the open contracts the rest of Airplane Mode
Labs is built on.

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the handles are
reserved; nothing is published yet.

Pre-alpha, `0.1.0-dev`, no release and no tag. Sprint 1 delivered the capability profile, the asset
manager and the first contracts; Sprint 2 adds the backend adapters (Transformers.js on WebGPU and
WebAssembly, the Chrome Prompt API), the descriptor and the fallback chain, with contracts 0.2.0 under
[`spec/`](spec/README.md). The WebLLM backend and the observability panel are later sprints; see
Limitations.

## Install

Not published yet. From a clone:

```sh
npm ci
npm run build          # dist/index.js, dist/backends/index.js, dist/spec/index.js and .d.ts files
```

Node 22 or newer is required for the tooling. The library itself targets Chrome (ES2022). Inference
engines load only from the `@airplanemode/runtime/backends` entry point; the main entry never imports
one. The Transformers.js engine, `@huggingface/transformers` 4.3.1 (Apache-2.0), is an **optional**
exact-version peer dependency, imported lazily by the adapter on first load: install it only if you use
the backends (`npm i @huggingface/transformers@4.3.1`).

That peer pulls `onnxruntime-node` and `protobufjs`, which have install scripts that the browser never
uses (`sharp` is prebuilt native code from the optional `@img/*` packages and has no install script).
In your own project install with `npm install --ignore-scripts`, or set `ignore-scripts=true` in your
`.npmrc` (this repository's `.npmrc` does). See row 8 of
[`docs/security/PRE-PILOT-CHECKLIST.md`](docs/security/PRE-PILOT-CHECKLIST.md).

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

### Run a model

```ts
import { AssetManager, detectCapabilities } from '@airplanemode/runtime';
import {
  createDefaultAdapters,
  loadWithFallback,
  BackendRefusedError,
} from '@airplanemode/runtime/backends';

const assets = new AssetManager({ store: 'auto' });
await assets.loadManifest('https://models.example.com/manifest.json', trust); // signed, trust set from your app
const adapters = createDefaultAdapters({
  ortFactoryUrl: new URL('./app/ort/ort-wasm-simd-threaded.asyncify.mjs', location.href).href,
});

try {
  const { adapter, rung } = await loadWithFallback({
    profile: await detectCapabilities(),
    assets,
    models: ['my-model.descriptor'], // descriptor entry ids, in preference order
    adapters,
    // cache-only unless you consent: asked again for every rung with that rung's own byte count
    beforeDownload: async ({ rung, bytes }) => confirm(`Download ${bytes} bytes for ${rung}?`),
  });
  const { text } = await adapter.generate('What is the capital of France? Answer in one word.', {
    maxTokens: 16,
    temperature: 0,
  });
} catch (e) {
  if (e instanceof BackendRefusedError) alert(e.userMessage); // plain language, names every rung that failed
}
```

A model is a signed manifest entry (the **descriptor**, at most 64 KiB) that names its weights,
tokenizer, config and WebAssembly runtime files; see [`spec/backend-adapter.md`](spec/backend-adapter.md)
and [`docs/model-choice.md`](docs/model-choice.md).

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
  `reconcile()` leaves a committed file without an index row alone while its `asset:<sha>` lock is held
  or it is younger than 60 s (S1-015).
- **Backends.** `loadWithFallback()` tries the `webgpu` rung (Transformers.js on WebGPU), then `wasm`
  (Transformers.js on WebAssembly), then `builtin` (the Chrome Prompt API, only with
  `allowBuiltin: true`), then refuses with a plain-language `BackendRefusedError`. The profile decides
  which rungs are skipped before anything is downloaded; `forceRung` starts lower and never moves up.
  Each attempt emits `backend.select`. On the WebGPU rung `available()` also creates a probe device
  and destroys it, so a GPU that exists but cannot create a device is skipped as `unavailable`
  before any session is created. If the engine fails after it began reading the weights, it cannot
  create another session in that page (a property of @huggingface/transformers): the next rung is
  recorded as `load_failed` without a download question and the refusal message adds "Reload the
  page and choose WebAssembly to try again."
- **Consent.** A file counts as already present only if its row is verified and the stored file has
  exactly the manifest size; anything else counts toward the rung's bytes. The refusal message says
  "Nothing was downloaded" only when no `asset.download.start` event was observed.
- **Descriptor and verified hand-off.** An engine adapter reads the descriptor entry (kind `model`, media
  type `application/vnd.airplanemode.model+json`, size cap checked before any download) with
  `getBlob(id, { rehash: true })`, validates it with the strict canonical parser and cross-checks every
  file against the manifest of that asset manager; every file is acquired (held until `unload()`) and
  read through a Blob verified after acquire. The engine's network function is replaced by a shim
  (`src/backends/verified-files.ts`) that serves exactly those Blobs by exact origin and path and refuses
  everything else; ONNX Runtime's wasm is handed over as bytes and pinned by SHA-256.
- **Held assets.** `acquire()` takes the refcount and a shared Web Lock `airplanemode-held:<sha>` inside
  the asset lock, so eviction and `reconcile()` in any tab skip a held model (S1-021).
- **Events.** Everything emits `airplanemode.event/0.1` records into an in-memory ring buffer with
  `subscribe()`; `newEvent()` enforces the attrs privacy rules in code.

## Contracts

This package is the home of the contracts, released together as spec release 0.2.0 (draft): Manifest
0.1.0, Capability profile 0.1.0, Event 0.1.1, Storage API 0.1.0, Backend adapter 0.2.0 and the Model
descriptor 0.1.0 that belongs to it, all under [`spec/`](spec/README.md) and exported from
`@airplanemode/runtime/spec`. Other repos vendor them and never edit their copies.

## Demo

Live demo: <https://airplanemode-labs.github.io/runtime/> (the backend page is
<https://airplanemode-labs.github.io/runtime/models.html>). Built from `main` by
`.github/workflows/pages.yml` on every push; each page shows only what works today and has a box titled
"What this demo does not do yet". They run entirely in the browser: no upload, no analytics, no
third-party scripts or fonts, and a strict meta CSP with no inline script or style. They are not yet
live: the owner pushes and enables Pages.

- `index.html` (asset manager): the capability profile; verification of a manifest signed at build time
  (a key pair generated inside the workflow signs a manifest describing three synthetic 12, 8 and 6 MiB
  streams, and only the public half is embedded in the page as the trust root); the RFC 8032 test-signed
  example refused and a tampered manifest refused; download with progress, a simulated network drop
  with resume, in-page SHA-256, eviction under a test quota; and a "paste your own manifest URL" field
  that fetches nothing unless the URL's origin is in the allowed origins list. The assets are synthetic
  byte streams, never a model.
- `models.html` (backend panel, its own CSP: `connect-src 'self'`): the detected capability tier, the plan
  of the fallback chain before any download, and a **Download test model and load** button. No request
  to `models/` is made before the click; after it, only same-origin requests. Ticking **Force WASM**
  skips WebGPU; **Allow Chrome built-in model** is off by default. A prompt box shows the answer, the
  rung, the execution providers, timings and bytes. WebAssembly generation runs on the main thread, so
  the page freezes while it generates and the demo keeps the answer short there (at most 24 tokens); if
  WebGPU fails after the engine started, the page says to reload and choose WebAssembly. The page text states the done-when and the model
  card: "Same prompt answered on WebGPU and on WebAssembly with the test model SmolLM2-135M-Instruct
  (q4), in Chrome on an Apple-silicon Mac only. This is not the Hindi production model; Windows and the
  8 GB no-GPU laptop are not measured." The Pages build bundles the Apache-2.0 test model with its
  licence texts and a provenance file (`DEMO_MODELS=1 npm run demo:build`); a build without it says
  "test model not bundled in this build".

## Benchmarks

Measured on 2026-11-09 by the test lane (T1) on an Apple-silicon development machine (18 cores)
with Google Chrome 157 via Playwright channel "chrome" against the repository range server on
127.0.0.1, using the repository commands

```sh
node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints --asset big=734003200
RUNTIME_BIG=1 RUNTIME_BIG_OUT=<dir> npx playwright test -c test/browser/playwright.config.ts big.spec.ts
node test/tools/asset-digest.mjs big 734003200     # the independent digest
```

Raw outputs, relative to the workspace folder that holds the repositories:
`evidence/sprint-1/T1/download-big-opfs.json`, `download-big-indexeddb.json`,
`resume-big-opfs.json`, `resume-big-indexeddb.json` and `asset-digest-big.txt`. The two quota rows
cite T1's retests, run with `npx playwright test -c specs/playwright.retest1.config.ts
specs/t1-retest1.spec.ts` (round 1, OPFS) and `npx playwright test -c
specs/playwright.retest2.config.ts specs/t1-retest2.spec.ts specs/t1-runtime-retest2.spec.ts`
(round 2, IndexedDB; the specs are kept in `evidence/sprint-1/T1/specs/`) against the same range
server started with `--asset a=734003200 --asset b=419430400 --asset c=524288000`: the OPFS row sets
the origin quota to 1.5 GiB through CDP `Storage.overrideQuotaForOrigin` (no `quotaBytes`
injection), the IndexedDB row injects `quotaBytes` of 1.5 GiB because Chrome ignores the CDP
override for that store. Raw output: `evidence/sprint-1/T1/retest1/t1-retest1-quota-opfs.json` and
`evidence/sprint-1/T1/retest2/t1-retest2-quota-indexeddb.json`. Every row is an **Apple-silicon
development machine, placeholder; 8 GB Windows no-GPU laptop not yet measured**.

The Sprint 2 rows come from this repository's own commands, run on 9 Nov 2026 on the same
Apple-silicon machine (18 cores, 32 GB) with Google Chrome through Playwright channel "chrome":

```sh
node test/tools/fetch-model.mjs smollm2-135m-instruct            # once, into the gitignored .cache/
RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 RUNTIME_MODEL_OUT=<dir> npm run test:model
node test/tools/fetch-model.mjs qwen3-1.7b-webgpu-q4f16          # once; 1.43 GB
RUNTIME_HINDI_SMOKE=1 RUNTIME_MODEL_OUT=<dir> npm run test:hindi-smoke
```

Raw outputs, relative to the workspace folder that holds the repositories:
`evidence/sprint-2/D1/model-run.json` and `evidence/sprint-2/D1/hindi-smoke.json` (the full request
lists, the ORT files requested per leg and the verbatim outputs are in them). The done-when
sentence these rows support: "Same prompt answered on WebGPU and on WebAssembly with the test model
SmolLM2-135M-Instruct (q4), in Chrome on an Apple-silicon Mac only. This is not the Hindi production
model; Windows and the 8 GB no-GPU laptop are not measured." Throughput varies from run to run (the
WebGPU leg measured 48.1 tokens/s in an earlier run on the same machine), so treat every figure as a
placeholder.

The peak JS heap figures are `JSHeapUsedSize` from Chrome's `Performance.getMetrics`. The JS heap
excludes WebAssembly linear memory, Blob backing stores and GPU memory, and Chrome exposes no
GPU-memory figure, so it understates what a model session needs; the renderer process RSS row below
is a coarse proxy that does include WebAssembly memory. It comes from T1's independent harness,
`node /…/T1/runtime-legs.mjs webgpu wasm` (evidence/sprint-2/T1/runtime-legs.mjs), which samples the
processes of the browser while the legs run; the data is in
evidence/sprint-2/T1/legs/rep1-webgpu.json to rep3-webgpu.json and evidence/sprint-2/T1/legs/rep1-wasm.json to rep3-wasm.json
(three repetitions were taken, the range below covers all of them).

| Scenario                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 700 MB (734003200 B) full download and SHA-256 verify, OPFS                                                                                                                          | 4060 ms, 180.8 MB/s, peak JS heap 2.79 MB; sha256 equals `node test/tools/asset-digest.mjs big 734003200`                                                                                                                                                                                                                                  |
| 700 MB full download and SHA-256 verify, IndexedDB                                                                                                                                   | 2561 ms, 286.6 MB/s, peak JS heap 2.80 MB; same sha256                                                                                                                                                                                                                                                                                     |
| 700 MB, OPFS: reload at 37.7 % (276824064 B written) then resume                                                                                                                     | exactly one `Range: bytes=276824064-` request with `If-Range` = strong ETag, 206, 457179136 B sent; wall time of the resume leg not measured                                                                                                                                                                                               |
| 700 MB, IndexedDB: reload at 38.9 % (285212672 B written) then resume                                                                                                                | exactly one `Range: bytes=285212672-` request, 206, 448790528 B sent; resume leg 2805 ms including the reload                                                                                                                                                                                                                              |
| `detectCapabilities()` wall time in Chrome                                                                                                                                           | under 2 s (test/browser/capability.spec.ts passes; exact figure not measured)                                                                                                                                                                                                                                                              |
| Quota eviction at a 1.5 GiB origin quota (CDP `Storage.overrideQuotaForOrigin`), OPFS                                                                                                | 9582 ms wall for 700 MB (a) + 400 MB (b), `getBlob(a)`, then 500 MB (c): exactly one `asset.evict` for b with reason `quota`, a and c verified, index exactly a and c, no `.part` left (t1-retest1-quota-opfs.json)                                                                                                                        |
| Quota eviction at a 1.5 GiB `quotaBytes`, IndexedDB                                                                                                                                  | 6252 ms wall for 700 MB (a) + 400 MB (b), `getBlob(a)`, then 500 MB (c): exactly one `asset.evict` for b with reason `quota`, `asset.quota` usage 1153433600 B with `usageSource` `accounted` (estimate 723398656 B, ratio 0.627), a and c verified, 1258291200 B left stored (t1-retest2-quota-indexeddb.json); Apple-silicon placeholder |
| Sprint 2 done-when: SmolLM2-135M-Instruct (q4), prompt "What is the capital of France? Answer in one word.", maxTokens 16, temperature 0, **WebGPU** path, Chrome (channel "chrome") | load 2667 ms including the verified download of 211,040,709 B (7 signed entries) over loopback; prefill 66 ms, decode 51 ms, 155.9 tokens/s; 8 tokens generated; peak JS heap 23,781,052 B; output "The capital of France is Paris." (`model-run.json`, key `webgpu`); one run, Apple-silicon placeholder                                  |
| the same, forced **WebAssembly** path (`forceRung: 'wasm'`, executionProviders `['wasm']`)                                                                                           | load 2592 ms (same download); prefill 368 ms, decode 732 ms, 10.9 tokens/s; peak JS heap 26,728,356 B; output "The capital of France is Paris." (`model-run.json`, key `wasm`); one thread, no COOP/COEP; Apple-silicon placeholder                                                                                                        |
| Local Hindi smoke run: Qwen3-1.7B q4f16 on WebGPU, five synthetic Hindi prompts, up to 128 new tokens, temperature 0, thinking off (`hindi-smoke.json`)                              | load 16887 ms including the verified download of 1,462,064,779 B; mean 28.2 tokens/s; peak JS heap 76,495,528 B; outputs recorded verbatim and **unscored**; only with `graphOptimizationLevel: 'disabled'` (the default level fails with `std::bad_alloc`); Apple-silicon placeholder                                                     |
| renderer process RSS peak (proxy, placeholder)                                                                                                                                       | SmolLM2-135M q4, same prompt: about 1.9 GiB on the WebGPU path and about 1.6 GiB on the WebAssembly path (renderer process); GPU process 0.35-0.42 GiB on the WebGPU path. Includes WebAssembly memory, not a GPU-memory figure; Apple-silicon placeholder (`rep1-webgpu.json` to `rep3-webgpu.json`, `rep1-wasm.json`)                    |
| 8 GB Windows no-GPU laptop (any of the above)                                                                                                                                        | not measured                                                                                                                                                                                                                                                                                                                               |

## Limitations

- **Inference is proven with the test model only.** The Sprint 2 result is SmolLM2-135M-Instruct (q4,
  English) answering one prompt on WebGPU and on WebAssembly, in Chrome on an Apple-silicon Mac only.
  It says nothing about Hindi quality. Windows and the 8 GB no-GPU laptop are not measured (the
  Benchmarks rows read "not measured").
- **No Hindi model is hosted or bundled.**
  Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.
  Loaded once in a browser: a local, unscored WebGPU smoke run of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation turned off (evidence/sprint-2/D1/hindi-smoke.json).
  The q8 WebAssembly path of that model was not run. See [`docs/model-choice.md`](docs/model-choice.md).
  The q4f16 session only builds with graphOptimizationLevel 'disabled' because the default fails with std::bad_alloc in the 4 GB wasm32 heap; createDefaultAdapters() cannot load the production model unless the application passes the sessionOptions option; the descriptor field for this is an architect decision for Sprint 3. The sessionOptions allow-list stays at that one key.
- The WebLLM backend is Sprint 3: there is no `@mlc-ai/web-llm` dependency, `engine: 'webllm'` and
  `modelLib` exist only in the descriptor schema.
- If the WebGPU engine fails after it has started creating a session (for example out of memory), WebAssembly cannot start in the same page until it is reloaded; per-rung engine isolation is planned for Sprint 3.
- On WebAssembly, generation runs on the main thread: the tab does not repaint or run timers until generation ends, and an AbortSignal fired from a timer or a button is honoured only between engine steps that yield; abort from onToken works. Moving the engine off the main thread is planned for Sprint 3.
- A model file that fails its hash check is reported as "could not be started", and the next rung downloads it again; a distinct integrity reason is planned with the Sprint 3 event minor.
- The chain checks cache-only consent before it asks the asset manager for a file (a file counts as
  present only if its row is verified and the stored file has exactly the manifest size) but
  `acquire()` itself still downloads a file that vanished in between; enforcing cache-only inside
  `acquire()` (`AcquireOptions.cacheOnly`) is a Sprint 3 backend-adapter minor (S1-053).
- No WebAssembly threads: GitHub Pages and a plain static server cannot send the COOP and COEP headers,
  so `crossOriginIsolated` is false and the engine runs on one thread with the proxy off (about 11
  tokens/s for the 135M test model). Header-only controls (`frame-ancestors`) are not available either.
- The Chrome built-in model (Prompt API) is opt-in (`allowBuiltin: true`), is Google's model, is not
  hash-verified (`model.load` carries `verified: false`) and is only used when `availability()` is
  already `available`; it was exercised with a fake `LanguageModel`, never against a real Gemini Nano
  install.
- The `model-wasm (ubuntu-latest)` CI job (cached fetch, then the WebAssembly leg behind the aborting
  gate) and the Windows CI legs first ran on GitHub on 9 Nov 2026, green ([run](https://github.com/AirplaneMode-Labs/runtime/actions/runs/42636261556)). CI never runs
  the WebGPU leg (hosted runners have no GPU adapter); the WebGPU leg was run locally and on the live
  demo, in Chrome on an Apple-silicon Mac.
- When a model's descriptor is not yet in the store, the consent byte count the chain passes to
  `beforeDownload` is an upper bound (every manifest entry not yet verified): the chain cannot read a
  descriptor it has not downloaded.
- A pass of `loadWithFallback` keeps the files it downloaded when a rung fails (they become evictable,
  not deleted), so a later rung can reuse them.
- The Sprint 2 browser proof downloads from the local range server; hosting the 182 MB test file on
  GitHub Pages (per-file and site limits, Range support) is unverified until the owner pushes and
  enables Pages.
- Chrome only this sprint. Firefox and Safari are not tested (OPFS `createWritable`, Web Locks and
  WebCrypto Ed25519 availability differ).
- The IndexedDB fallback keeps chunked Blobs; it exists for browsers or contexts without OPFS.
  Chrome under-reports IndexedDB usage in `navigator.storage.estimate()` (T1 measured 0.627 of the
  stored bytes) and did not throw `QuotaExceededError` for IndexedDB under a 1.5 GiB CDP override,
  so on that store the manager's own accounting (index rows plus in-flight parts, see Eviction) and a
  configured `quotaBytes` are the only pressure it sees; the real IndexedDB ceiling on the 8 GB
  Windows laptop is not measured.
- The IndexedDB store sizes a committed file from the stored chunk Blobs (`Blob.size`, no bytes read),
  not from its chunk metadata, so `getBlob()` without `rehash: true` detects a replaced or shortened
  chunk Blob (`not_verified`, the row is removed; S1-018). It still cannot detect a same-size
  corruption; `rehash: true`, which every engine adapter uses, re-hashes the bytes. IndexedDB Blobs
  are immutable once stored; an OPFS `File` snapshot becomes unreadable if the file is modified later.
- `navigator.storage.estimate().quota` does not reflect a per-origin quota override (such as CDP
  `Storage.overrideQuotaForOrigin`), so proactive eviction plans against the browser's estimate
  while the reactive `QuotaExceededError` path (evict one row, retry) is the real guard; the
  `asset.quota` event's `quota` attr is that estimate (or the `quotaBytes` override), not the
  enforced limit.
- `list()` and `has()` are async: they read the stored index rather than an in-memory copy.
- A commit that still fails after the chunk reservation and the evict-and-retry loop removes the
  downloaded part (nothing resumable is left); the next `ensure()` downloads again.
- No cross-tab download coordination beyond Web Locks: two tabs downloading the same asset
  serialise on the lock. A held asset (`acquire()`) takes its refcount and a shared Web Lock
  `airplanemode-held:<sha>` inside the asset lock and keeps both until `release()`, so eviction
  (`evict`, `evictToFit`, the quota path) and `reconcile()` in any tab skip it (S1-021). Without
  `navigator.locks` (Node, tests) the hold is per provider instance only.
- `reconcile()` leaves a committed file without an index row alone while its `asset:<sha>` lock or the
  held lock is taken, and while the store reports it younger than 60 s (OPFS `lastModified`,
  IndexedDB commit time), so a concurrent commit is not deleted as an orphan (S1-015); a real
  orphan is removed by the first reconcile after that. When the hold state cannot be read
  (`navigator.locks.query` is missing or throws) eviction and `reconcile()` treat every asset as held
  and emit one `asset.hold.unknown` warn event with `reason: lock_state_unavailable`, so such a browser
  never evicts another tab's model and never removes an unindexed file (S1-054); this event name is not
  in the 0.2.0 reserved list and joins it with the Sprint 3 event minor.
- A stored downgrade state that is not `{ version: valid SemVer, createdAt: calendar-valid }` is
  treated as an unreadable store: the manifest is refused with reason `state` (event reason
  `state_unavailable`) unless `allowDowngrade` is set (S1-031).
- No signature revocation, transparency log or Sigstore; a single valid signature from the trust set
  is sufficient. Recorded as accepted risks in `docs/security/FINDINGS.md`.
- Manifest and asset URLs must be final, non-redirecting URLs (`redirect: 'error'`).
- Hash midstate is not persisted; a resume re-hashes the stored part before continuing.
- Nothing has been measured on the 8 GB Windows laptop yet; Benchmarks reads "not measured".
- The demo's fixture manifest is signed by a key generated for that build only and carries no
  `expiresAt`; its bytes are synthetic streams. It proves the verification and download paths, not
  a publisher identity. Resume after an interrupted download is verified on the local range server and
  on GitHub Pages, which answered a `Range` request on the deployed fixture with 206 and
  `Accept-Ranges: bytes` on 9 Nov 2026 (a 200 would restart the download from zero, still hash-verified).

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
- Model bytes reach an engine only from files the asset manager fetched and SHA-256-verified against a
  signed manifest entry, read through `getBlob(id, { rehash: true })` after `acquire()` (backend adapter
  rules R1 to R3 in [`spec/backend-adapter.md`](spec/backend-adapter.md)). The engine's network function
  is replaced by a shim that serves only those Blobs and refuses everything else with
  `egress_refused` and a `backend.egress.refused` event carrying the origin only; the engine's remote
  host, every cache and the CDN `wasmPaths` default are overridden right after `import()` and re-checked
  before every `pipeline()` and `generate()`. The ONNX Runtime wasm is pinned by SHA-256
  (`src/backends/ort-pins.ts`, re-hashed by a test).
- Errors and events are built from codes and enums only; the engine's message and stack stay in
  `Error.cause` (R5). No event carries a prompt, an output or an engine message.
- Downloads are consented per rung: with no `beforeDownload` the chain is cache-only, and every rung asks
  again with its own byte count. The Chrome built-in model is off unless `allowBuiltin: true`.
- `fetch-model.mjs` (a test and CI tool) is https only, sends no `Authorization` header, never reads
  `HF_TOKEN`, refuses any file without a pinned sha256 outside `--pin`, confines writes to `--dest` and
  re-hashes every cached file on every run.
- The optional `@huggingface/transformers` peer pulls `onnxruntime-node` and `protobufjs`, which have
  install scripts that the browser never uses (`sharp` is prebuilt native code from the optional `@img/*`
  packages and has no install script). Install with `npm install --ignore-scripts` or set
  `ignore-scripts=true` in your `.npmrc`; row 8 of
  [`docs/security/PRE-PILOT-CHECKLIST.md`](docs/security/PRE-PILOT-CHECKLIST.md) covers the dependency
  review.
- See `SECURITY.md` for reporting and `docs/security/` for the threat model and findings.

## Develop

```sh
npm ci                 # install scripts are disabled (.npmrc ignore-scripts=true)
npm run ci             # fmt:check, typecheck, vitest, build
npm run test           # Vitest only
npm run test:browser   # Playwright on the installed Chrome (channel "chrome"); no browser download
node test/tools/fetch-model.mjs smollm2-135m-instruct          # the test model into .cache/ (gitignored)
RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 npm run test:model     # same prompt on WebGPU and forced WASM
RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model      # the WebAssembly leg only (what CI runs)
RUNTIME_HINDI_SMOKE=1 npm run test:hindi-smoke                  # local only: Qwen3-1.7B, 1.43 GB
npm run spec:vectors   # regenerate spec/vectors from test/tools/make-vectors.mjs
npm run spec:sign-example
npm run deps:scripts   # which packages carry install scripts (none are run)
node test/tools/gen-ort-pins.mjs --check   # src/backends/ort-pins.ts against node_modules/onnxruntime-web
npm run demo:build     # demo/dist: generates and signs the fixture, then vite build
DEMO_MODELS=1 npm run demo:build           # also bundles the test model (what pages.yml runs)
node demo/tools/make-fixture.mjs                      # fixture only: demo/public/fixture (git-ignored)
node test/tools/asset-digest.mjs hello-data 1048576   # sha256 of a synthetic asset
node test/tools/dist-url-inventory.mjs demo/dist      # every library URL string in a build, attributed
```

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci` from the committed lockfile needs no flag. We revisit this when vitest's peer range is updated.

CI runs the same `npm run ci` on Ubuntu, macOS and Windows; browser tests run on Linux with the
Google Chrome preinstalled on ubuntu-latest (Playwright channel "chrome"; the job logs
`google-chrome --version` and fails when Chrome is missing, and no Chrome is installed from a
package repository). This first ran on GitHub on 9 Nov 2026. A separate, non-required job
`model-wasm (ubuntu-latest)` fetches the test model (cached, every file re-hashed) and runs the
WebAssembly leg of `test:model` behind the aborting network gate; it first ran on GitHub on 9 Nov
2026, green. A Hugging Face outage never turns `check (<os>)` red. New npm dependencies must have been
published at least 14 days before they are installed (younger transitives are pinned through
`overrides`), come from registry.npmjs.org with sha512 integrity, and pass `npm audit signatures`.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`. The open contracts in `spec/` are Apache-2.0 as well and
never move behind the control-plane licence. The hosted demo redistributes ONNX Runtime Web (MIT), the
@huggingface/transformers engine (Apache-2.0) and, in the Pages build, the Apache-2.0 SmolLM2-135M-Instruct
test model; their notices are in `demo/THIRD-PARTY-NOTICES.txt`.
