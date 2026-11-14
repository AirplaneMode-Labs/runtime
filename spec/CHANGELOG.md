# Changelog (runtime/spec)

All notable changes to the open contracts. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the contracts follow
Semantic Versioning: the wire discriminator `airplanemode.<name>/<major>.<minor>` changes only on
major or minor, never on patch.

## [0.3.0] - 2026-11-14 (draft)

Spec release 0.3.0 ships: manifest 0.1.0 (unchanged, files and vectors byte-identical), capability
profile 0.1.0 (unchanged), event 0.1.2, storage API 0.1.0 (unchanged; `storage-api.md` gains a note),
backend adapter 0.3.0 and model descriptor 0.2.0.

### Added

- Backend adapter 0.3.0: `AcquireOptions.cacheOnly` and `LoadOptions.cacheOnly`, enforced at `acquire()`
  (a missing, row-only, truncated or `.part`-only asset rejects `not_cached` before any request; closes the
  rest of S1-053), the error codes `integrity` and `not_cached`, `GenerateResult.timings.firstTokenMs`
  and `BackendAdapter.host`. `backend-adapter.md` adds R2w (hand-off across a worker, the absolute
  `verifiedPrefix` origin check), R3w (egress guard inside workers, the guarded list, the prototype-chain
  `fetch` rule, the bootstrap rule; dynamic `import()` and FontFace rely on CSP only), R7 (per-load worker
  isolation, T1-S2-01), R8 (abort and crash, T1-S2-02), R9 (chain integrity, T1-S2-07), R10 (chain
  cacheOnly), R11 (WebLLM staging keyed by `loadId`), R12 (observability) and R13 (untrusted worker
  messages).
- Event 0.1.2 (patch, wire string unchanged): reserves `asset.hold.unknown` (S1-066); `backend.select`
  gains the reason `integrity` and the adapter `webllm`; `model.load` and `model.load.failed` gain
  `loadId` and `host`; `model.generate` gains `firstTokenMs` and `host`; new `model.load.phase`,
  `memory.sample` and `backend.worker`; `STORAGE_EVENT_NAMES`, `MODEL_LOAD_PHASES` and
  `MEMORY_SAMPLE_POINTS`. The namespace (attr `ns`) and the entry id (attr `model`) DO appear in events:
  `event.ts` and `storage-api.md` say applications must not encode personal data in them.
- Model descriptor 0.2.0 (`airplanemode.model/0.2`, `0.1` still accepted): the optional `sessionOptions`
  `{ graphOptimizationLevel }` for transformers-js, so `createDefaultAdapters()` can load Qwen3-1.7B q4f16
  without the application passing `sessionOptions` (the sessionOptions item of the Sprint 3 agenda); a
  three-branch `anyOf` (transformers-js 0.2, transformers-js 0.1, webllm with devices exactly
  `['webgpu']`); `MODEL_DESCRIPTOR_SPECS_ACCEPTED` and `DESCRIPTOR_REJECT_REASONS`.
- Shared descriptor vectors `vectors/descriptor/`: 3 positive and 14 negative, `negative.json`, README.
  Example `model-descriptor.example.json` moves to 0.2; new `model-descriptor.webllm.example.json`.

### Changed

- The "Known limitation" paragraph of `backend-adapter.md` is rewritten for the worker host (T1-S2-02):
  the main-thread engine adapter keeps the freeze and the slow abort; the worker host removes them.
- `event.schema.json` `$id` is `urn:airplanemode:spec:event:0.1.2`; the body is unchanged.
- `model-descriptor.schema.json` `$id` is `urn:airplanemode:spec:model-descriptor:0.2.0`.

### Security

- `generation.chatTemplateKwargs` rejects the keys `__proto__`, `constructor` and `prototype` (reason
  `invalid_key`), and an adapter copies `chatTemplateKwargs` and `sessionOptions` into fresh object
  literals, never with `Object.assign`, `for...in` or spread.
- `modelLib` and `runtimeWasm` must each equal one of `files[].path` (reason `schema`), and each is banned
  on the other engine's branch.

## [0.2.0] - 2026-11-09 (draft)

Spec release 0.2.0 ships: manifest 0.1.0 (wire unchanged), capability profile 0.1.0 (unchanged),
event 0.1.1, storage API 0.1.0 (unchanged), backend adapter 0.2.0 and the new model descriptor 0.1.0.

### Added

- Model descriptor 0.1.0 (`airplanemode.model/0.1`): `model-descriptor.ts`,
  `model-descriptor.schema.json` (`urn:airplanemode:spec:model-descriptor:0.1.0`) and an example. A
  descriptor is a small signed-manifest entry (`application/vnd.airplanemode.model+json`, at most 65536
  bytes) that names the weights, tokenizer, config and WASM runtime files of one model.
- Backend adapter 0.2.0: `ExecutionDevice`, `AcquireOptions`, `BackendAdapter.device` and
  `available()`, `LoadOptions.onProgress`, `AssetSource.acquire(entryId, opts)`, and the error codes
  `unavailable`, `bad_descriptor` and `egress_refused`. `backend-adapter.md` specifies rules R1 to R6
  (descriptor, verify-on-hand-off, no egress with the verified-file shim and the ORT pin, generate,
  error hygiene, the opt-in Chrome built-in model) and the per-rung consent of the fallback chain;
  an informative note records the Sprint 3 WebLLM staging rules.
- Event 0.1.1 reserved names `backend.select` (reason `not_allowed` included), `backend.refused`,
  `backend.egress.refused`, `model.load` (now with `verified`), `model.load.failed` and
  `model.generate`, with their attrs.
- Shared negative vector `neg-bad-alg-token.json` (a correct Ed25519 signature labelled `ED25519`,
  rejected with `schema` at parse stage by both implementations; `negative.json` now has 13 rows).
- `SPEC_WIRE.modelDescriptor` and `SPEC_VERSIONS.modelDescriptor` in `index.ts`.
- Informative "Known limitation (0.2.0 draft)" paragraph in `backend-adapter.md`: on WebAssembly,
  generation runs on the main thread (no repaint or timers until it ends; an `AbortSignal` from a timer
  or a button is honoured only between engine steps that yield; abort from `onToken` works); moving the
  engine off the main thread is planned for Sprint 3. No `.ts` or schema file changed, so every
  vendored copy stays in sync (T1-S2-02).

### Changed

- `asset.quota` documents `usageSource` (`estimate` | `accounted`): `usage = max(estimate().usage,
accounted bytes)` names its source; `quota` stays the estimate or the `quotaBytes` override, not the
  enforced limit (T1R2-02, T3-13). `event.schema.json` `$id` is `urn:airplanemode:spec:event:0.1.1`; its
  content is otherwise unchanged and the wire string stays `airplanemode.event/0.1`.
- `LoadOptions` gains `onProgress`; `BackendAdapter.load(entry)` takes the descriptor's entry.

### Security

- The downgrade-state rule (implementation, not a wire change): a stored state that is not
  `{version: valid SemVer, createdAt: calendar-valid}` is treated as an unreadable store, reason `state`,
  event attrs.reason `state_unavailable`; only `allowDowngrade` bypasses it (S1-031).

## [0.1.0] - 2026-11-22 (draft)

### Added

- Manifest 0.1.0: JSON Schema (`urn:airplanemode:spec:manifest:0.1.0`), TypeScript types, the
  restricted RFC 8785 canonicalisation profile, Ed25519 signing scheme with the
  `airplanemode-manifest-v1\n` prefix, verification order, trust-roots rule, SemVer downgrade rule
  and the RFC 8032 test-key refusal rule.
- Capability profile 0.1.0: `gpu`, `ramGb`, `storageFreeGb`, `cores`, `backendTier`, `features`,
  `measuredAt`, allow-listed `details`.
- Event 0.1.0: one event shape with enforced `attrs` privacy rules and the reserved runtime event
  names.
- Storage API 0.1.0 (TypeScript normative): `set/get/delete/query/usage/clear/list/close`,
  `StorageError`, `StorageDriver`; `query()` frozen and `not_implemented` until Sprint 4.
- Backend adapter 0.1.0 (TypeScript normative): `BackendAdapter`, `AssetSource`, `AssetHandle`,
  `AdapterError`.
- Examples (unsigned and signed manifest, capability profile, event), `TEST-KEY.md`, and the five
  positive plus twelve negative shared canonicalisation vectors (`negative.json` carries a `stage`,
  `parse` or `verify`, per vector).

### Changed

- Manifest `Signature.alg` is a token matching `^[a-z0-9][a-z0-9-]{0,31}$` instead of the enum
  `["ed25519"]`, so a manifest carrying `[unknown-alg, valid ed25519]` is schema-valid and verifies,
  while `[unknown-alg only]` fails at verify stage with `no_valid_signature` on both sides
  (S1-011). `ed25519` remains the only algorithm a 0.1 verifier verifies; `"none"` is never valid.
  New vector `neg-unknown-alg-only.json` (stage `verify`).
- `createdAt`, `expiresAt` and `signedAt` must be calendar-valid: the pattern alone no longer
  suffices and `2026-99-99T00:00:00Z` is rejected with `schema`, matching cp-manifest (S1-014). New
  vector `neg-bad-date.json`.
- New rejection reason `state`: a verifier whose downgrade-state store cannot be read or written
  fails closed instead of open (S1-013).
- `asset.quota` attrs documentation: `quota` is the browser estimate (or test override), not the
  enforced limit.
