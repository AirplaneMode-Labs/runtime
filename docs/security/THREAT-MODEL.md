# Threat model: Airplane Mode Labs runtime and the Sprint 1 surface

Version 0.2 (Sprint 1, 9 to 22 November 2026; updated after fix round 1 on 9 November). Written by the security consultant (lane S1).
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
