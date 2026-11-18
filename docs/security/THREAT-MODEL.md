# Threat model: Airplane Mode Labs runtime and the Sprint 1 surface (updated through Sprint 5)

Version 0.3 (Sprint 1, 9 to 22 November 2026, updated after fix round 1 on 9 November; Sprint 2 update of 9 November 2026 in section 7). Written by the security consultant (lane S1).
Scope: `@airplanemode/runtime` (manifest verification, asset manager, capability profile, events),
the open contracts in `runtime/spec`, `cp-manifest` and `cp-sign` in control-plane, the dockit
PWA skeleton, `@airplanemode/localdata`, and the shared supply chain. Out of scope this sprint:
real backend adapters, the control-plane server, real model hosts, hosting-layer headers (see
`PRE-PILOT-CHECKLIST.md`).

The product promise this model protects: a buyer in BFSI, legal or healthcare runs document
intelligence on an 8 GB laptop with Wi-Fi off, and the only bytes that ever execute or feed a
model are bytes named by a manifest their organisation chose to trust. Governance (signed
manifests, policy, audit) is what they pay for, so the signing and verification path is the crown
jewel; inference speed is not a security asset.

## 1. Assets

| Id  | Asset                                                                              | Why it matters                                                                                  |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Publisher signing keys (Ed25519 seeds used with `cp-sign`)                         | Whoever holds one can make any model or data file "trusted" for every fleet that trusts the key |
| A2  | Trust-root configuration compiled into the app (keyId -> public key)               | Defines who the fleet believes; its integrity is the root of the whole chain                    |
| A3  | Manifests (signed lists of model/data files with SHA-256 and size)                 | Authenticated statement of what may be loaded; downgrade state depends on `version`/`createdAt` |
| A4  | Model, tokenizer, data and wasm assets in OPFS / IndexedDB                         | Large (700 MB), expensive to re-download, feed inference; must match the manifest hash exactly  |
| A5  | The asset index (`index.json`), part state (`<sha>.part.json`) and downgrade state | Decide which bytes are served as verified and whether an older manifest is refused              |
| A6  | User documents and derived text (dockit, localdata namespaces)                     | Regulated personal and financial data; must never leave the device or appear in events          |
| A7  | Capability profile and events                                                      | Low-sensitivity telemetry-shaped data that must not become a fingerprint or carry document text |
| A8  | The software supply chain (npm, crates, GitHub Actions, lockfiles)                 | A compromised dependency or Action is code execution in CI or in every user's browser           |
| A9  | The lab's reputation for "no network egress, no telemetry"                         | A single stray request breaks the buyer's airplane-mode assumption                              |

## 2. Trust boundaries

```
+--------------------------------------------------------------------------------------------+
| Laptop (possibly unmanaged, possibly shared, BitLocker/FileVault not guaranteed)            |
|                                                                                            |
|  +----------------------------------------- Browser -----------------------------------+   |
|  |                                                                                     |   |
|  |  +---------------- Origin: dockit app (https://<host>/) ------------------------+   |   |
|  |  |  dockit UI  <->  @airplanemode/runtime  <->  OPFS / IndexedDB (origin store) |   |   |
|  |  |               ^ trust roots (A2, compiled in)                                |   |   |
|  |  |               | service worker (hash-verified shell cache)                   |   |   |
|  |  +-----|------------------------------------------------------------------------+   |   |
|  |        | fetch (cors, no credentials, no redirect, no referrer, no-store)             |   |
|  +--------|-----------------------------------------------------------------------------+   |
+-----------|--------------------------------------------------------------------------------+
            |  TLS (or loopback http in tests only)
            v
   Manifest publisher / asset host (CDN or customer-run server)   <--- signs with A1 via cp-sign
   (future) control plane: registry, policy, audit, fleet view
```

| Boundary | From -> To                                  | What crosses                                    | Control                                                                                                                                                                        |
| -------- | ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1       | Asset host -> browser                       | manifest JSON, asset bytes                      | Ed25519 signature over canonical body; SHA-256 + size of every entry before any byte is served; `allowedOrigins`; https-only (http to loopback for tests); fixed fetch options |
| B2       | Publisher workstation -> asset host         | signed manifest                                 | `cp-sign` writes `expiresAt` by default, refuses the RFC 8032 test key, never prints the seed                                                                                  |
| B3       | App build -> trust roots                    | keyId -> public key map                         | Compiled constant; never fetched with the manifest; embedded `publicKey` never added                                                                                           |
| B4       | runtime -> origin storage (OPFS, IndexedDB) | `.bin`, `.part/`, `.part.json`, `index.json`    | Verify-before-commit; row-after-file; eviction row-before-file; `reconcile()` never promotes                                                                                   |
| B5       | Tab <-> tab on the same origin              | concurrent downloads, eviction, index writes    | Web Locks (`navigator.locks`) around `ensure()` per sha and every index read-modify-write                                                                                      |
| B6       | Page -> service worker (dockit)             | navigations, shell files                        | Precache hashed at install; Range, `/assets/*`, `manifest.json`, non-GET and cross-origin pass through                                                                         |
| B7       | Library -> network                          | only the manifest and asset URLs the app passes | No network sink anywhere; `test/no-egress.test.ts` greps `src/`; events stay in a ring buffer                                                                                  |
| B8       | Dependencies and CI -> source               | npm/crates, GitHub Actions                      | Lockfiles committed, `ignore-scripts=true`, Actions pinned by SHA, per-job `permissions`, no `pull_request_target`, `deny.toml` licence allow-list                             |

Everything inside one browser origin is one trust domain. The runtime cannot defend its OPFS
files against other JavaScript on the same origin (a co-tenant tab, an XSS, a browser extension
with host permissions); see accepted risk S1-006 and the rehash mitigation.

## 3. Attacker models

| Id  | Attacker                                     | Capabilities                                                                                                    | Goals                                                                                            | Primary controls                                                                                                                                                                  |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Malicious or compromised asset host          | Serve any bytes, headers, status codes, lengths, infinite bodies, wrong Content-Range, redirects, old manifests | Run attacker-chosen model/wasm; poison the cache; exhaust storage or memory; roll the fleet back | Signature + hash + size before use; oversize cap and chunk budget; redirect refused; downgrade rule; `expiresAt`                                                                  |
| T2  | Network MITM without TLS                     | Same as T1 on the wire                                                                                          | Same as T1                                                                                       | https-only policy (http only to loopback); TLS is a hosting requirement (checklist)                                                                                               |
| T3  | Holder of a compromised signing key          | Produce validly signed manifests                                                                                | Ship a backdoored model to every fleet trusting the key                                          | Today: `expiresAt` bounds the lifetime; nothing else. No revocation, transparency log or multi-signature yet (S1-001, S1-002, S1-004)                                             |
| T4  | Malicious co-tenant on the same origin       | Read/write OPFS and IndexedDB, call `navigator.locks`, edit `index.json`, swap `.bin` bytes                     | Serve unverified bytes as verified; reset downgrade state; cause re-downloads                    | Verify-before-commit limits damage to post-commit tampering; size check on every `getBlob`; `rehash: true` for high-assurance loads; dedicated origin at hosting (S1-006, S1-009) |
| T5  | Evil maid / lost laptop                      | Read the disk offline                                                                                           | Read documents, cached models, downgrade state                                                   | Out of scope for the library; BitLocker/FileVault and OS login are checklist items; no secrets are stored by the runtime                                                          |
| T6  | Prompt or document injection (later sprints) | Craft a PDF whose text steers the model                                                                         | Exfiltrate data, mislead the user                                                                | Not reachable in Sprint 1 (no real adapter, no document processing); events refuse `prompt                                                                                        | text | content | document` keys so injection text cannot leak through telemetry |
| T7  | Supply-chain attacker                        | Publish a malicious dependency or Action version; typosquat the unreserved `@airplanemode` scope                | Code execution in CI or in users' browsers                                                       | Pinned SHAs, lockfiles, `ignore-scripts`, zero runtime deps in libraries, Dependabot; scope reservation is an owner action                                                        |
| T8  | Fingerprinting observer (privacy)            | Receive the capability profile or events                                                                        | Identify the device or user                                                                      | `details` allow-list, no `userAgent`/`userAgentData`, random per-load session id, no network sink                                                                                 |

## 4. STRIDE per component

Legend: S spoofing, T tampering, R repudiation, I information disclosure, D denial of service,
E elevation of privilege. "Control" names the code; "Gap" points at FINDINGS.md.

### 4.1 Manifest verification (`runtime/src/manifest.ts`, `canonical.ts`, `semver.ts`; `cp-manifest`)

| Threat | Scenario                                                                 | Control                                                                                                                                                  | Gap / finding                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Attacker-supplied `publicKey` or `keyId` claims to be a trusted key      | Trust comes only from the compiled map; `keyId` recomputed from the trusted bytes; embedded `publicKey` mismatch is `key_mismatch` (manifest.ts:314-324) | none                                                                                                                                                                                        |
| S      | `alg: "none"` or unknown alg                                             | Only `ed25519` verifies; others are recorded `unknown_alg` and never count (manifest.ts:301)                                                             | S1-011 fixed: `alg` is a token (`^[a-z0-9][a-z0-9-]{0,31}$`), unknown values parse and are ignored at verify; S1-032 fixed (cp-manifest enforces the same token pattern, `validate.rs:152`) |
| T      | Body edited after signing                                                | Signature over `"airplanemode-manifest-v1\n"                                                                                                             |                                                                                                                                                                                             | canonical(body)`; canonical form identical in TS and Rust (five shared vectors byte-identical, `cmp` exit 0) | none |
| T      | Canonicalisation ambiguity (digit keys, floats, lone surrogates, > 2^53) | Rejected at parse and again at canonicalisation on both sides                                                                                            | S1-008 accepted asymmetry on `1.0`/`1e3`; S1-014 fixed (calendar-valid timestamps on both sides); S1-033 fixed (vectors re-synced, control-plane gates green)                               |
| T      | Rollback to an older signed manifest                                     | SemVer 2.0 compare incl. prerelease; `createdAt` tie-breaker; `allowDowngrade` explicit                                                                  | S1-013 fixed (unreadable or unwritable state fails closed with reason `state`); S1-031 stored state not validated; state lives in origin storage (S1-006)                                   |
| R      | Publisher denies having signed                                           | Ed25519 is deterministic; `signedAt` is unauthenticated and never used                                                                                   | S1-002 no transparency log                                                                                                                                                                  |
| I      | Verification leaks document or user data                                 | Events carry only `manifestId`, `version`, `reason`                                                                                                      | none                                                                                                                                                                                        |
| D      | Huge or malformed manifest                                               | Malformed material never throws out of `verifyManifest`                                                                                                  | S1-016 fixed (4 MiB streamed cap, abort signal); S1-012 fixed (structural check first, attrs coerced)                                                                                       |
| E      | Test key accepted in production                                          | Trust set containing the RFC 8032 keyId refused unless `allowTestKeys` (TS) / `--allow-test-key` (cp-sign)                                               | none                                                                                                                                                                                        |
| E      | Compromised signing key                                                  | `expiresAt` by default from cp-sign                                                                                                                      | S1-001, S1-004 accepted                                                                                                                                                                     |

### 4.2 Asset manager (`runtime/src/asset-manager.ts`, `store/*`)

| Threat | Scenario                                                           | Control                                                                                                                                                  | Gap / finding                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Entry URL points at another origin or scheme                       | `isAllowedAssetUrl` + `allowedOrigins` before any fetch; `asset.download.blocked`; schema pattern bans every non-https scheme (asset-manager.ts:380-399) | none                                                                                                                                                                                                                                                                                         |
| T      | Host sends different bytes than the manifest hashes                | Streaming SHA-256; commit only when digest matches; `.part` removed on mismatch (asset-manager.ts:686-699)                                               | none                                                                                                                                                                                                                                                                                         |
| T      | Host answers a resume with a changed file                          | `If-Range` only with a strong ETag or Last-Modified; 200 restarts from zero; Content-Range start/total checked; part re-hashed                           | none                                                                                                                                                                                                                                                                                         |
| T      | Stored `.bin` altered after commit (co-tenant)                     | `getBlob` requires `verifiedAt`, compares size, optional `rehash`; mismatch drops the row                                                                | S1-006, S1-009 accepted; S1-018 IndexedDB size from metadata (open, Sprint 2)                                                                                                                                                                                                                |
| T      | Corrupted `part.json` or `index.json`                              | Drift in sha/size/url/chunkSize restarts; corrupt index parses to empty and `reconcile()` removes orphans, never promotes                                | S1-017 fixed (`validatePartState()` before resume and in `reconcile()`); S1-031 stored manifest state not validated                                                                                                                                                                          |
| R      | No record of what was served                                       | `asset.verify.ok`, `asset.evict`, `asset.reconcile` events in the ring buffer                                                                            | audit retention is a checklist item                                                                                                                                                                                                                                                          |
| I      | Events reveal URLs with tokens or document text                    | `newEvent()` strips query strings after `://`, refuses `prompt                                                                                           | text                                                                                                                                                                                                                                                                                         | content | document | ua  | userAgent` keys, caps 32 keys and 1024 chars | none |
| D      | Infinite or oversized body, wrong Content-Length                   | Oversize terminates within one chunk; Content-Length vs size; `MAX_RESTARTS`                                                                             | none                                                                                                                                                                                                                                                                                         |
| D      | Storage exhaustion                                                 | Proactive `makeRoomLocked` from `estimate()` plus reactive evict-and-retry on `QuotaExceededError` (bounded); pinned and held rows exempt                | S1-024 `estimate()` ignores CDP overrides (proof uses the reactive path); S1-019 fixed (`storeWrite()` maps every write); S1-035 IndexedDB usage under-reported so neither path fires in the harness; S1-036 a commit that fails after the one-chunk reserve discards the part (re-download) |
| D      | Two tabs download the same sha; one tab deletes what another holds | Web Locks per sha and on the index; refcounts exempt from LRU                                                                                            | S1-010 residual: refcounts per tab; S1-015 orphan race between commit and row write (open); S1-020 fixed (`evict()` refuses held or downloading unless `force`); S1-021 acquire gap (open)                                                                                                   |
| E      | Partial file served as an asset                                    | `readBlob` only reaches `<sha>.bin`; `.part/` never read by consumers; `ensure()` deletes an unverified `.bin` before download                           | none                                                                                                                                                                                                                                                                                         |

### 4.3 Capability profile and events (`capability.ts`, `events.ts`)

| Threat | Scenario                               | Control                                                                                                                                       | Gap  |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| I      | Device fingerprint                     | `details` allow-list (vendor, architecture, four numeric limits); `description`/`device` dropped; no `userAgent`; schema `propertyNames.enum` | none |
| I      | Session id becomes a user identifier   | Random UUID per page load, never persisted                                                                                                    | none |
| T      | Hostile `navigator` object throws      | Every read wrapped in `safeGet`; Proxy test in `test/capability.test.ts`                                                                      | none |
| D      | Listener throws inside `EventBus.emit` | Listeners are isolated with try/catch                                                                                                         | none |

### 4.4 dockit PWA skeleton (`index.html`, `public/sw.js`, `src/sw-logic.ts`, `src/trust.ts`)

| Threat | Scenario                               | Control                                                                                                                                                                                                           | Gap                                                                                                                    |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S/T    | Script injection                       | CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; ... frame-src 'none'; object-src 'none'; base-uri 'none'`, no `unsafe-inline`/`unsafe-eval`, no remote origin, `worker-src 'self'` without `blob:` | `frame-ancestors`, COOP/COEP, nosniff, Referrer-Policy need hosting headers (checklist)                                |
| T      | Service worker serves a tampered shell | Precache hashed with SHA-256 at install; mismatch deletes the cache and fails install; only status 200 + type basic cached                                                                                        | S1-023 fixed: `onVerifyFailure()` answers with the precached `offline.html` or a synthetic 503, never the network body |
| T      | SW caches model bytes or manifests     | Range, `/assets/*`, `*/manifest.json`, non-GET, cross-origin pass through                                                                                                                                         | none                                                                                                                   |
| E      | Trust-root loading from the network    | `TRUSTED_KEYS` is an empty frozen constant; no loader code                                                                                                                                                        | none                                                                                                                   |
| I      | Document content reaches the pipeline  | Stubs do not read bytes (`pdf.ts` records size and media type only); events module enforces the attrs rules                                                                                                       | none                                                                                                                   |

### 4.5 cp-sign and cp-manifest (control-plane)

| Threat | Scenario                                      | Control                                                                                                                                          | Gap                                                                                                                                                                                           |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I      | Seed printed or left in a world-readable file | `keygen` writes `key.secret` with `create_new` + mode 0600, prints the keyId only; seed in `Zeroizing`; tests assert no output contains the seed | S1-030 raw seed on disk, no passphrase/HSM (pre-pilot)                                                                                                                                        |
| T      | Overwrite of an existing key pair             | `keygen` refuses when either file exists                                                                                                         | none                                                                                                                                                                                          |
| S      | Seed file loaded as a public key              | Typed lines `ed25519-seed` / `ed25519-public`                                                                                                    | none                                                                                                                                                                                          |
| T      | Manifest signed without an expiry             | `--expires-days 365` written into the body before signing unless `--no-expiry`                                                                   | none                                                                                                                                                                                          |
| E      | Test key used for a real manifest             | `sign` and `verify` exit 1 with `refusing RFC 8032 test key` unless `--allow-test-key`                                                           | none                                                                                                                                                                                          |
| T      | Rust and TypeScript verifiers drift apart     | Shared vectors vendored byte for byte by `scripts/sync-fixtures.sh`; both sides test every vector and reason; cp-sign reproduces the example sig | S1-033 and S1-032 fixed in fix round 2: fixtures re-synced, `schema` reason mapped in `cli.rs:286`, `alg` token pattern identical on both sides; control-plane fmt, clippy and 46 tests green |

### 4.6 Supply chain and CI (all seven repos)

| Threat | Scenario                              | Control                                                                                                     | Gap                                                                     |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| T      | Mutable Action tag swapped            | Every `uses:` is one of the 13 SHAs in the pin table (verified, 0 misses)                                   | cargo-deny Action waits for a pinned SHA                                |
| E      | Fork PR runs with write token         | No `pull_request_target`; top-level and per-job `permissions: contents: read` (Pages and stats jobs scoped) | none                                                                    |
| T      | Install scripts run on `npm ci`       | `ignore-scripts=true`, `engine-strict=true`, `save-exact=true`; `deps:scripts` lists esbuild only           | S1-025 `legacy-peer-deps=true` in localdata; plugin-react pin deviation |
| T      | Transitive copyleft or yanked crate   | `deny.toml` allow-list; `cargo tree` sweeps empty; `preserve_order` absent in all Rust repos                | `cargo deny check` not yet run (tool not installed)                     |
| S      | Typosquat of the unreserved npm scope | README placeholder sentence; nothing published                                                              | owner action: reserve handles                                           |

## 5. Assumptions

- The browser is Chrome (Chromium) with OPFS, Web Locks and WebCrypto Ed25519; other browsers
  are not tested this sprint.
- The app is served from a dedicated origin over TLS with the headers in the pre-pilot checklist;
  the runtime cannot enforce either.
- The trust set is compiled into the app and changes only through an app release; key rotation is
  a release.
- No real model, document or customer data exists in any repo; all test inputs are synthetic
  (xorshift64* streams) and the only key material is the public RFC 8032 test vector.

## 6. Residual risk summary

No Critical or High finding was identified in Sprint 1 or in the two fix-round re-verifications.
The design puts the right things on the critical path (signature, hash, size, policy before use) and
the implementation follows the specified order. Fix round 1 closed S1-011 to S1-014, S1-016, S1-017,
S1-019, S1-020, S1-022, S1-023 and T1-B1; fix round 2 closed S1-032 and S1-033 (control-plane
parity and fixtures), S1-034 (API claims) and S1-035 (IndexedDB quota accounting, proven by T1 with
one eviction of b under a 1.5 GiB `quotaBytes` limit), each re-verified against the rebuilt code
(see `FINDINGS.md`, the two re-verification sections and "Sprint 1 close-out status").

What remains at close-out: the accepted design limits (S1-001 no revocation and S1-004 single
signature until the control plane exists; S1-005 browser clock; S1-006 and S1-009 same-origin
co-tenant trust), four Low hardening items deferred to Sprint 2 with D1 as owner (S1-015, S1-018,
S1-021, S1-031), S1-036 to Sprint 3, and two measurements that only the 8 GB Windows laptop can give
(S1-007: IndexedDB throughput and Chrome's real quota and origin-eviction behaviour; checklist row
13). None of the remaining items lets an attacker who controls the network or the asset host run
code, read documents or serve an unverified byte; all of them are availability, defence in depth or
key-management maturity. See `PRE-PILOT-CHECKLIST.md` for what the owner must do before a customer
laptop runs this code, and `README.md` in this directory for the publication and tagging verdict.

## 7. Sprint 2 update: engines, descriptors, the fallback chain and model hosting

Sprint 2 adds the first real inference path: backend adapter 0.2.0 with the model descriptor 0.1.0,
a Transformers.js adapter on two execution devices (WebGPU, WebAssembly), an opt-in Chrome
built-in model adapter, the fallback chain `loadWithFallback`, the runtime demo page `models.html`,
and the tooling that fetches, pins and serves models (`fetch-model.mjs`, `models.json`,
`ort-pins.ts`, `range-server.mjs`). Findings S1-051 to S1-063 are in `FINDINGS.md`, section
"Sprint 2 review". What does not change: the only bytes that feed an engine are bytes a trusted
manifest names, hashed in full after download and again just before hand-off.

### 7.1 New assets and trust boundaries

| Asset or boundary                                     | Why it matters                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model weights, tokenizer, configs, chat template      | They decide what the model says. A swapped tokenizer or chat template changes behaviour as surely as swapped weights; the chat template is executed by `@huggingface/jinja`. All are manifest entries with a sha256. |
| The ONNX Runtime wasm and its JS factory              | Native-speed code in the page. The wasm is a manifest entry of kind `wasm` pinned again by `ort-pins.ts`; the factory is application code imported from the page origin and pinned at build time (S1-059).           |
| The model descriptor                                  | A small signed entry that names every other file the engine gets. It is the new trust pivot: a descriptor that could name an entry from another manifest, or a URL, would bypass the per-file binding.               |
| The engine library (Transformers.js, onnxruntime-web) | Third-party code that, by default, fetches weights from Hugging Face, binaries from a CDN and caches them in Cache Storage. Boundary: the library is trusted to compute, not to choose what it loads or where from.  |
| The page's process-global engine settings (`env`)     | One object shared by every adapter instance in the page; a later write by any code changes where the engine looks.                                                                                                   |
| The Chrome built-in model                             | Google-controlled weights outside the signed manifest; `create()` in a non-ready state starts a third-party download.                                                                                                |
| The user's consent to download                        | Hundreds of megabytes to gigabytes on a metered or offline-first laptop; consent is part of the governance promise.                                                                                                  |
| The shared Pages origin `airplanemode-labs.github.io` | Six demos share one origin, so OPFS, IndexedDB, Cache Storage, Web Locks and quota are shared; the runtime demo now stores about 211 MB there after the download click.                                              |

### 7.2 STRIDE: engines and the verified-file shim (`src/backends/transformers.ts`, `verified-files.ts`, `ort-pins.ts`)

| Threat | Scenario                                                                                                    | Control                                                                                                                                                                                                                                                                                                   | Gap / finding                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S      | Engine fetches weights, tokenizer or config from Hugging Face, or the wasm from a CDN                       | `configureEnv` right after `import()`: `allowRemoteModels=false`, `remoteHost` sink, `localModelPath` = verified prefix, `env.fetch` = shim, `wasmPaths = {mjs}` without `wasm`, `wasmBinary` from the verified Blob; demo build rewrites the library's default endpoints; aborting network gate in tests | S1-060 flag-gated direct `fetch` inside the library                        |
| S      | A request the engine makes resolves to another origin, a `data:`/`blob:` URL or a path outside the file set | Shim: http(s) only, `origin === location.origin`, GET/HEAD, no `?`/`#`, exact `Map` lookup on the normalised pathname, 404 under the prefix, otherwise `egress_refused` and `backend.egress.refused` (origin only)                                                                                        | none                                                                       |
| S      | Cross-origin or query-carrying `ortFactoryUrl`                                                              | Resolved against the page, refused unless same-origin with no query or fragment, before the engine is imported                                                                                                                                                                                            | none                                                                       |
| T      | Stored file changed between verification and use (co-tenant, second tab, storage fault)                     | `acquire()` then `getBlob(id, {rehash: true})`; that same Blob goes to the shim; OPFS `File` snapshots become unreadable after modification (S1 Chrome probe); IndexedDB and memory Blobs are immutable                                                                                                   | S1-062 (verified); S1-009 now Mitigated for engine loads                   |
| T      | A different ORT wasm than the one tested is listed in a manifest                                            | `runtimeWasm` entry sha256 must equal `ORT_PINS[device].wasmSha256`, else `bad_descriptor` before any download; `gen-ort-pins --check` and `test/ort-pins.test.ts` against `node_modules`                                                                                                                 | S1-055 nightly build without provenance                                    |
| T      | Code in the page rewrites `env` between load and generate                                                   | `assertEnv` before every `pipeline()`, `generate()` and `embed()`: any drift is `backend` and nothing runs                                                                                                                                                                                                | Same-origin script is still trusted (S1-006)                               |
| T      | Two descriptors share a logical model id and the engine serves one's files for the other                    | Registry key is the descriptor ENTRY id; a conflicting sha256 under one key throws `bad_descriptor`; one transformers-js `load()` at a time                                                                                                                                                               | none                                                                       |
| I      | Engine error text (which can echo the prompt or a document) reaches events, UI or logs                      | R5: `AdapterError` messages are fixed strings; the engine's error only in `Error.cause`; events built from enums; `newEvent()` refuses prompt-like keys; demo `describeFailure` shows codes only                                                                                                          | Local-only `__models.diagnose()` returns engine text on loopback by design |
| D      | A model too large for the 4 GB wasm heap or the laptop's memory                                             | `minProfile` (`ramGb: 8`, tier) checked before download; descriptor size cap 64 KiB; `sessionOptions.graphOptimizationLevel` for Qwen3-1.7B                                                                                                                                                               | S1-061; 8 GB peak unmeasured (checklist row 20)                            |
| E      | The engine's native Node packages (onnxruntime-node, protobufjs) execute during install                     | `ignore-scripts=true`; browser build uses `transformers.web.js`; unit tests never value-import the engine                                                                                                                                                                                                 | S1-056 integrators without `ignore-scripts`                                |

### 7.3 STRIDE: descriptors (`src/backends/descriptor.ts`, `spec/model-descriptor.*`)

| Threat | Scenario                                                                         | Control                                                                                                                                                                                                                   | Gap / finding |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S      | A forged entry object (not the one in the loaded manifest) is passed to `load()` | `getEntry(entry.id)` on this AssetManager's single manifest must match sha256, size, kind and mediaType                                                                                                                   | none          |
| T      | Descriptor names a file from another manifest, a URL, or another descriptor      | `files[].entryId` must exist in the same manifest and must not be a descriptor; paths match the ModelFile pattern; `runtimeWasm`/`modelLib` must be listed and of kind `wasm`; `source` is provenance only, never fetched | none          |
| T      | Descriptor for another engine or device                                          | `engine === adapter.id`, `devices` includes `adapter.device`                                                                                                                                                              | none          |
| D      | Oversized descriptor (memory) or deep JSON                                       | Entry size <= 65536 checked before `acquire()`; blob size re-checked; strict canonical parse (no floats, bad keys, lone surrogates) and schema with `additionalProperties: false`                                         | none          |
| E      | A descriptor raises the device's profile requirements silently                   | `satisfies(profile, minProfile)` for the descriptor entry and every file entry, before any file download                                                                                                                  | none          |

### 7.4 The fallback chain and consent (`src/backends/chain.ts`)

Rungs run WebGPU, then WebAssembly, then (only with `allowBuiltin: true`) the Chrome built-in
model, then refuse with `BackendRefusedError`, whose `userMessage` is built from the rung and reason
enums only and says "Nothing was downloaded" only when no `asset.download.start` was observed
(since fix round 1; before it, only when no download was approved). Consent is asked
per rung with that rung's byte count; with no `beforeDownload` the chain is cache-only. Threats:
a download without consent (S1-053, Mitigated in fix round 1: the plan now counts a file only when
its verified row and a stored file of the manifest size both exist, so a vanished or truncated file
is asked for or declined. `acquire()` can still fetch a file that disappears between the plan and
the load, until `AcquireOptions.cacheOnly` lands in Sprint 3); a
misleading byte count (an upper bound until the descriptor is cached, S1-061: it over-asks, never
under-asks); an abort that silently falls through to a lower rung (aborts propagate, tested); a
failing rung that leaves files pinned (every handle is released; files become evictable, not
deleted).

### 7.5 The Chrome built-in model (`src/backends/chrome-prompt.ts`)

Outside the governance chain by design: its bytes are not in a manifest and are never hashed, its
quality and its telemetry are Google's, and `create()` in the `downloadable` or `downloading` state
would start a download from Google. Controls: off by default (`allowBuiltin` false), and while off
neither `availability()` nor `create()` is called (the demo's plan does not call `available()` on
that rung either); when on, `create()` only after `availability() === 'available'`; `model.load`
carries `verified: false` so audit trails can tell the two apart. Residual: once a user enables it,
prompts go to a model the lab does not govern; a pilot policy must decide whether regulated
deployments may enable it at all (checklist row 22).

### 7.6 Model hosting and the shared Pages origin

The runtime demo bundles the Apache-2.0 test model SmolLM2-135M-Instruct (about 182 MB of ONNX plus
tokenizer and configs) and the pinned ORT wasm under `models/`, signed per build with a key that
exists only inside the Pages job; the public half is compiled into the page. Nothing is fetched
before the download click; after it only same-origin `models/*` requests happen. Threats and
controls: a tampered Pages artefact or CDN cache (every file is hashed against the signed manifest;
a mismatch is refused, and the trust root and the files are served together, so this proves the
verification path, not publisher identity, as S1-040 already records); a co-tenant demo on the same
origin that is compromised by script injection could delete or overwrite the stored model files
(the rehash on hand-off turns tampering into a refusal; deletion is availability only) or exhaust
the shared quota (S1-041); GitHub Pages limits on a 182 MB file, its bandwidth cap and its Range
behaviour are unverified until the first deploy (checklist row 19). The planned production model
Qwen3-1.7B (1.43 GB WebGPU, 1.74 GB WASM) is never hosted on Pages or in any demo; it was loaded
once in the local D1-09 smoke run from the loopback range server behind the aborting network gate.
A pilot bundle needs its own licence package (checklist row 17).

### 7.7 WebLLM staging rules for Sprint 3 (informative, carried from the Sprint 2 plan)

WebLLM loads weights through the Cache API and fetches model libraries itself, so the shim
approach does not apply unchanged. Before any WebLLM code lands: staged Cache API keys are exactly
`${location.origin}${BASE_URL}__airplanemode/verified/<descriptor entry id>/resolve/main/<path>`,
written from verified Blobs only; only those exact keys are deleted (`cache.delete(url)`), never
`caches.delete(name)`, because the origin is shared; `appConfig` is built from scratch, never from
`prebuiltAppConfig`, and contains no Hugging Face or GitHub URL; `cacheBackend` is `'cache'` and
cross-origin storage is off; the model library (`modelLib`) is a manifest entry of kind `wasm`
pinned like the ORT wasm; zero network requests may reach the staging prefix (the aborting gate
proves it); and the staged keys are removed after load. The real Qwen3-1.7B q4f16 MLC library needs
about 2 GB of VRAM (`vram_required` 2036.66 MB), which is a Sprint 5 measurement.

### 7.8 Prompt injection through documents (row only; Sprint 5)

Not reachable this sprint: dockit has no inference, and the runtime demo sends only what the user
types. When dockit gains retrieval and inference (Sprint 5), a document becomes untrusted input to
the model (OWASP LLM01), and model output becomes untrusted input to the page (LLM02: rendered with
`textContent` only, never executed, never used as a URL or a storage key without validation). There
are no tools or function calls; adding any requires its own review (checklist row 16).

### 7.9 Residual risk after Sprint 2

No new Critical, High or Medium. Fix round 1 closed the glyphsift input cap (S1-051), the build id
check (S1-052), the fail-open hold query (S1-054, now fail closed with an `asset.hold.unknown`
warning), the install-script note (S1-056), the control-plane vector sync (S1-057) and the runtime
Chrome install in CI (S1-058). Still open: consent enforcement at the asset layer (S1-053,
Mitigated, Sprint 3) and the onnxruntime-web nightly without provenance (S1-055, Sprint 3), plus
the Info item S1-066. Fix round 2 closed the Chrome install in localdata and dockit CI (S1-064),
the glyphsift installer drift (S1-065) and the install-script wording (S1-067).
Each has an owner and a target; none
lets an attacker who controls the network, a model host or the engine library put unverified
bytes in front of an engine or reach a third-party origin from the runtime demo.

## 8. Sprint 3 update: the engine worker, the DevTools extension, packaging and WebLLM staging

Reviewed 14 November 2026 (findings S1-068 to S1-077 in `FINDINGS.md`, "Sprint 3 review"; S1-072 and
S1-073 Fixed and S1-078 to S1-080 added in "Sprint 3 fix round 1 re-verification").

### 8.1 New assets and trust boundaries

- **The engine worker** (`src/worker/*`, started by `src/backends/worker-adapter.ts`). A fresh dedicated
  module worker per `load()`, booted from a `blob:` URL whose source is one static import of a same-origin
  worker script. It runs Transformers.js and ONNX Runtime and is treated as **untrusted**: it holds the
  prompt and the verified model bytes but may only answer through validated messages (R13). Its network
  function is the verified-file shim behind the egress guard (R3w). The page keeps the trust decisions:
  R1 (descriptor), R2 (acquire and re-hash) and every event are built on the page.
- **The worker message boundary.** Page to worker: the init message with the same Blob objects that
  `getBlob(id, {rehash: true})` returned, the absolute verified prefix and the ORT factory URL, both
  resolved and origin-checked on the page. Worker to page: plain payloads only (phase, memory, ready,
  token, done, error code, egress origin), each checked for type, keys, ranges and enums.
- **The Trusted Types policy** `airplanemode-worker` (one per page, exact-URL Set) is the only way a
  script URL reaches `new Worker()` on `models.html`.
- **The DevTools hook and extension.** `exposeDevtoolsHook()` (opt-in, only the demo calls it) puts a
  frozen `{version, snapshot()}` on the page global; the MV3 extension (zero permissions, `connect-src
'none'`) reads it with one constant expression through `inspectedWindow.eval`. The page is untrusted
  from the extension's side; the extension is a same-machine developer tool from the page's side.
- **Packaged artifacts.** npm tarballs (runtime, glyphsift, localdata, pagetriage) and macOS arm64 wheels
  (glyphsift, pagetriage), proven offline from locally built files. Registry names are still unreserved.

### 8.2 STRIDE: engine worker and egress guard

| Threat                 | Scenario                                                                                                                  | Control                                                                                                                                                                                                                                                                                                                                                          | Residual                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | The engine (or a dependency) posts messages pretending to be the runtime, or forges phases, memory figures or error codes | R13 validator: exact key sets, enums, finite ranges, a phase at most once per load, unknown type or bad shape = crash and terminate; error codes outside AdapterErrorCode become `backend`; `cause` dropped                                                                                                                                                      | A hostile engine can still report false but in-range numbers (timings, memory), and a host-grammar `egress.origin` (S1-074)                                                                                      |
| Tampering              | Bytes reach the engine that were not verified                                                                             | Page re-hashes and posts the same Blobs; worker checks `blob.size === entry.size`; the shim serves only registered verified files; engines start only if the guard sentinel is present                                                                                                                                                                           | OPFS snapshot TOCTOU fails closed (S1-070); own-`fetch` shadowing inside the worker (S1-072) is Fixed: `self` always owns a locked `fetch`; an unreadable posted Blob is reported as `integrity` (S1-073, Fixed) |
| Tampering              | A crafted `workerUrl` injects code into the bootstrap                                                                     | `resolveWorkerUrl` (same origin, http(s), no query or fragment, safe character set) runs before `URL.createObjectURL`; source is `import <JSON.stringify(abs)>;`; TT policy accepts only URLs in its own Set                                                                                                                                                     | None found                                                                                                                                                                                                       |
| Information disclosure | The engine sends the prompt or document text off the device                                                               | Guard replaces `fetch` on every prototype owner and refuses XHR, WebSocket, WebSocketStream, WebTransport, EventSource, importScripts, Worker, SharedWorker, `serviceWorker.register`, `Cache.add`/`addAll` (locked, non-configurable); `import()` and FontFace are stopped by the inherited CSP (S1-068, S1-069); `connect-src 'self'`                          | On Pages the CSP is a meta tag (row 23 for pilots)                                                                                                                                                               |
| Information disclosure | Prompt or document text reaches events, the DevTools snapshot or the DOM                                                  | Only token and result text reach the app; events built on the page from enums and validated numbers; sentinel tests (fuzz, T1 privacy scan)                                                                                                                                                                                                                      | S1-074 (origin host channel, on-device only)                                                                                                                                                                     |
| Denial of service      | The engine hangs, crashes or floods messages                                                                              | 250 ms abort-then-terminate; crash path on `error`/`messageerror`; size caps on token (64 Ki chars), result (8 Mi chars), cause (10 k chars); holds, bootstrap URL and session released after every terminate                                                                                                                                                    | A hung WASM decode step is ended only by terminate (the model must be reloaded)                                                                                                                                  |
| Elevation of privilege | Later engine code undoes the guard                                                                                        | Replacements `writable:false, configurable:false`; guard is the first import, has no side-effect imports, `sideEffects` keeps it in consumer bundles, a sentinel test checks the order in the built worker; `self` owns a locked `fetch` even where only `WorkerGlobalScope.prototype` did (S1-072, Fixed in fix round 1; `defineProperty` throws in Chrome 157) | None known in JS beyond `import()` and FontFace (S1-069)                                                                                                                                                         |

### 8.3 STRIDE: DevTools extension and hook

| Threat                 | Scenario                                                                                               | Control                                                                                                                                                                                                                                                                                                | Residual                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Spoofing / Tampering   | A hostile page shows fake figures in the panel                                                         | Every event schema-validated; text-only rendering                                                                                                                                                                                                                                                      | The panel shows what the page asserts (S1-076); not an audit record (checklist row 25) |
| Elevation of privilege | A hostile page runs code in the extension (HTML in strings, getters, Proxy, huge or throwing snapshot) | Constant expression reading through property descriptors (getter counter 0); size and type rechecked in the extension; JSON parsed there; `createElement`/`textContent` only with an attribute allow-list; extension CSP `default-src 'none'; script-src 'self'; connect-src 'none'`; zero permissions | None found                                                                             |
| Information disclosure | The extension leaks page data                                                                          | No permissions, no background, no content scripts, `connect-src 'none'`                                                                                                                                                                                                                                | None found                                                                             |
| Information disclosure | The hook exposes events to other same-origin scripts or extensions with host access                    | Opt-in only; events carry no prompt, output, document text, storage key or value; `ns` and `model` documented as visible                                                                                                                                                                               | Applications must keep personal data out of namespaces and entry ids                   |
| Denial of service      | A snapshot that never returns                                                                          | One read in flight, a waiting state after 5 s, polling only while shown                                                                                                                                                                                                                                | The page's own main thread is blocked by its own code                                  |

### 8.4 Packaging and install

Install proofs never touch a registry name: tarballs install with `--offline --ignore-scripts` from an
empty cache, wheels with `--no-index --no-deps` (and `uv --offline`), so an unreserved placeholder name
cannot be squatted into these proofs. The packages carry no lifecycle scripts, source maps, test data or
weights; the runtime's engine peer is optional and never installed by default. Residual: the names stay
squattable until the owner reserves them (checklist row 8), and none of our packages carries registry
provenance until the owner publishes (row 15).

### 8.5 WebLLM staging (design only; not landed)

R11 is specified but no WebLLM code or dependency exists. The design keeps verified bytes in
origin-wide CacheStorage between `cache.put` and the engine's read, which on a shared origin is
reachable by every co-hosted app (S1-071, extending S1-041). Before the rung lands: re-verify in the
worker or require a dedicated origin (checklist row 24); keep the loadId-scoped keys, the Web Lock, the
sweep that spares locked loadIds, deletion on every exit path, the headroom check and the rule never to
call `caches.delete(name)`; T1 must show 0 requests to the staging prefix and to any model host.

### 8.6 Residual risk after Sprint 3

No open finding is Critical, High or Medium. The engine now runs isolated per load with its network
locked down to verified files, and the two defence-in-depth gaps found in the review (S1-072, S1-073) are
Fixed after fix round 1. What remains is a documented reliance on the inherited CSP for `import()` and FontFace (S1-069), an on-device text channel
through the egress origin (S1-074) and the WebLLM staging design (S1-071), which gates that rung. The
hosting-level controls (headers, dedicated origin, COOP/COEP) and the 8 GB measurements remain pre-pilot.

Close-out addendum (14 November 2026, after the tester round 2 results): the independent T1, T2 and
T3 re-runs found no control regression. The new close-out findings sit in the packaging and provenance
boundary of section 8.4, not in the engine or storage boundaries: an artefact can be redistributed without
the third-party licence texts of what it links (S1-082), and a public provenance statement can drift
from the pin the code enforces (S1-083). Both are tampering-adjacent in the STRIDE sense only as
repudiation of provenance: the enforced digests are correct and verified at load. The mitigation is the
same pattern used for the manifest contract: a test that ties the human-readable record to the machine
check, so neither can change alone. Throwaway signing keys in evidence folders (S1-081) remain the one
information-disclosure item at the edge of the trust boundary, outside every repository.

## 9. Sprint 4 update: manifest spec v0.1, the Tamper lab and the localdata vector index

Review date: 14 November 2026. Findings: `FINDINGS.md`, "Sprint 4 review". WebLLM was cut from Sprint 4
(TD-08), so section 8.5 is unchanged and S1-071 stays the gate for that rung.

### 9.1 Manifest spec v0.1 (manifest 0.1.1, published)

What changed at the trust boundary: the manifest contract is frozen on wire `airplanemode.manifest/0.1`
(`spec/MANIFEST.md`). Additions are a duplicate-member rule (a repeated JSON member at any depth is
`invalid_json`, so every parser acts on the same value; S1-087), an explicit S < L check before the
Ed25519 verify in both implementations, a normative reason precedence, refusal of all five RFC 8032
section 7.1 keys by keyId and by raw bytes unless `allowTestKeys === true` (TD-22), and 15 tamper
vectors plus three asset-tamper cases.

| Threat      | Scenario                                                                                                      | Control                                                                                                                                                                                      | Residual                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing    | A manifest signed with a public test key is trusted in production                                             | Trust set refused before parsing when it holds a test keyId or test public-key bytes; strict boolean opt-in; AssetManager refuses before any fetch; cp-sign refuses to sign with a test seed | S1-089: a non-`Map` trust object whose iterator throws defeats the pre-scan; fix pending                                                                         |
| Spoofing    | A signature from an untrusted key is presented with a trusted keyId or an embedded publicKey (tamper-04, -05) | Trust set is application configuration, never fetched; embedded `publicKey` informational only and must equal the trusted bytes; keyId recomputed from the trusted key                       | No revocation and no transparency log (MANIFEST.md Security considerations)                                                                                      |
| Tampering   | Two parsers read different values from one document (duplicate members)                                       | Duplicate scan before `JSON.parse` (runtime) and a strict visitor (cp-manifest); identical verdicts on S1's 10-variant probe                                                                 | None known                                                                                                                                                       |
| Tampering   | A malleable signature (S + L) verifies in one engine and not another                                          | S < L checked before WebCrypto and before `verify_strict`; tamper-15                                                                                                                         | None known                                                                                                                                                       |
| Tampering   | Rollback or replay of an older validly signed manifest (tamper-08, -09)                                       | Downgrade state keyed by manifest id, written only after a valid signature and a passed check; fail closed on an unreadable store                                                            | First-use and per-profile: a fresh profile accepts any older version; without `expiresAt` replay is unbounded; `allowDowngrade` lowers the stored state (S1-091) |
| Tampering   | Mix-and-match: a validly signed manifest for another product is served                                        | Consumer duty stated in MANIFEST.md (check `manifest.id`); pre-pilot checklist row 26                                                                                                        | No `expectId` option until Sprint 5                                                                                                                              |
| Tampering   | Asset bytes flipped or truncated after a valid manifest (tamper-assets)                                       | Full-file hash before any consumer read; `getBlob` rejects; no blob: URL; one request per flipped asset                                                                                      | Integrity is relative to the signed manifest; the trust root is configuration                                                                                    |
| Repudiation | `signedAt`, `alg`, `keyId` are relied on as authenticated                                                     | MANIFEST.md lists them as unauthenticated; only `createdAt` and `expiresAt` are authenticated                                                                                                | Browser clock trusted for `expiresAt`                                                                                                                            |

The Tamper lab (`demo/tamper-lab.ts`) is a demonstration surface with its own trust set (named RFC test
keys only), a literal `allowTestKeys: true` in that module only, in-memory downgrade state and a fresh
memory asset store per case. It cannot be driven from the URL, storage or a pasted root, writes nothing
persistent and fetches only same-origin fixture files. Its label reads demo-only. Its risk is
confusion, not compromise: a visitor might read "Accepted" for the test-signed case as an endorsement of
test keys. The label and the library default (`false`) cover that.

S1-074 (closed): the worker's egress report crosses the page boundary as a bare `{type:'egress'}`. The
page records `origin: 'worker-reported'`, `reporter: 'worker'`, its own adapter id and a 1-based count,
at most 16 per load. No worker-provided string enters an event, without exception.

### 9.2 localdata vector index (0.2.0-alpha.0)

Assets:

- Embeddings (f32 vectors), chunk values (document text in a pilot) and keys, stored per namespace in
  OPFS (or IndexedDB) under the reserved driver namespace `'__ld_vec.' + ns`. Embeddings are
  invertible enough to leak document content and must be treated as the document.
- Index integrity: the HEAD record (segment table, tombstones, generation) and the immutable vector,
  META and value parts. Query results drive what a later pipeline (dockit, Sprint 5) puts in front of a
  model.
- Availability of the tab: JS heap, WebAssembly linear memory (about 160 MB for 100,000 x 384), and the
  origin's storage quota.

Actors:

- A1, a same-origin script: on GitHub Pages every Airplane Mode Labs demo shares one origin (S1-041), and
  any XSS or malicious dependency on the origin can read and rewrite every namespace.
- A2, someone with the OS account or the browser profile (another user of a shared laptop, malware, a
  forensic image): reads the files at rest and can edit them, recomputing CRC-32C.
- A3, the author of a document that is chunked, embedded and indexed (hostile input to the pipeline).
- A4, a second tab of the same app (not hostile, but concurrent).
- A5, the browser itself: eviction, quota, crashes, torn writes.

Controls:

- Parser: every HEAD and META field from storage is untrusted. `ldvec/src/format.rs` computes lengths in
  checked `u64` (wasm32 `usize` is 32 bits), checks the HEAD size cap and exact length before reading the
  segment table, bounds counts (4,096 segments, 4,194,304 rows, 131,072 rows per segment, keys <= 4,096
  bytes per row, values <= 1 MiB) before they size anything, and validates META offsets and UTF-8. The FFI
  range-checks every pointer and alignment; a trap discards the instance (S1 probe: 19 lying HEADs and
  200,000 CRC-fixed mutations, 0 panics; T2: over 3.2 million native and 12,000 WASM cases per module).
- Memory: `maxIndexBytes` (default 1 GiB) is checked against the HEAD's declared vector and META bytes
  before any WebAssembly block is allocated, and each part's actual length must match before it is
  copied into linear memory; an allocation failure is `quota_exceeded` `wasm_memory`, never a trap.
- Integrity: CRC-32C per segment (vectors, META) and per value, checked on read; any structural or
  checksum failure is `corrupt` with `details {ns, file, reason}`, sticky for that HEAD until `clear(ns)`
  or a new HEAD, and no hit is ever returned from a corrupt index.
- Crash safety and concurrency: immutable segments with fresh segIds, HEAD written last; all-or-nothing
  `putVectors`; Web Lock from the HEAD re-read through the HEAD put; OPFS `refreshIndex` under the lock;
  generation overflow refused. Per-index driver namespaces (S1-086) so indexes never share `keys.json`.
- Isolation: callers cannot name a `__ld_` namespace; the ns grammar forbids `/` and a leading `_`.
- Privacy: no key, filterPrefix, vector component, score or value in `storage.*` events or in any vector
  `StorageError` (message, details, JSON); a bad row is identified by its position (`details.row`).
- Egress: `localdata/src` has no network API; the demo CSP is `connect-src 'none'` and adds only
  `'wasm-unsafe-eval'`.

| Threat                 | Actor      | Scenario                                                                                      | Control / status                                                                                                                                                                                                                      |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information disclosure | A1, A2     | Read embeddings, chunks and keys at rest                                                      | Not prevented: stored unencrypted (README Limitations, verbatim). Mitigations are hosting (dedicated origin), full-disk encryption and OS login (checklist rows 11, 12). Encryption at rest needs a key-custody design (deferred).    |
| Tampering              | A1, A2     | Rewrite parts and recompute CRC-32C to change rankings or values                              | Not prevented: CRC-32C detects accidental corruption only (README states it). A structurally valid edit is indistinguishable from a write. A signed or MACed index needs a key on the device, which A1 and A2 can reach; not planned. |
| Tampering              | A3         | Index poisoning: a crafted chunk ranks first for many queries, or carries instructions        | Not prevented by a flat index (README states it). Recorded for the Sprint 5 retrieval and prompt-injection review (section 7.8, checklist row 16): provenance of each hit, per-document caps, and treating retrieved text as data.    |
| Denial of service      | A1, A2     | A crafted HEAD or part exhausts memory or traps the kernel                                    | Bounded by the parser and `maxIndexBytes` before WebAssembly allocation; traps discard the instance. Residual S1-092: an oversized file is read whole into the JS heap before its length is checked.                                  |
| Denial of service      | A1, A2, A5 | A damaged `keys.json` or an evicted origin makes the index disappear                          | Eviction removes the whole origin (README). Residual S1-092: an unparseable `keys.json` reads as "no index" (empty results) instead of `corrupt`.                                                                                     |
| Tampering              | A4         | Two tabs write the same or different namespaces                                               | Web Lock plus `refreshIndex`; browser test with two pages: all rows, 0 corrupt. A custom driver without `refreshIndex` is single-writer (README; checklist row 27). Readers in other tabs are stale until reopen.                     |
| Information disclosure | A1         | Keys, prefixes or scores leak through events or error messages to a log or the DevTools panel | Sentinel tests over events and StorageErrors; the panel does not read localdata in Sprint 4.                                                                                                                                          |

Non-goals for 0.2.0-alpha.0 (recorded, not gates): confidentiality or integrity against A1 or A2;
poisoning resistance; multi-writer custom drivers; compaction, quantisation and HNSW (HNSW needs a
build-or-adopt security note first, Sprint 6); behaviour under memory pressure on an 8 GB laptop,
Windows Defender scanning of OPFS files and Windows eviction (owner measurement).

### 9.3 Packaging and CI (Sprint 4 delta)

glyphsift's artefact-building CI jobs now install tools by hash (`pip --require-hashes
--only-binary=:all:`) or from a lockfile with integrity (`npm ci --ignore-scripts`), and every cargo and
maturin build uses `--locked` (S1-079 closed; S1-093 is a pagetriage test job without it). No workflow
publishes, and write permissions stay in the Pages deploy jobs. The remaining packaging gap is
attribution, not integrity: the MIT notices of crates compiled into the wheels and the glyphsift tarball
(S1-090).

### 9.4 Residual risk after Sprint 4

No open finding is Critical, High or Medium. The manifest contract that the paid product will rest on
is published with negative and tamper vectors that both implementations pass identically. The one new
verifier finding (S1-089) is a fail-open edge that needs application misconfiguration twice over. The
vector index adds the largest new asset so far, document-derived data at rest, and its protection
depends on the origin and the device, not on the library: same-origin isolation on a dedicated pilot
origin, full-disk encryption and OS login are the controls, and the README says so. Retrieval poisoning
becomes reachable when a model answers over retrieved chunks (Sprint 5) and is the first item of that
sprint's review.

### 9.5 Close-out after fix rounds 1 and 2 and the tester round 2 results

This subsection supersedes the statements in 9.3 and 9.4 that S1-089 and S1-090 are open: both were fixed in fix
round 1 (the test-key refusal fails closed for any trust object that is not a plain `Map`; the MIT texts ship in
the pagetriage wheel and the glyphsift wheel and tarball, TD-28). Findings: `FINDINGS.md`, "Sprint 4 fix round 1
re-verification", "Sprint 4 fix round 2 re-verification" and "Sprint 4 close-out after the tester round 2
results".

Manifest spec v0.1 was amended in place twice before it leaves this machine (TD-26, TD-29), so the frozen
contract is the amended one: strict SemVer 2.0 with numeric identifiers of any size, the Signature schema applied
to every `signatures[]` item at the schema stage (a malformed untrusted signature beside a valid trusted one
refuses the whole manifest), explicit `null` refused, undeclared members of any name refused, canonical padded
base64 only for `sig` and `publicKey`, and an explicit forbidden-character set for `url`. From the owner's push
onward a change to what is accepted or refused needs a new wire string.

| Threat    | Scenario                                                                                                                        | Control / status                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tampering | Unsigned data rides in a validly signed manifest through a prototype-named member (`__proto__`) and steers `pin` or `chunkSize` | Fixed (S1-099): own-property checks in the schema, null-prototype canonical objects, shared negative vectors; TypeScript and Rust agree on every prototype-related name at every level.                                                                                                                                  |
| Tampering | Two verifiers disagree on a signature encoding, a url character or a large SemVer number, so one accepts what the other refuses | Fixed (TD-26, TD-29, S1-095): one accepted base64 spelling, an explicit url set, digit-string SemVer comparison; differential sweeps over every Unicode scalar value, 318,000 base64 strings and 20,009 SemVer pairs show 0 differences. The only remaining asymmetry refuses on both sides (S1-008, parse-stage order). |
| Spoofing  | A signed entry url is a network-path reference (`//host/a.bin`) that leaves the manifest's origin or downgrades to http         | Runtime control holds: the resolved URL passes `isAllowedAssetUrl` and `allowedOrigins` before any fetch (S1-097). The spec sentence that every consumer must re-check the resolved URL is Sprint 5; checklist row 30.                                                                                                   |
| Tampering | A prototype-named KV key or stored value in localdata loses its accounting row or chooses the prototype of the value read back  | Open, Low (S1-100, S1-101; Sprint 5). Needs a prototype-named key chosen by the app, or a same-origin writer (S1-006) that can already rewrite the value. `clear(ns)` still deletes everything; vector rows are unaffected. Checklist row 29.                                                                            |
| Denial    | A manifest whose id is `constructor` cannot be loaded by the persistent AssetManager                                            | Open, Info (S1-102; Sprint 5). Fails closed (`state`), no state written.                                                                                                                                                                                                                                                 |

Residual risk after Sprint 4 (final): no open finding is Critical, High or Medium. The verification path that
the paid product rests on has been probed by three independent differentials and the 13-case Tamper lab in real
Chrome with no accept-versus-refuse difference left. The largest residual risks are the ones no library can
remove: document-derived data at rest in the browser profile (dedicated origin, disk encryption and OS login
are the controls), the absence of key revocation and a transparency log (S1-001, S1-002, short `expiresAt` in
pilots), and retrieval poisoning and prompt injection, which become reachable when a model answers over
retrieved chunks in Sprint 5. Nothing has been measured on the 8 GB laptop, so memory-pressure behaviour (WASM
growth failure, tab discard), Windows Defender scanning of OPFS files and Windows eviction remain unknowns for
the owner's runbook.

## 10. Sprint 5 update: the dockit pipeline (PDF to answer, offline)

Sprint 5 makes dockit answer a question over a PDF: read, triage (pagetriage WASM), extract (pdf.js), gate
(glyphsift WASM), chunk, embed (multilingual-e5-small q8), index (localdata documents API), retrieve (top 4),
generate (Qwen3-0.6B q8, single-threaded WebAssembly). Findings: `FINDINGS.md`, "Sprint 5 review". Everything here
was reviewed on the Apple M5 Pro; nothing on 8 GB or Windows.

### 10.1 Assets and trust boundaries

| Asset                                   | Where it lives                                                                                          | Who can read or change it                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The PDF the user chooses                | A `Blob` in the page; copied once into the pdf worker; never stored, never in Cache Storage             | The page and its workers (same origin)                                                                           |
| Extracted text, chunks, embeddings      | Memory store by default; with "Keep on this device", OPFS namespace `dockit.d<docId>` under `__ld_doc.` | The page; with the opt-in, anyone with the browser profile or OS account, and any same-origin script (six demos) |
| Source SHA-256 and docId (first 32 hex) | Same as chunks (kept documents only)                                                                    | Same; the hash confirms whether a known document was processed (S1-112 c)                                        |
| The question and the answer             | Page memory and the DOM only; never stored, never in an event                                           | The page                                                                                                         |
| Model files                             | Origin-wide OPFS store `airplanemode-runtime`, content-addressed, re-hashed in the worker on every load | Any same-origin page can evict (S1-108); no page can make the worker accept other bytes (R15)                    |
| Verified manifest bytes                 | IndexedDB `dockit`/`manifest`, re-verified on every load                                                | Same-origin writer can corrupt it (fails closed `manifest_refused`), cannot forge it                             |
| Trust root                              | Compiled into the build (`src/generated/trust-root.ts`, git-ignored), one key per build                 | Build only; never fetched, never stored                                                                          |
| Precache                                | Cache Storage `dockit-precache-<build hash>`, hashed on fill, scope `/dockit/`                          | Same-origin writer can replace an entry (S1-109)                                                                 |

New boundaries: (B1) PDF bytes into pdf.js and pagetriage (parser attack surface); (B2) document text into the
model prompt (prompt injection); (B3) model text into the DOM (output handling); (B4) the pdf and analysis workers
back to the page (untrusted responses; the analysis client validates and restarts on error or timeout).

### 10.2 STRIDE: dockit pipeline

| Threat      | Scenario                                                                                                                            | Control / status                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tampering   | A hostile PDF exploits pdf.js (font program, JBIG2, XFA, scripting)                                                                 | pdfjs-dist 6.5.438 (past CVE-2024-4367); text extraction only (`getPage`, `getTextContent`); no rendering, no fonts, no XFA, no eval (`unsafe-eval` absent from the CSP the worker inherits); a fresh worker per document, terminated afterwards; the worker's egress guard allows only `<base>pdfjs/`. Re-pin rule: row 32.                                                                                                                                                |
| Denial      | A decompression bomb exhausts memory                                                                                                | Content-stream bombs: pagetriage caps a stream at 64 MiB and the page is refused before pdf.js. Font-program or XObject bombs: NOT bounded (S1-107, Low): pdf.js inflates them whole in under a second, so the 60 s timeout does not help. Impact is the user's own tab.                                                                                                                                                                                                    |
| Denial      | Encrypted, corrupt, oversize or very long PDFs                                                                                      | 20 MiB from `File.size` before any read; 300 pages; `onPassword` refused and never answered; per-page and per-document text caps; analysis and pdf workers terminated on error or after 60 s.                                                                                                                                                                                                                                                                               |
| Tampering   | Prompt injection in a chunk forges a turn (`<\|im_end\|>`, `<\|im_start\|>system`), closes the source wrapper, or forges a citation | S-PI-1 sanitiser with the loaded tokenizer's added tokens, the generic `<\|...\|>` pattern, `<source` openers, `[S#]`, tag and bidi characters, to a fixed point; sources wrapped with dockit-issued ids and pages; system rule that sources are untrusted data; the question sanitised too. Residual: the model may still follow instructions in text (it is a 0.6B model); the answer is one text node and the sources panel shows the chunk text, so a reader can check. |
| Info. disc. | Injected text makes the answer exfiltrate (a link, an image URL, markup, a form)                                                    | No sink can act on the answer: one text node, no markdown, no auto-link, no `href`/`src` from model or PDF text (grep test); `img-src 'self'`, `connect-src 'self'`, `form-action 'none'`, `frame-src 'none'`; zero egress after the cache phase is the backstop (CDP counter over every target; e2e `injection.pdf` test).                                                                                                                                                 |
| Spoofing    | A forged citation points the reader at the wrong page                                                                               | Only `[S<n>]` for a retrieved id maps to a page, taken from the chunk's metadata; unknown ids are dropped and counted; the sources panel shows the chunk text itself.                                                                                                                                                                                                                                                                                                       |
| Tampering   | Retrieval poisoning: a chunk crafted to rank first for many questions                                                               | Not prevented (flat brute-force index); one document per question limits it to the document the user chose. A held chunk (glyph gate) is never indexed.                                                                                                                                                                                                                                                                                                                     |
| Elevation   | A tool call or function from model output                                                                                           | No tools argument is ever passed; nothing parses the answer.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Tampering   | Model file swapped in OPFS after download                                                                                           | R15: worker re-hashes every engine-readable file (8 kinds) against the signed manifest entry before the engine gets a byte; the engine reads exactly the hashed snapshot (method ii); `integrity` on any mismatch, never retried (S1-070 closed).                                                                                                                                                                                                                           |
| Spoofing    | Another product's or demo's signed manifest, or an entry URL into a sibling project on the shared origin                            | `expectManifestId` (`unexpected_id`); distinct ids per bundle; resolved entry URLs must stay under `<base>models/` (S1-097); `allowedOrigins` is the page origin; no remote fallback.                                                                                                                                                                                                                                                                                       |
| Repudiation | Events reveal document content                                                                                                      | Events carry counts, timings and enums only; `dockit.d<docId>` is emitted as `dockit.d*`; forbidden attr keys are a TypeError; e2e scans every event for the fixture strings.                                                                                                                                                                                                                                                                                               |
| Info. disc. | Someone with the browser profile reads kept documents                                                                               | Memory by default; opt-in only, with the warning; Delete runs `clear(ns)` (physical removal). Stored unencrypted: disk encryption and OS login are the controls (rows 11, 28).                                                                                                                                                                                                                                                                                              |
| Tampering   | A same-origin co-tenant poisons the service worker cache or evicts dockit's model                                                   | Accepted for the demo under S1-006 (all co-tenants are this lab's strict-CSP pages): S1-109 (persistent code swap until the next build), S1-108 (availability only). Pilot: own origin (rows 5, 33).                                                                                                                                                                                                                                                                        |
| Spoofing    | dockit framed by another site (clickjacking)                                                                                        | `window.top !== window.self` refuses document and model actions and shows a link; `frame-ancestors` needs a response header (row 4).                                                                                                                                                                                                                                                                                                                                        |

### 10.3 Supply chain for the demo bundle

The bundle is signed at build time by an Ed25519 key that exists only in memory during `bundle-models.mjs`; the
public half is compiled into the page. This proves that the manifest and the files came from the same build, not
who built them; it is not pre-pilot row 1. Models: Qwen3-0.6B q8 from `onnx-community/Qwen3-0.6B-ONNX` at
`79346d370dfae34801d26993fda9ae2372900fd0` (Apache-2.0 from the base `Qwen/Qwen3-0.6B` card; the ONNX repository
carries no licence metadata) and multilingual-e5-small q8 from `Xenova/multilingual-e5-small` at
`761b726dd34fb83930e26aab4e9ac3899aa1fa78` (MIT from the `intfloat/multilingual-e5-small` card). Every file's
sha256 equals the HF LFS oid (or its git blob id matches) in the committed tree fixture. dockit's `pages.yml`
builds the four siblings from the SHAs in `deps.lock.json`, with per-job permissions and no secrets; the first
real deploy is the only check of the Pages size and timeout limits (row 19).

### 10.4 Residual risk after Sprint 5

No Critical, High or Medium finding is open. The pipeline's design keeps a hostile document inside the tab: the
model's output has no sink but a text node and the network is closed after the cache phase, so the realistic
harms are a wrong answer that the source panel lets the reader catch, and a memory-exhaustion crash from a hostile
PDF (S1-107). The demo inherits the shared-origin limits of GitHub Pages (S1-108, S1-109, missing response
headers), which a pilot removes with its own origin. Unmeasured: memory on the 8 GB laptop (about 7 GB summed RSS
during a question on the Apple M5 Pro, row 20), Chrome's behaviour when a worker exhausts memory, and every Windows
path (`--out` containment, the PowerShell sampler) until the owner's push and runbook.

### 10.5 After Sprint 5 fix round 1

- Spoofing of the model bundle, trust-set side (S1-113, Low): the TypeScript `verifyManifest` passes any 32-byte
  trust key to WebCrypto, and both Chrome (BoringSSL) and Node (OpenSSL) accept `S = 0` forgeries under a
  small-order key, so a trust set that ever held one would accept a manifest nobody signed; cp-manifest
  (`verify_strict`) refuses. No shipped or deployable build carries such a key (the dockit stub trust root is
  all zeros but lives only in stub builds, where every runtime call throws). Mitigation planned: manifest 0.1.3
  makes the refusal normative and adds a weak-key vector set to the parity table (pre-pilot row 1).
- Denial of service through a hostile PDF (S1-107, Low): a content-stream bomb is now refused as `too_large`
  before extraction; a compressed font program is still inflated by pdf.js (observed 8,275 MiB peak summed RSS on
  the Apple M5 Pro, page usable; not measured on 8 GB).
- Tampering across co-tenant demos (S1-108): explicit eviction now refuses dockit's pinned rows unless forced;
  a user who unpins and evicts on the runtime demo still removes them, and dockit fails closed offline.
- Information disclosure at rest (S1-112 c, BUG-S1-S5-01): the README and the Keep warning now say what a kept
  document stores (chunk text, embeddings, page numbers, the file's SHA-256), and a Chrome test proves Delete
  leaves no `__ld_doc.dockit.d<docId>` files after a reload and that the memory-only default leaves nothing.

### 10.6 Sprint 5 close-out (after fix round 2 and the tester round 3 results)

The model above holds as built; no STRIDE row changed its verdict. What the close-out adds:

- Re-load after Stop (spoofing and tampering of the model bundle): Stop ends the engine worker, and the next
  question re-loads from the device. That path re-verifies the stored manifest (S-OFF-1), re-hashes every
  engine-readable file in the worker (R15) and pins `expectManifestId`; a flipped stored-manifest digit gives
  `manifest_refused` and a flipped cached byte gives `integrity`, each with 0 model bytes used and 0 requests (T1
  round 3). The re-load is not a second, weaker trust path.
- Repudiation and audit (S1-119, Info): a Stop after the first token leaves no `model.generate` event and dockit
  logs the partial answer as `ok`. The device-local event record is therefore not yet an audit record (row 6).
- Elevation through build tools on Windows (S1-116, Info): the symlink-escape refusals of `bundle-models` and
  `fetch-model` are proven on macOS; on Windows their tests skip rather than fail if no link can be made. Inputs to
  both tools are the owner's own, so this is a proof gap, not an attack path.
- Supply chain (S1-117, S1-118, Info): one unhashed, unpinned test-only install in a read-only pagetriage CI job,
  and two glyphsift release-evidence gaps that let a claim rest on a run that did not test what it names. Neither
  affects a shipped artefact today, because nothing is published; both gate a publish.
- Information disclosure through events (S1-120, Info): the privacy test that proves stored values never reach an
  event can flake on a random UUID; no leak was found (420 events scanned in Chrome, 0 fixture strings).
- Denial of service (S1-107, Low): final figure 8,121 MiB peak summed RSS for a 1 GiB font bomb on the Apple M5 Pro,
  page usable. On the 8 GB laptop the realistic outcome is a tab or worker crash, not a data loss; it stays a pilot
  gate (row 32).
- Memory headroom (not a finding): the Chrome process tree peaks at about 6.5 to 6.9 GB per question with
  Qwen3-0.6B on the Apple M5 Pro. On an 8 GB laptop memory pressure is the most likely failure, and a tab discard
  mid-answer must fail closed (no partial answer shown as complete, see S1-119). Not measured on 8 GB.

Unproven on this Mac and proven only after the owner's push: the Windows `--out` containment in pagetriage and
glyphsift with real links and junctions, the runtime Windows path test and Linux zero-network gate, the dockit
Pages deploy limits, and the live demos' CSP as served.
