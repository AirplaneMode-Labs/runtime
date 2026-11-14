# Backend adapter 0.3.1 (with model descriptor 0.2.1)

Normative definition: `backend-adapter.ts` and, for the descriptor, `model-descriptor.ts` and
`model-descriptor.schema.json`. One interface over Transformers.js (ONNX Runtime Web), WebLLM and the
Chrome Prompt API, so the fallback chain WebGPU -> WASM -> Chrome built-in can pick a backend without
the application changing. `backend-adapter.ts` imports nothing from `model-descriptor.ts`; the two are
released together and versioned separately.

0.3.1 (spec release 0.4.0, draft) is a patch over 0.3.0: no type changes. R13 is amended: a worker-reported
egress refusal is recorded per Event 0.1.3 (reporter 'worker', origin 'worker-reported', a count) and the
host never forwards worker text (S1-074). Model descriptor 0.2.1 pins branch C (webllm) to the 0.2 wire
string and fixes the reason precedence (see `model-descriptor.ts`). Informative: the WebLLM rung was cut
from Sprint 4 by team decision TD-08 (not half-landed); R11 stays specified and unimplemented in this
repository.

0.3.0 (spec release 0.3.0, draft) adds, over 0.2.0: `AcquireOptions.cacheOnly` and
`LoadOptions.cacheOnly`, the error codes `integrity` and `not_cached`, `GenerateResult.timings.firstTokenMs`
and `BackendAdapter.host`; rules R2w and R3w (an engine in a worker) and R7 to R13 (isolation, abort and
crash, chain integrity, chain cacheOnly, WebLLM staging, observability, untrusted worker messages).
R1 to R6 still apply. Model descriptor 0.2.0 adds `sessionOptions` and fixes the webllm branch (see
`model-descriptor.ts`).

## Shape

```ts
type ExecutionDevice = 'webgpu' | 'wasm' | 'builtin';

interface BackendAdapter {
  readonly id: 'webllm' | 'transformers-js' | 'chrome-prompt-api' | (string & {});
  readonly tier: BackendTier; // the minimum tier the adapter needs
  readonly device: ExecutionDevice;
  readonly host?: 'main' | 'worker'; // where the engine runs; absent for adapters without an engine
  capabilities(): { generate: boolean; embed: boolean; streaming: boolean };
  available(profile: CapabilityProfile): Promise<boolean>; // cheap: no download, no model creation
  load(entry: ManifestEntry, opts: LoadOptions): Promise<void>; // entry = the descriptor's entry
  generate(prompt: string | ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<EmbedResult>;
  unload(): Promise<void>;
}

interface LoadOptions {
  assets: AssetSource;
  profile: CapabilityProfile;
  signal?: AbortSignal;
  events?: EventSink;
  onProgress?: (p: { entryId: string; received: number; total: number }) => void;
  cacheOnly?: boolean; // passed to every acquire() the adapter makes
}

interface AcquireOptions {
  signal?: AbortSignal;
  onProgress?: (p: { entryId: string; received: number; total: number }) => void;
  cacheOnly?: boolean; // resolve only for a file that is already stored in full (see below)
}

interface AssetSource {
  getBlob(entryId: string, opts?: { rehash?: boolean }): Promise<Blob>;
  getUrl?(entryId: string): Promise<string>;
  getEntry(entryId: string): ManifestEntry;
  acquire?(entryId: string, opts?: AcquireOptions): Promise<AssetHandle>; // may download
}
```

`tier` is the minimum `BackendTier` the adapter itself needs: Transformers.js on WebGPU
`webgpu-f32` (a descriptor may demand `webgpu-f16` through its `minProfile`), Transformers.js on
WASM `wasm`, WebLLM (device `webgpu`) `webgpu-f32` (a q4f16 entry carries `minProfile.backendTier`
`webgpu-f16`), `chrome-prompt-api` `none`.

`AdapterErrorCode` = `not_loaded` | `unsupported_profile` | `unsupported_operation` | `aborted` |
`backend` | `unavailable` | `bad_descriptor` | `egress_refused` | `integrity` | `not_cached`.

`GenerateResult.timings` gains `firstTokenMs?` (milliseconds from the start of `generate()` to the first
token). `host` is `'worker'` for an adapter whose engine runs in a dedicated worker (R2w, R3w, R7 to R13)
and `'main'` for one that runs on the page's main thread.

## cacheOnly at acquire() (0.3.0)

`acquire(entryId, { cacheOnly: true })` resolves only for an entry that has a verified index row AND a
stored, committed file of exactly `entry.size` bytes, checked inside the asset lock. A `.part` file,
complete or partial, is never read, committed, resumed or reconciled under cacheOnly. Otherwise it
rejects with code 'not_cached', before any request, with no Range header and no asset.download.* event.
It does not re-hash: the R2 re-hash happens at `getBlob(id, { rehash: true })`. Adapters pass
`LoadOptions.cacheOnly` to every `acquire()`.

Error mapping inside an adapter (`AdapterErrorCode`):

- at download: `hash_mismatch` -> `integrity`;
- at `getBlob(rehash)`: `NotFoundError` (the file is gone) -> `not_cached`; `NotReadableError` (the OPFS
  snapshot changed), a size change or `hash_mismatch` -> `integrity`;
- a cacheOnly miss -> `not_cached`.

## What changed since 0.1.0

`ExecutionDevice`, `AcquireOptions`, `BackendAdapter.device`, `BackendAdapter.available()`,
`LoadOptions.onProgress`, `AssetSource.acquire(entryId, opts)` with the cross-instance hold below,
and the three error codes `unavailable`, `bad_descriptor`, `egress_refused`. `load(entry)` now takes
the **descriptor** entry of a signed manifest instead of a single file entry: a model is several
files, and the descriptor names them.

## Held assets (AssetSource.acquire)

`acquire()` may download through the asset manager. The refcount and a **shared Web Lock**
`airplanemode-held:<sha256>` are taken **inside** the asset lock and kept until
`handle.release()`. Eviction (`evict`, `evictToFit`, the quota make-room path) and `reconcile()` in
**any instance or tab** skip an asset that is held, locally by refcount or elsewhere through that
lock (S1-021). An adapter holds every handle it acquired until `unload()`. On a rung failure every
handle is released: the files become evictable and are not deleted.

## R1 Descriptor

For engine adapters, `load(entry)` requires, in this order:

1. `entry.kind === 'model'` and `entry.mediaType === MODEL_DESCRIPTOR_MEDIA_TYPE`
   (`application/vnd.airplanemode.model+json`); otherwise `bad_descriptor`.
2. `entry.size <= MODEL_DESCRIPTOR_MAX_BYTES` (65536), checked from the manifest entry **before**
   `acquire()`, with no download; otherwise `bad_descriptor`.
3. After `acquire()`, the adapter reads the descriptor with `getBlob(id, { rehash: true })` and
   re-checks `blob.size <= 65536`.
4. It parses with the strict canonical parser (the manifest parse-stage rules: no floats, no integers
   above 2^53-1, no digit-leading or otherwise invalid keys, no lone surrogates) and validates
   against `model-descriptor.schema.json` (wire strings `airplanemode.model/0.1` and `/0.2` are both
   accepted), plus the rules JSON Schema cannot express: `files` sorted by `path` in byte order with
   unique paths, `devices` sorted and unique, `modelLib` and `runtimeWasm` each equal to one of the
   `files[].path` (reason `schema`), and no `__proto__`, `constructor` or `prototype` key in
   `generation.chatTemplateKwargs` (reason `invalid_key`). It throws `AdapterError('bad_descriptor')`
   whose `reason` is one of `DESCRIPTOR_REJECT_REASONS`.
5. Cross-checks, each **bound to that AssetManager's single loaded manifest**:
   every `files[].entryId` exists in that manifest and is not itself a descriptor; `runtimeWasm` (and
   `modelLib`) name paths listed in `files` and those entries have kind `wasm`;
   `descriptor.engine === adapter.id`; `descriptor.devices` includes `adapter.device`.
   `sessionOptions` (transformers-js, 0.2 only) reaches the engine's session options as a fresh object
   literal built from the validated fields; never `Object.assign`, `for...in` or spread of the parsed
   object. `generation.chatTemplateKwargs` is copied the same way. The deprecated application option
   `TransformersAdapterOptions.sessionOptions` wins when given.
6. `satisfies(profile, descriptorEntry.minProfile)` and every file entry's `minProfile` must hold;
   otherwise `unsupported_profile`.

`chrome-prompt-api` ignores descriptors and never acquires anything (R6).

## R2 Verify-on-hand-off

Every byte given to an engine comes from a `Blob` obtained **after** `acquire()` through
`getBlob(entryId, { rehash: true })`. The engine receives that same `Blob`, or bytes read once from
it. OPFS `File` snapshots become unreadable after the underlying file is modified; IndexedDB and
memory Blobs are immutable, and an IndexedDB chunk Blob that was truncated is detected without
rehash (S1-018). Adapters hold their handles until `unload()`.

## R3 No egress

Adapters never call `fetch`, and never give an engine a URL that resolves outside the page origin.

`VERIFIED_PREFIX` is the same-origin path `<app base path>__airplanemode/verified/`.

**Shim registry.** One module-level registry `Map` maps the key
`<VERIFIED_PREFIX><descriptor ENTRY id>/<path>` to a verified `Blob`. Keys use the descriptor's
**entry id**, not its logical `id`: two descriptors that share a logical id (for example one per
device) never serve each other's files. Registering a key that is already held with a **different**
sha256 throws `bad_descriptor`. `unload()` removes its own keys. Only one `transformers-js`
`load()` runs at a time (module mutex), because the engine's `env` is process-global.

**Shim matching.** The shim replaces the engine's `fetch`. Input may be a string, a `URL` or a
`Request`; relative input is resolved against `location.href`. The method must be `GET` or `HEAD`;
`url.search` and `url.hash` must both be empty; `url.origin` must equal `location.origin`. Lookup is
by **exact equality** of `url.origin + url.pathname` after WHATWG parsing (so `..`, `%2e%2e` and
duplicate slashes are resolved by the parser before the comparison); never `startsWith`. A hit
returns `new Response(blob)`, or an empty body for `HEAD`. An unlisted path under the prefix returns 404. Everything else rejects with `AdapterError('egress_refused')` and emits
`backend.egress.refused` with the origin only (`<scheme>:` alone for `data:`, `blob:`, `file:` and
other schemes). The shim never calls `globalThis.fetch` or the engine's previous `env.fetch`.

**configureEnv (Transformers.js).** `configureEnv()` runs **immediately after `import()`**, before the
first `pipeline()`, and sets:

- `allowRemoteModels = false`, `allowLocalModels = true`, `localModelPath = VERIFIED_PREFIX`
- `useBrowserCache = false`, `useFSCache = false`, `useFS = false`, `useCustomCache = false`,
  `useWasmCache = false`
- `experimental_useCrossOriginStorage = false`, `remoteHost = 'https://invalid.invalid/'`
- `env.fetch` = the shim
- `backends.onnx.wasm.wasmPaths = { mjs: <ortFactoryUrl> }` with **no `wasm` key**: the library's
  default points at a CDN, and an object without `wasm` makes it use `wasmBinary`; `ortFactoryUrl`
  must resolve to `location.origin`, otherwise `egress_refused`
- `backends.onnx.wasm.wasmBinary` = the `ArrayBuffer` of the `runtimeWasm` Blob
- `numThreads = 1` unless `crossOriginIsolated`; `proxy = false`

`configureEnv` **re-asserts every value immediately before each `pipeline()` and each
`generate()`**. Any mismatch raises `AdapterError('backend')` and no load is attempted.

**ORT pin.** `src/backends/ort-pins.ts` (generated from `node_modules/onnxruntime-web/dist`,
committed, re-hashed by a test) exports `ORT_WEB_VERSION`, `ORT_WASM_FILE`, `ORT_WASM_SHA256`,
`ORT_FACTORY_FILE` and `ORT_FACTORY_SHA256`; if the WebGPU and WASM paths load different wasm
variants it exports one pin per device. A `runtimeWasm` entry whose sha256 differs from the pin for
that device is refused with `bad_descriptor`: a signed manifest cannot smuggle in a different engine
binary.

## R4 Generate

`temperature` 0, or `undefined` with `seed` set, means greedy decoding.
`descriptor.generation.chatTemplateKwargs` (for example `{ "enable_thinking": false }` for Qwen3) goes
to the chat template. Events follow Event 0.1.2 (`model.load`, `model.load.failed`, `model.generate`,
`model.load.phase`, `memory.sample`, `backend.worker`).

## R5 Error hygiene

`userMessage` and every `backend.*` or `model.*` event are built only from `AdapterErrorCode` and the
reason enums. The engine's message and stack are kept only as `Error.cause`. They are never copied
into `attrs`, `userMessage` or any DOM. No event ever carries a prompt, an output text, an engine
error message or a stack.

## R6 Chrome built-in model, outside the governance chain

The Chrome Prompt API model is Google-controlled, not covered by the signed manifest, and not
hash-verified. The rung is **opt-in**: it runs only when the caller passes `allowBuiltin: true`
(default **false**). Otherwise it is skipped with reason `not_allowed`, and
`LanguageModel.availability()` and `LanguageModel.create()` are **never called**. When allowed,
`create()` is called only when `availability() === 'available'`; any other state (`downloadable`,
`downloading`, `unavailable`) is `unavailable`, because `create()` there would start a third-party
model download. `model.load` carries `verified: false`.

## Fallback chain (runtime API)

`loadWithFallback({ profile, assets, models, adapters?, forceRung?, allowBuiltin?, beforeDownload?,
events?, signal?, onProgress? })` returns `{ adapter, rung, model, attempts }`.

- Rungs, in order: `webgpu` (transformers-js on webgpu), `wasm` (transformers-js on wasm), `builtin`
  (chrome-prompt-api, only with `allowBuiltin`), then refuse. `forceRung` starts lower and never moves
  up; rungs above it are recorded with reason `forced`.
- **Consent per rung.** `bytes` = the sum of sizes of the entries the store does not already hold
  verified. If `bytes > 0` and `beforeDownload` is absent, the attempt is `declined`: the default is
  **cache-only**. `beforeDownload({ rung, model, bytes })` is called again for **every** rung with
  that rung's own byte count, so declining the WebGPU download says nothing about WASM.
- Refusal throws `BackendRefusedError` (an `AdapterError` with code `unavailable`) carrying
  `attempts` and a plain-language `userMessage` built only from the enums. It names each rung and why
  it failed (for example `Chrome built-in model: not enabled`), says `Nothing was downloaded` only
  when that is true, and never contains a stack trace, an `Error:` prefix or engine text.
- Abort propagates without trying lower rungs.
- A file that failed its integrity check in one `loadWithFallback()` call is not acquired again in that
  call (R9), and a rung that needs no download loads cache-only (R10).

## Rules inherited from 0.1.0

- `generate()` streams through `onToken` when `capabilities().streaming` is true and honours
  `signal` (`finishReason: 'abort'`) and `maxTokens` (`finishReason: 'length'`).
- `embed()` returns `{ vectors, dims, normalized }`; `normalized` is true when every vector has unit
  length. An adapter or descriptor without embeddings rejects with `unsupported_operation`.
- Calling `generate()` or `embed()` before `load()` rejects with `AdapterError("not_loaded")`;
  backend failures surface as `backend` with `cause` set.

## R2w Hand-off across a worker

When the engine runs in a dedicated worker (`host: 'worker'`), the main thread runs R1, `acquire()` and
`getBlob(id, { rehash: true })`, and posts **those same Blob objects** to the worker. The worker checks
`blob.size === entry.size`; a Blob it cannot read is `integrity`. The worker never opens storage and never
derives an origin or a prefix from `self.location`, which is non-hierarchical in a blob worker.

`init` carries an absolute `verifiedPrefix`: `http:` or `https:`, ending in '__airplanemode/verified/', with
no query and no fragment. The worker requires `new URL(verifiedPrefix).origin === new URL(import.meta.url).origin`;
otherwise it posts error `backend` and handles nothing more. `createVerifiedFetch` receives the location
`{ href: verifiedPrefix, origin }` explicitly. `ortFactoryUrl` and the engine worker URL are resolved against
`document.baseURI` on the main thread, never in the worker.

## R3w Egress inside workers

The egress guard (`egress-guard`) is the **first import** of the engine host and imports nothing with side
effects:

- `fetch` is replaced with the verified shim on `self` and on every object in its prototype chain that owns a
  `fetch` property (the engine's own `env.fetch` is the shim too).
- These throw `AdapterError('egress_refused')`: `XMLHttpRequest`, `WebSocket`, `WebSocketStream` (if defined),
  `WebTransport`, `EventSource`, `importScripts`, `Worker`, `SharedWorker` (if defined) and
  `navigator.serviceWorker.register` (if present).
- `Cache.prototype.add` and `Cache.prototype.addAll` reject with `egress_refused`.
- The replacements are defined `writable: false` and `configurable: false`.
- The guard sets a sentinel; `tjs-engine` and `webllm-engine` check it first and throw `backend` if it is
  missing. Each refusal posts `{ type: 'egress', origin }` (origin as in R3: scheme, host and port only).

**Dynamic `import()` and FontFace URL loads CANNOT be guarded in JavaScript.** Only the inherited Content
Security Policy stops them (`script-src 'self'`; `default-src` covers fonts). That limit is stated, not
hidden: if the inherited CSP turns out not to apply to a blob worker, the fallback (a same-origin worker URL,
with `blob:` removed from `worker-src`) leaves `import()` and FontFace unguarded on a host that sends no CSP
header (GitHub Pages), so the fallback is always an S1 finding plus a pre-pilot row, never a silent gap.

Bootstrap of the worker:

- `abs = new URL(workerUrl, document.baseURI).href`, where the protocol is `http:` or `https:`, the origin
  equals `location.origin` and there is no query or fragment; otherwise the load throws **before**
  `URL.createObjectURL`.
- The source is exactly 'import ' + JSON.stringify(abs) + ';', in a Blob of type `text/javascript`.
- The blob URL passes the module-singleton Trusted Types policy 'airplanemode-worker' (created once per
  page, feature-detected). Its `createScriptURL` accepts only URLs in its own Set; revoking a URL removes it.

## R7 Isolation

A fresh dedicated module worker per engine `load()`, named 'airplanemode-engine-<adapter>-<device>'.
`unload()` and any failed load terminate it and run the main-thread release in R8. A WebGPU failure after
session creation therefore cannot poison the WebAssembly rung: the next rung starts a new worker.

## R8 Abort and crash

The `AbortSignal` posts `{ type: 'abort' }`; terminate if there is no `done` within 250 ms. `generate()` then resolves `finishReason: 'abort'`, the adapter returns to not-loaded, and a
later `generate()` rejects `not_loaded`. A worker `error` or `messageerror` rejects pending calls with
`backend` and emits `backend.worker` with state `crashed`.

After every terminate (unload, abort, crash, failed load) the main thread releases the asset holds,
releases the VerifiedFileSet, revokes the bootstrap URL and deletes the WebLLM staged keys of that `loadId`
(R11).

## R9 Chain integrity

An entry that failed verification (an `asset.verify.failed` event or an `integrity` error that names it) in
one `loadWithFallback()` call is **never acquired again in that call**: a later rung that needs it records
`failed` with reason `integrity` and calls neither `beforeDownload` nor `load()`. The reason text is
'a downloaded file failed its integrity check'. Messages are built from enums only, and that rung never
says 'could not be started'.

## R10 Chain cacheOnly

A rung whose plan counts 0 bytes loads with cacheOnly:true. A `not_cached` from it is recorded
`declined` with reason `declined` (and the message says nothing was downloaded when that is true). After an
approved `beforeDownload`, `cacheOnly` is false.

## R11 WebLLM staging

WebLLM reads its model through the Cache API. The adapter builds `appConfig` from scratch as a fresh object
literal, never from `prebuiltAppConfig`:

```
{ model_list: [{ model: '<verifiedPrefix><loadId>/<entryId>/', model_id: descriptor.id,
                 model_lib: '<verifiedPrefix><loadId>/<entryId>/<modelLib>',
                 overrides: { context_window_size } }],
  <cache backend field of the pinned web-llm>: 'cache' }
```

The IndexedDB cache is off and cross-origin storage is off; the exact field names of the pinned version are
recorded in `webllm-engine.ts` and asserted in tests. The log level is `ERROR`.

- **Staging.** `cache.put` only, into the caches the pinned version reads ('webllm/config', 'webllm/model'
  and 'webllm/wasm'), under exactly `<verifiedPrefix><loadId>/<entryId>/resolve/main/<path>` plus the
  model-library key. The main thread computes the exact key list and holds the Web Lock
  'airplanemode-webllm-stage-<loadId>' for the life of the load.
- **Sweep.** At load start the main thread deletes only the keys under `verifiedPrefix` whose `loadId` lock is
  not held (`navigator.locks.query`). It never calls `caches.delete(name)`.
- **Headroom.** `navigator.storage.estimate()` headroom must cover the total staged bytes before any put;
  otherwise the load rejects `backend`. On a `QuotaExceededError` the keys already staged are deleted and the
  load rejects `backend` with an enum-only message.
- **Cleanup.** The main thread deletes the loadId's keys on unload, abort, crash and failed load (R8).
- Zero network requests may reach the staging prefix.

## R12 Observability

Every engine load, main-thread or worker, emits `model.load.phase` per completed phase (acquire, verify,
handoff, session, first_token) with one `loadId` and the `host`, and `memory.sample` at `before_load`,
`after_session` and `after_first_token`. Workers post plain payloads; the main thread builds the events with
`newEvent()`. Memory figures are read from the browser and are `null` where it does not expose them
(`performance.memory` is Chrome-only and absent in workers).

## R13 Worker messages are untrusted

Every worker message is untrusted. The main thread validates each incoming message strictly:

- an unknown `type` or a bad shape is handled as a crash (`backend` plus `backend.worker` crashed);
- `phase` must be in `MODEL_LOAD_PHASES`, at most once per `loadId`;
- `durationMs` must be finite, 0..86400000;
- `bytes` and memory figures must be safe integers >= 0 or null;
- `error.code` must be an `AdapterErrorCode`, otherwise it becomes `backend`;
- `egress` carries no usable text: the host reads only that the message is well formed (its `origin`, if
  present, must be a string of at most 300 characters) and discards the value; the worker's string is
  never recorded, never forwarded and never compared;
- only `token.text` and the text of `done.result` reach the application; no worker-provided string reaches
  `attrs`, `userMessage` or the DOM outside the answer area, without exception.

Worker-reported egress refusals (S1-074, Event 0.1.3). Every valid `egress` message from the worker is
recorded by the host as one `backend.egress.refused` event with attrs `adapter` (the HOST's own adapter id,
never a worker value), reporter 'worker', origin 'worker-reported' (a fixed string) and `count`, the
1-based number of the worker-reported refusal within this `loadId`. At most 16 worker-reported events are
recorded per `loadId`; later messages are dropped silently (the guard in the worker has already refused the
request). A refusal by the page's own guard is recorded with reporter 'main' and `origin` equal to
`new URL(x).origin` as the page computes it (`'null'` when the origin is opaque or the URL does not
parse), and no `count`. The host never forwards worker text.

Worker RPC (runtime-internal, `src/worker/protocol.ts`, `v: 1`): main to worker `init`, `generate`, `abort`,
`unload`; worker to main `phase`, `memory`, `ready`, `token`, `done`, `error` (the `cause` never leaves the
`AdapterError`) and `egress`.

## Informative: Known limitation (0.3.0 draft)

On WebAssembly, the main-thread engine adapter runs generation on the page's main thread: the tab does not
repaint or run timers until generation ends, and an `AbortSignal` fired from a timer or a button is honoured
only between engine steps that yield; abort from `onToken` works. The worker host (`host: 'worker'`, R2w to
R13) moves the engine off the main thread and makes abort prompt; an application that does not give the
adapter a worker URL keeps the main-thread behaviour, and one engine module instance per page still cannot
recover from a rejected session creation (the transformers-js adapter on the main thread reports it through
`engineBlocked()`).

This is a limitation of the engine adapters in this repository, not a change to the contract: the
`generate()` signature and the `signal` rule above are unchanged, and the vendored copies of the spec
stay in sync.

## Scope in this repository

`src/backends/` ships `MockAdapter` (echo generation, deterministic hashed 64-dimension embeddings),
the Transformers.js adapters (WASM and WebGPU; main thread, and in a worker when given a worker URL), the
WebLLM adapter where it has landed, the Chrome Prompt API adapter and `loadWithFallback`, exported from
`@airplanemode/runtime/backends`; the main entry never imports an engine.
