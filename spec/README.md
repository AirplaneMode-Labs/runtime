# Airplane Mode Labs open contracts (runtime/spec)

The five contracts (plus the model descriptor that belongs to the backend adapter) that let the
AirplaneMode-Labs libraries evolve independently and let the paid control plane plug in later without
touching the open code. This directory is the source of truth; every other repo vendors a copy under
`src/contracts/` (TypeScript) or mirrors the shapes in serde structs (Rust) with the header
`// Vendored from AirplaneMode-Labs/runtime spec/<file> @ <that contract's own version>; source of
truth is runtime/spec; do not edit here`. Mismatches are fixed on the consumer side.

Spec release **0.6.0** (2026-11-19, untagged) ships these versions together (each contract keeps its own
version, so a vendored file carries the version of its own contract, not the release number):
manifest 0.1.3: published; other contracts: draft. The plan's "manifest spec v0.1" is the manifest contract
on wire `airplanemode.manifest/0.1`, published as manifest 0.1.3 in [`MANIFEST.md`](MANIFEST.md); it is
committed; public after the owner's push (release 0.4.0 with manifest 0.1.1 was pushed on 15 Nov 2026).
Manifests 0.1.2 and 0.1.3 are additive patches: the manifest 0.1.1 wire format is unchanged, and a 0.1.2
manifest stays valid.

The contracts are published under Apache-2.0 and never move behind the control-plane licence.

| Contract           | Files                                                     | Version | Status    |
| ------------------ | --------------------------------------------------------- | ------- | --------- |
| Manifest           | `MANIFEST.md`, `manifest.schema.json`, `manifest.ts`      | 0.1.3   | published |
| Capability profile | `capability-profile.schema.json`, `capability-profile.ts` | 0.1.1   | draft     |
| Event              | `event.schema.json`, `event.ts`                           | 0.1.5   | draft     |
| Storage API        | `storage-api.ts` (normative), `storage-api.md`            | 0.4.0   | draft     |
| Backend adapter    | `backend-adapter.ts` (normative), `backend-adapter.md`    | 0.5.0   | draft     |
| Model descriptor   | `model-descriptor.schema.json`, `model-descriptor.ts`     | 0.2.1   | draft     |

`index.ts` re-exports everything and carries `SPEC_RELEASE`, `SPEC_VERSIONS` and `SPEC_STATUS` (one key per
contract). Examples live in `examples/`, the shared vectors in `vectors/` (canonicalisation, negative,
`tamper/`, `tamper-assets/`, `descriptor/`, `expect-id/`, `state-ids/`, `weak-keys/`), and the change history in
`CHANGELOG.md`.

## Versioning

Each schema has `"$schema": "https://json-schema.org/draft/2020-12/schema"` and
`"$id": "urn:airplanemode:spec:<name>:<full version>"` (the manifest schema is
`urn:airplanemode:spec:manifest:0.1.3`, the capability-profile schema `urn:airplanemode:spec:capability-profile:0.1.1` and the event schema `urn:airplanemode:spec:event:0.1.5`); each instance carries a `spec` discriminator
`airplanemode.<name>/<major>.<minor>` (patch never changes the wire format; the model descriptor's is
`airplanemode.model/0.2`, and consumers also accept `airplanemode.model/0.1`). Consumers reject unknown spec strings. All object keys match
`^[A-Za-z_][A-Za-z0-9_]{0,63}$` (never digit-leading; see canonicalisation);
`additionalProperties: false` everywhere except `Event.attrs`, `CapabilityProfile.details` and
`ModelDescriptor.generation.chatTemplateKwargs`, whose keys are constrained by the same pattern via
`propertyNames`.

The `$id` URNs become `https://` URLs once a domain is reserved; the URN form stays valid as an
alias.

### Status

Each contract has a status, "draft" or "published". "published" means frozen on its wire string: later
changes are additive patches that change no accepted or refused input, or a new wire string. "draft" may
change in a minor version. Release 0.6.0: manifest 0.1.3 is published; every other contract is a draft.

### Release numbering

A spec release bundles one version of each contract. The release number follows one rule: the release
minor bumps when any contract takes a minor bump, and the patch bumps otherwise; the wire discriminator
changes only on a contract major or minor. Release 0.4.0 bumps the minor because storage API 0.2.0 is a
minor change; manifest 0.1.1, event 0.1.3, backend adapter 0.3.1 and model descriptor 0.2.1 are patches
and keep their wire strings. The planned 0.3.1 patch release was folded into 0.4.0 for that reason.
Release 0.5.0 bumps the minor again, because storage API 0.3.0 and backend adapter 0.4.0 are minor changes;
manifest 0.1.2 and event 0.1.4 are patches and keep their wire strings. Release 0.6.0 bumps the minor once
more: the minor rises because storage API 0.4.0 and backend adapter 0.5.0 are minor changes; manifest 0.1.3,
capability profile 0.1.1 and event 0.1.5 are patches and keep their wire strings.

## Manifest 0.1.3 ("manifest spec v0.1", published)

A `Manifest` lists each model or data file with its SHA-256, size, version, licence and minimum
capability profile, and is signed with Ed25519. The runtime verifies the signature and every hash before
any consumer can read a byte. The full normative text is [`MANIFEST.md`](MANIFEST.md): scope, shape,
canonicalisation, the duplicate-member rule, signing, trust roots, the verification order, the reason
precedence, the downgrade rule, the test keys, the tamper vectors, security considerations and
conformance. Shapes: `manifest.ts`; validation: `manifest.schema.json`.

0.1.2 (spec release 0.5.0) is an additive patch: the verifier takes an optional `expectId` (a manifest of
another id is refused with `unexpected_id`, before the downgrade state is read; an invalid `expectId` is a
TypeError, 'invalid expectId'), the S1-097 and S1-102 sentences are normative in Security considerations,
and `MANIFEST.md` has a Demo bundles section for the manifests the demo builds write. The wire format of
0.1.1 is unchanged; vectors `expect-id/` and `state-ids/` pin the new behaviour.

0.1.3 (spec release 0.6.0) is an additive patch (S1-113, TD-68, TD-82): a trust set holding a weak Ed25519
public key (not the canonical encoding of a prime-order point other than the identity) is refused with the new
reason `weak_key_refused`, before the manifest is parsed and with no opt-out; the vectors `weak-keys/` pin it
(at least sixteen refused rows and the accepted ones). MANIFEST.md gains the normative Weak keys section, the
informative Pinned entries note (TD-54) and the ramGb sentence (TD-57). The wire format is unchanged and a
0.1.2 manifest stays valid.

Summary:

- `signedBytes = UTF-8("airplanemode-manifest-v1\n") || canonical(manifest without "signatures")`, where
  `canonical()` is RFC 8785 JCS restricted to this profile (sorted keys, no whitespace, integers 0 to
  2^53-1, no floats, keys `^[A-Za-z_][A-Za-z0-9_]{0,63}$`). Pure Ed25519; S must be less than L.
- An object with a repeated member name, at any depth, is `invalid_json`.
- The trust set (keyId to raw public key) is application configuration and is never fetched with the
  manifest. `signedAt`, `alg`, `keyId` and `publicKey` are unauthenticated; one valid signature is enough.
- The reason of a refusal is the first stage that fails (`MANIFEST_REJECT_PRECEDENCE`); a missing `spec` is
  `bad_spec`. A downgrade (lower version, or the same version with an earlier `createdAt`) is refused; the
  state store is written only after a valid signature.
- A trust set holding any of the five RFC 8032 section 7.1 test keys, by keyId or by raw bytes, is refused
  with `test_key_refused` unless `allowTestKeys === true`.

0.1.1 is an additive patch of 0.1.0 (published means frozen on the wire string): duplicate members,
the explicit S < L rule, the reason precedence, and all five test keys are written down. It was amended in
place before the first push (team decision TD-26, 14 Nov 2026; nothing had left the machine): both version
members take the strict SemVer 2.0 grammar (no leading zeros, no empty identifier), the published Signature
schema is applied to every `signatures[]` item (reason `schema`), and a missing or non-array `signatures`
member is judged after the parse stage. A second amendment before the push (team decision TD-29, 14 Nov 2026,
fix round 2) freezes the contract: a member that no table declares is `schema` under any name (`__proto__`,
`constructor`, ...; BUG-T2-S4-11), `sig` and `publicKey` have one accepted encoding each (canonical padded base64;
BUG-T2-S4-14) and the forbidden url characters are one explicit list (BUG-T2-S4-15). The schema body is
otherwise unchanged and its `$id` moves; the contract version, the release and the wire string do not.

### Shared vectors

`vectors/` holds five positive vectors (`01-unsigned-example`, `02-escapes`, `03-devanagari`,
`04-minprofile-full`, `05-four-entries`), each as `<n>.json` with `<n>.canonical.txt` (expected signed
bytes including the prefix) and `<n>.sig.txt` (Ed25519 signature under the RFC 8032 seed); thirty-two negative
vectors `neg-*.json` with their rejection reason and stage (`parse` or `verify`) in `vectors/negative.json`;
`vectors/tamper/` (fifteen tamper vectors and `tamper.json`); and `vectors/tamper-assets/` (three signed
manifests over one asset, runtime-specific). They are generated by `test/tools/make-vectors.mjs` and
`test/tools/make-tamper-vectors.mjs` and vendored byte for byte into
`control-plane/crates/cp-manifest/tests/fixtures/vectors/`.

### Test key

`examples/TEST-KEY.md` documents the RFC 8032 section 7.1 test keys: TEST 1 signs the examples and the
positive vectors (seed `9d61b19d...ae7f60`, public key `d75a9801...07511a`), and TEST 2 is the second key of
the tamper vectors. All five are published, non-secret vectors that must never be trusted outside tests;
`cp-sign` refuses their seeds unless `--allow-test-key`. The signed example `sig` is reproduced byte for
byte by `cp-sign sign --allow-test-key --no-expiry`.

## Capability profile 0.1.0

`{ gpu, ramGb, storageFreeGb, cores, backendTier, features, measuredAt, details? }`, computed once
per page load by `detectCapabilities()`. `BackendTier` ranks `webgpu-f16` (4) > `webgpu-f32` (3) >
`wasm-simd` (2) > `wasm` (1) > `none` (0). `details` carries only the allow-listed keys `vendor`,
`architecture`, `maxBufferSize`, `maxStorageBufferBindingSize`, `maxComputeWorkgroupStorageSize`
and `maxComputeInvocationsPerWorkgroup`; adapter description and device strings are dropped
(driver-version fingerprint); `navigator.userAgent` and `navigator.userAgentData` are never read;
no personal data. `satisfies(profile, minProfile)` implements the MinProfile rule above.

## Event 0.1.4

One JSON shape for logs, timings, memory, model-load and asset records. `attrs` is flat, at most
32 keys matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, string values at most 1024 UTF-16 units, never
URLs with query strings, document text, prompts or user identifiers. The runtime's `newEvent()`
enforces these rules in code: key regex, 32-key cap (TypeError), truncation to 1024, query-string
stripping after `://`, and a TypeError for any key matching `/prompt|text|content|document|ua|userAgent/i`.
`EventSink { emit(e) }`; the runtime's default sink is an in-memory ring buffer of 1000 with
`subscribe()`. No library ever has a network sink. Reserved runtime event names and their attrs are
listed in `event.ts` (`RUNTIME_EVENT_NAMES`).

0.1.1 is wire-compatible (the wire string stays `airplanemode.event/0.1`, the schema body is
unchanged and only its `$id` moves): `asset.quota` documents a fourth attr `usageSource`
(`estimate` | `accounted`, the source of `usage = max(estimate().usage, accounted bytes)`; `quota`
remains the estimate or the `quotaBytes` test override, not the enforced limit), and six names are
reserved: `backend.select` (attrs `rung`, `adapter`, `model`, `outcome`, `reason` including
`not_allowed`), `backend.refused`, `backend.egress.refused` (origin only, never a path or query),
`model.load` (now with `verified`: true only for adapters that obey R2), `model.load.failed` and
`model.generate`. No event ever carries prompt text, output text or an engine error message or stack.

0.1.2 is a patch (the wire string stays `airplanemode.event/0.1`; only the schema `$id` moves to
`urn:airplanemode:spec:event:0.1.2`; spec release 0.3.0): it reserves `asset.hold.unknown` (S1-066), adds
the reason `integrity` and the adapter `webllm` to `backend.select`, adds `loadId` (16 lowercase hex,
random per `load()`) and `host` (`worker` | `main`) to `model.load` and `model.load.failed` (whose `code`
is any `AdapterErrorCode`), adds `firstTokenMs` and `host` to `model.generate`, and reserves
`model.load.phase` (one event per phase, `durationMs` required), `memory.sample` (every figure read from
the browser and `null` where it is not exposed, never estimated) and `backend.worker`. `event.ts` also
exports `STORAGE_EVENT_NAMES` (`storage.set`, `storage.get`, `storage.delete`, `storage.quota`, source
`localdata`), `MODEL_LOAD_PHASES` and `MEMORY_SAMPLE_POINTS`. Privacy: the namespace (attr `ns`) and the
descriptor entry id (attr `model`) DO appear in events and in the DevTools snapshot; applications must
not encode personal data or document identifiers in namespace names or entry ids.

0.1.3 is a patch (the wire string stays `airplanemode.event/0.1`; only the schema `$id` moves to
`urn:airplanemode:spec:event:0.1.3`; spec release 0.4.0): `backend.egress.refused` is re-specified for
S1-074. It carries `adapter` (the host's own adapter id), `reporter` (`main` | `worker`), `origin`
(`new URL(x).origin` for the page's own guard, `'null'` when opaque; the fixed string `worker-reported` for a
worker report) and, for a worker report, `count` (1 to 16 per `loadId`; later reports are dropped); no
worker-provided string, without exception, reaches an event. `STORAGE_EVENT_NAMES` grows from four to seven
with `storage.query`, `storage.index.open` and `storage.index.write`.

0.1.4 is a patch (the wire string stays `airplanemode.event/0.1`; only the schema `$id` moves to
`urn:airplanemode:spec:event:0.1.4`; spec release 0.5.0): it reserves `model.embed` and `model.memory`,
adds the attr `budget` to `model.generate` (and `finishReason` 'abort'), the reason `unexpected_id` to
`manifest.verify.failed`, `STORAGE_EVENT_NAMES` grows from seven to ten with `storage.doc.put`,
`storage.doc.delete` and `storage.doc.query`, and `event.ts` exports `DOCKIT_EVENT_NAMES` (source `dockit`),
`PIPELINE_STAGES` and `PIPELINE_REASONS`. The localdata SDK emits a namespace registered with
`redactNamespacePrefix(prefix)` as `prefix + '*'`, so a per-document namespace never reveals a document id.

## Storage API 0.3.0

See `storage-api.md` and the normative `storage-api.ts`. 0.3.0 is a minor change (draft): the documents API
(`putDocument`, `getDocument`, `listDocuments`, `deleteDocument`, `queryChunks` and `redactNamespacePrefix`):
a document and its text chunks with vectors are written all-or-nothing under the reserved driver
namespace `'__ld_doc.' + ns`, queried by a brute-force top-k, and `clear(ns)` physically removes them.
0.2.0 was a minor change (draft): `query()` is
implemented (brute-force top-k, `cosine` or `dot`, bit-exact f32 scoring), `putVectors()` and `indexInfo()`
are new, a vector index sits beside the key-value data in each namespace, writes are all-or-nothing,
`UsageResult` gains `vectorRows` and `vectorBytes`, and the error code `corrupt` is new. The prefix `__ld_`
is reserved for the SDK's own driver namespaces. The on-disk format is localdata-internal.

## Backend adapter 0.4.0

0.4.0 is a minor change (draft): `embed(texts, opts?)` with `EmbedOptions` (`pooling`, `normalize`),
`EMBED_MAX_TEXTS` and `EMBED_TEXT_MAX`, `EmbedResult.truncated` and `timings`, the error code
`context_overflow`, `GenerateResult.budget`, and the rules R4b (token budget, `context_overflow`, Stop),
R14 (embeddings through the worker host, with host-side validation of the worker's answer) and R15
(in-worker integrity over every file the engine can read; the main-thread load-time re-hash leaves the
load path), plus the worker-support exports `installEgressGuard({ allowPathPrefixes })` and
`startModuleWorker(url, { policyName })`. Earlier history follows.

### Backend adapter 0.3.1

See `backend-adapter.md` (rules R1 to R6: descriptor, verify-on-hand-off, no egress, generate, error
hygiene, Chrome built-in model; R2w and R3w for an engine in a worker; R7 to R13: isolation, abort and
crash, chain integrity, chain cacheOnly, WebLLM staging, observability, untrusted worker messages) and
the normative `backend-adapter.ts`. 0.3.0 adds `AcquireOptions.cacheOnly` and `LoadOptions.cacheOnly`
(cache-only enforced at `acquire()`), the error codes `integrity` and `not_cached`,
`GenerateResult.timings.firstTokenMs` and `BackendAdapter.host`. 0.2.0 had added `ExecutionDevice`,
`BackendAdapter.device` and `available()`, `AcquireOptions` and the cross-instance hold on
`AssetSource.acquire()`, `LoadOptions.onProgress`, and the error codes `unavailable`, `bad_descriptor`
and `egress_refused`. `load(entry)` takes the descriptor's manifest entry. 0.3.1 (a patch; spec release
0.4.0) changes no type: R13 is amended so a worker-reported egress refusal is recorded per Event 0.1.3 and
the host never forwards worker text (S1-074). Informative: the WebLLM rung was cut from Sprint 4 (team
decision TD-08); R11 stays specified and unimplemented.

## Model descriptor 0.2.1

`model-descriptor.schema.json` and `model-descriptor.ts` (no imports from other spec files; examples are
`examples/model-descriptor.example.json` and `examples/model-descriptor.webllm.example.json`). A
descriptor is a small JSON file (at most 65536 bytes) that is itself a manifest entry (`kind: model`,
`mediaType: application/vnd.airplanemode.model+json`) and lists the other entries an engine needs:
`files[]` of `{ path, entryId }` sorted by `path` with unique paths, `runtimeWasm` (transformers-js) or
`modelLib` (webllm), `devices` (`wasm` and or `webgpu`, sorted; exactly `["webgpu"]` for webllm), `dtype`,
`contextLength`, optional `generation.chatTemplateKwargs`, optional `sessionOptions`
(`{ graphOptimizationLevel }`, transformers-js and wire string 0.2 only), and `source` (repo and 40-hex
revision: provenance only, never fetched) and `licence`. The manifest signature and per-entry SHA-256
cover the descriptor and every file it names. Wire format `airplanemode.model/0.2` (written);
`airplanemode.model/0.1` is still accepted and never carries `sessionOptions`. The schema is an `anyOf`
of three branches: A transformers-js 0.2, B transformers-js 0.1, C webllm (which pins the 0.2 wire string
since 0.2.1, BUG-T2-S3-22); a banned property is given the type `null`. A repeated member name at any depth
is `invalid_json`, and `DESCRIPTOR_REJECT_PRECEDENCE` fixes which reason wins when several faults hold.

Checked outside JSON Schema (by `validateModelDescriptor()` and `parseDescriptor()` in the runtime and by
cp-manifest): `files` sorted and unique, `devices` sorted, `modelLib` and `runtimeWasm` each equal to a
`files[].path`, no `__proto__`, `constructor` or `prototype` key in `chatTemplateKwargs`. Rejection
reasons: `invalid_json`, `float`, `bigint`, `digit_key`, `invalid_key`, `lone_surrogate`, `bad_spec`,
`schema`, `unsorted_files`, `duplicate_paths`, `unsorted_devices`. Shared vectors: `vectors/descriptor/`
(3 positive, 20 negative, `negative.json`, `README.md`).
