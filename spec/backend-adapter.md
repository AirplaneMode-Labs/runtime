# Backend adapter 0.2.0 (with model descriptor 0.1.0)

Normative definition: `backend-adapter.ts` and, for the descriptor, `model-descriptor.ts` and
`model-descriptor.schema.json`. One interface over Transformers.js (ONNX Runtime Web), the Chrome
Prompt API and, from Sprint 3, WebLLM, so the fallback chain WebGPU -> WASM -> Chrome built-in can
pick a backend without the application changing. `backend-adapter.ts` imports nothing from
`model-descriptor.ts`; the two are released together and versioned separately.

## Shape

```ts
type ExecutionDevice = 'webgpu' | 'wasm' | 'builtin';

interface BackendAdapter {
  readonly id: 'webllm' | 'transformers-js' | 'chrome-prompt-api' | (string & {});
  readonly tier: BackendTier; // the minimum tier the adapter needs
  readonly device: ExecutionDevice;
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
WASM `wasm`, `chrome-prompt-api` `none`.

`AdapterErrorCode` = `not_loaded` | `unsupported_profile` | `unsupported_operation` | `aborted` |
`backend` | `unavailable` | `bad_descriptor` | `egress_refused`.

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
   against `model-descriptor.schema.json`, plus the ordering rules JSON Schema cannot express
   (`files` sorted by `path` in byte order with unique paths; `devices` sorted and unique).
5. Cross-checks, each **bound to that AssetManager's single loaded manifest**:
   every `files[].entryId` exists in that manifest and is not itself a descriptor; `runtimeWasm` (and
   `modelLib`) name paths listed in `files` and those entries have kind `wasm`;
   `descriptor.engine === adapter.id`; `descriptor.devices` includes `adapter.device`.
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
to the chat template. Events follow Event 0.1.1 (`model.load`, `model.load.failed`,
`model.generate`).

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

## Rules inherited from 0.1.0

- `generate()` streams through `onToken` when `capabilities().streaming` is true and honours
  `signal` (`finishReason: 'abort'`) and `maxTokens` (`finishReason: 'length'`).
- `embed()` returns `{ vectors, dims, normalized }`; `normalized` is true when every vector has unit
  length. An adapter or descriptor without embeddings rejects with `unsupported_operation`.
- Calling `generate()` or `embed()` before `load()` rejects with `AdapterError("not_loaded")`;
  backend failures surface as `backend` with `cause` set.

## Informative: WebLLM staging (Sprint 3, not normative in 0.2.0)

The WebLLM adapter lands in Sprint 3. `engine: 'webllm'` and `modelLib` stay in the descriptor schema
so the contract does not change then. The staging rules the security review set for it:

- Staged Cache API keys go at
  `${location.origin}${BASE_URL}__airplanemode/verified/<descriptor entry id>/resolve/main/<path>`.
- Only those exact keys are deleted (`cache.delete(url)`), never `caches.delete(name)`.
- `appConfig` is built from scratch, never from `prebuiltAppConfig`.
- `cacheBackend` is `'cache'` and cross-origin storage is off.
- Zero network requests may go to the staging prefix.

## Informative: Known limitation (0.2.0 draft)

On WebAssembly, generation runs on the main thread: the tab does not repaint or run timers until generation ends, and an AbortSignal fired from a timer or a button is honoured only between engine steps that yield; abort from onToken works. Moving the engine off the main thread is planned for Sprint 3.

This is a limitation of the engine adapters in this repository, not a change to the contract: the
`generate()` signature and the `signal` rule above are unchanged, and the vendored copies of the spec
stay in sync.

## Scope in this repository

`src/backends/` ships `MockAdapter` (echo generation, deterministic hashed 64-dimension embeddings),
the Transformers.js adapter (WASM and WebGPU), the Chrome Prompt API adapter and `loadWithFallback`,
exported from `@airplanemode/runtime/backends`; the main entry never imports an engine.
