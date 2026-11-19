# Changelog

All notable changes to `@airplanemode/runtime` are recorded here. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/). Nothing is released yet; the package version is
`0.3.0-beta.1` and no tag exists. The open contracts have their own log in `spec/CHANGELOG.md`.

## [0.3.0-beta.1] - 2026-11-19 (untagged)

Runtime `0.3.0-beta.1` on spec release 0.6.0 (Sprint 6): memory hardening of the engine, the weak-key refusal and
the Sprint 5 leftovers. Nothing is tagged or published (no tag, no publish); it is still not tag-ready (TD-30):
the three-OS CI read, the 8 GB benchmark and a real signing key are open. Every figure comes from one Apple M5
Pro with 48 GB: not measured on 8 GB. Version decided in TD-69.

### Added

- Spec release 0.6.0 (D1-02; `spec/CHANGELOG.md` has the detail): manifest 0.1.3 (`weak_key_refused`,
  `WEAK_KEY_REFUSED_MESSAGE`, the Weak keys section, the Pinned entries note of TD-54, the `minProfile.ramGb` sentence
  of TD-57), capability profile 0.1.1, event 0.1.5, storage API 0.4.0 (the HNSW index kind) and backend adapter 0.5.0
  (R16 to R20). The vectors `weak-keys/` (26 rows, 20 refused across every class) come from
  `test/tools/make-weak-key-vectors.mjs`, an independent computation; every 0.5.0 vector is byte-identical.
- The weak-key refusal (S1-113, TD-68, TD-82): `isWeakEd25519PublicKey` (`src/ed25519-point.ts`, BigInt Edwards
  arithmetic, no dependency) and `assertNoWeakKeys`. A trust set that holds the identity, a small-order or a
  mixed-order point, a non-canonical encoding or bytes that are not on the curve is refused with
  `weak_key_refused` BEFORE the manifest is parsed, with no option to skip it, in `verifyManifest` and in the asset
  manager's `loadManifest`, and again for the key a signature actually uses, so a Map that hides keys from its
  iterator is still caught. 1,000 Node-generated keys are all accepted; 64 keys are checked in about 30 ms.
- Unload that frees the model (R16, B1): `unload()` resolves only after `worker.terminate()` returned and every
  handle is released, and emits `model.unload` (adapter, model, device, host, loadId, reason `unload`, `abort`,
  `error` or `out_of_memory`; durationMs from the call to `terminate()` returning). Measured with SmolLM2-135M in
  installed Chrome (`test/browser/model.spec.ts`, `docs/memory-options.md`): the process tree shrank by 944.9 MiB,
  130 percent of the load's WebAssembly peak of 726.7 MiB, and the engine worker target was gone (not measured on
  8 GB).
- Out of memory (R18): an allocation failure inside the engine (a RangeError that mentions memory or allocation,
  `std::bad_alloc`, `Aborted(OOM)`) is classified inside the worker into the code enum only and is
  `AdapterError('out_of_memory')`; the worker is terminated, the holds are released, nothing is retried, no part or
  cache entry changes, and no worker string reaches an event (a sentinel test). `model.load.failed`, `model.embed`
  and `model.generate` (finishReason `error`, attr `code`) carry the code.
- A load after an unload is a first load (R19): every load re-acquires the files and re-hashes them in the worker;
  `test/unload.test.ts` proves three cycles give three verify phases and that `cacheOnly` reaches every acquire, with no
  request after the first load.
- The engine memory options (R17): on the wasm device the worker host creates sessions with `enableCpuMemArena` false
  and `enableMemPattern` false. They reach ONNX Runtime and the greedy output is token-identical, but their measured effect is
  nil (onnxruntime-web 1.31.1 already treats an unset option as false; the worker's WebAssembly peak is 726.7 MiB with and
  without), so they are not a memory saving (`docs/memory-options.md`).
- `capability.ts` clamps `ramGb` to at most 8 (TD-57); `scripts/bundle-models.mjs` keeps the dockit answer model at
  `minProfile.ramGb` 4 (TD-67) and refuses to emit any `ramGb` above 8.
- The demo: Tamper lab case 15, a weak trust key (the exact reason `weak_key_refused`, 0 requests after the refusal);
  an Unload button on the models page that shows the `model.unload` event and the engine worker count before and after
  and no operating-system memory figure; the not-yet box and the Sprint 6 status line.
- `docs/engine-load-retry.md` (the finding below) and `docs/memory-options.md`; `test/browser/opfs-snapshot.spec.ts`.

### Changed

- A trust set that holds a 32-byte value that is not a prime-order point is now refused (`weak_key_refused`), so a
  placeholder such as 32 bytes of `0x07` no longer works as a stand-in key (it did not verify anything before, but it
  was accepted into a trust set). Every key made by key generation is unaffected.
- `npm run ci` now builds before it tests (the pack-figure test needs `dist/`).
- README: the tarball figures are stated as "about N KiB in F files (U B unpacked)" and pinned to a fresh
  `npm pack --dry-run` by `test/pack-figure.test.ts` (T3-R2-05, TD-81): the file count and the unpacked bytes are exact
  (every text file is LF by `.gitattributes`), the packed size is within 1 KiB; the status line and the done-when sentence
  are Sprint 6's (T3-R2-06).
- A Stop after the first token whose abort the worker does not answer in time now emits `model.generate` with
  finishReason `abort` before `model.unload` (S1-119); an abort that the worker answers in time already did.
- Version `0.3.0-beta.1` (TD-69).

### Fixed

- S1-121: the weak-key and test-key rules judge the trust value by its bytes: any 32-byte ArrayBuffer view or
  ArrayBuffer, from this realm or another (vm context, iframe), is copied to a same-realm Uint8Array before the
  test-key, weak-key, key_mismatch and verify steps. A cross-realm identity key is now weak_key_refused.
- BUG-T1-S6-02 / BUG-T3-S6-05 (TD-84): satisfies() treats profile ramGb 0 as unknown, not below a minimum; only a
  reported smaller value fails. Wording in spec/manifest.ts and MANIFEST.md (schema unchanged).
- BUG-T3-S6-06: the out-of-memory test cites the real evidence file name.
- Spec 0.6.0 amended in place (versions unchanged): storage.query fallback `short`, `HNSW_MAX_GRAPHS` = 64 with
  quota reason `max_graphs`.

- T3-R2-06: the README Status section carries the TD-51 sentence 'build done on Apple M5 Pro 48 GB; 8 GB Windows
  done-when NOT met (owner runbook step 5)', and `test/docs.test.ts` fails if it is missing.
- S1-119: a Stop after the first token emitted no `model.generate` event on the 250 ms backstop path; it now emits
  exactly one, with finishReason `abort`, outTokens and a numeric firstTokenMs (`test/run-control.test.ts`).
- S1-116: the symlink-escape tests of `bundle-models` and `fetch-model` can no longer skip silently. `makeLink`
  (`test/helpers.ts`) makes a junction on win32 (no privilege needed) and a symlink elsewhere, and a link that cannot be
  made FAILS the test naming the OS and the error; `test/links.test.ts` proves it and that the only skip left is the
  env-gated `RUNTIME_BUNDLE_REAL` describe. On macOS `npm run ci` reports skipped 1. windows-latest should show skipped 1
  after the owner's push; at 4f5b011 it already did (`check (windows-latest)` of run 44325725878: 1694 passed, 1
  skipped), so the two tests had run there; only that CI leg proves it again.
- R20 (the engine-load retry, D1-07): a file that changed after the shim's one-byte probe failed in the middle of the
  engine's own read and was reported as `backend`; when the load fails with a plain engine error the worker now reads one
  byte of every hashed snapshot again, and an unreadable one is `integrity`, never retried. The root cause of the retry
  itself was investigated and NOT reproduced: see `docs/engine-load-retry.md`.

### Security

- S1-113: the weak-key refusal above; a forged signature (R = identity, S = 0) under a trust set holding the identity key
  is now unreachable (`spec/vectors/weak-keys/forged-identity.manifest.json`).
- R18: the out-of-memory classification reads the engine's message only inside the worker; the host emits the code and
  nothing else, and the new tests inject a RangeError whose message holds a sentinel and find it in no event, no
  `AdapterError` message and no cause.
- R19 and R20: a re-load re-verifies everything, and a snapshot that changed is `integrity`.

### Known gaps

- S1-036 stays an accepted residual, with the reason: keeping the downloaded part when a commit fails after the
  evict-and-retry loop needs a different commit (the OPFS store deletes each chunk as it is streamed into `<sha>.bin`, so the
  transient overhead is one chunk). Keeping the chunks until the final file is closed would double the storage a commit needs
  at exactly the quota edge the T1-B1 fix was written for, so it is not a small change; the next `ensure()` downloads the
  asset again. Availability only; no unverified byte is exposed.
- The engine-load retry root cause is not established (`docs/engine-load-retry.md`); dockit's one retry stays, and a note
  for D5 says the same failure may now arrive as `out_of_memory`.
- The memory options (R17) have no measured effect on this stack; they are not counted as a saving.
- What only windows-latest or ubuntu-latest can prove stays pending the owner's push: S1-116 (skipped 1, symlink tests
  executed through a junction), T3-R2-05 (the pack figure on Windows) and the measured unload drop on Linux.
- Not measured on 8 GB: every figure in this file and in the README. The out-of-memory behaviour on real low-memory
  hardware and `deviceMemory` as a real 8 GB device reports it are owner measurements.

## [0.3.0-beta.0] - 2026-11-18 (untagged)

Runtime `0.3.0-beta.0` on spec release 0.5.0 (Sprint 5): the first beta. Nothing is tagged or published
(no tag, no publish). It is not tag-ready (TD-30): the three-OS CI read, the 8 GB benchmark and a real
signing key are open. Not measured on 8 GB.

### Added

- Worker host `embed()` resolves with fresh, plain, non-shared `Float32Array` copies, finite-checked again after
  the copy (BUG-T2-S5-06), so a shared, offset or subclass view held by the worker cannot change afterwards.
- Spec release 0.5.0: manifest 0.1.2 (the verifier option `expectId` and the reason `unexpected_id`; the
  asset manager option `expectManifestId`; S1-097 and S1-102 as normative sentences; the Demo bundles rules),
  event 0.1.4 (`model.embed`, `model.memory`, `storage.doc.*`, `DOCKIT_EVENT_NAMES`, `PIPELINE_STAGES`,
  `PIPELINE_REASONS`), storage API 0.3.0 (the documents API), backend adapter 0.4.0 (embed, R4b, R14, R15).
  The vectors `expect-id/`, `state-ids/` and `tamper/tamper-base.json`; every 0.4.0 vector is byte-identical.
- Embeddings through the worker host (R14): `embed(texts, opts)` with the EMBED limits, host-side validation
  of the worker's answer, `model.embed`, abort that leaves the worker usable.
- In-worker integrity (R15, S1-070): the worker hashes every file the engine can read before the engine sees a
  byte; the `verify` phase event comes from the worker; the page no longer calls `getBlob(id, { rehash: true })`
  on the worker load path.
- A token budget (R4b): `budget`, `context_overflow` before decode, finishReason `length` at the budget, Stop
  after the first token keeps the partial text, an abort before it rejects `aborted`.
- `model.memory`: the peak WebAssembly.Memory the worker could read, per phase (load, generate, embed), or
  `unavailable`; never estimated.
- `@airplanemode/runtime/worker-support`: `installEgressGuard({ allowPathPrefixes })` and
  `startModuleWorker(url, { policyName })`.
- `scripts/bundle-models.mjs` (bundle-models): the demo model bundles (`dockit` and `runtime-demo`), a manifest
  per set with a distinct id, no `expiresAt`, every engine-readable file an entry, signed by a key that lives
  only in memory; pins for Qwen3-0.6B q8 and multilingual-e5-small q8 checked against the Hugging Face LFS oids.
- DevTools panel: Storage (source localdata) and Pipeline (source dockit) sections.
- The demo: an Embed card, a 14th Tamper lab case (a manifest for another product), the budget and finish
  reason, a Sprint 5 status line.
- Local model run (`RUNTIME_MODEL_QWEN06=1 npm run test:model`): Qwen3-0.6B answers one prompt and
  multilingual-e5-small embeds, with load time, first token, wasm memory and the Chrome process-tree RSS peak
  (Apple M5 Pro 48 GB; not measured on 8 GB).

### Changed

- `AssetManager.evict(entryId)` now refuses a pinned row (`AssetError 'store'`, "asset is pinned"; S1-108,
  TD-54) unless called with `{ force: true }`; `evictToFit` and quota eviction already skipped pinned rows.
  The runtime demo shows the refusal as text. Tests on the memory, IndexedDB-fake and OPFS-fake stores.
  The spec sentence follows in the next spec patch (no re-land this round).
- The demo's build label follows the convention: 'Built from main at <sha12>' in CI, 'Local build <sha12>[-dirty]'
  from git HEAD otherwise, and 'Local build local (no .git checkout)' when there is no .git.
- README: the Benchmarks 8 GB column reads "not measured on 8 GB" in every cell; the CI status line names the
  pushed head 3bf53c6 and the red run 43667709960.
- Version `0.3.0-beta.0`. README: the Sprint 5 status line, What beta means, the Limitations (not measured on
  8 GB; re-hashing by host).
- The demo's `index.html` policy is `connect-src 'self'` and its paste-a-manifest field accepts the page's own
  origin only (TD-47; S1-039 re-opened and closed).
- `fetch-model.mjs` follows redirects itself, only to https and at most five hops.
- `ci.yml` and `pages.yml` install with `npm ci --ignore-scripts`.
- Abort before the first token now rejects `aborted` (it resolved an empty `abort` before); the tested
  behaviour is in `test/budget.test.ts`.

### Fixed

- `devtools-hook.test.ts` compared `src\devtools-hook.ts` with `src/devtools-hook.ts` on windows-latest (run
  43667709960): the test now uses POSIX-form paths (`test/helpers.ts` `toPosix`, `relPosix`) and has a test that
  feeds backslash paths so the fault reproduces on macOS.
- `test/browser/model.spec.ts` expected the Event 0.1.2 attrs of `backend.egress.refused` and failed on
  ubuntu-latest (run 43667709960); it was a stale assertion, not an egress defect. The expectation is shared
  with a Node unit test, and a second probe runs inside the engine worker. The failure had skipped five
  serial tests, so the zero-network gate for them had never run on CI.
- S1-102: a validly signed manifest whose id is `constructor` never verified, because the downgrade state was
  looked up on a plain object; every store now returns null-prototype index objects and the lookup is an own-member lookup.
- T3-R2-05: the README packed-size figures quoted an earlier tarball (221,709 B); they now match a fresh
  `npm run pack:check` of this tree: 222,230 B in 37 files, 775,106 B unpacked, on macOS arm64.

### Security

- S1-097 (the resolve-and-recheck rule for entry urls) and S1-102 are normative in `spec/MANIFEST.md`.
- S1-070: file hashing moved into the worker, and the bytes served are the bytes hashed.
- The signing key of the demo bundles is generated in memory and never exported: no file, no log line, no
  private-key PEM header and no PKCS#8 prefix (a test greps the bundle, stdout and stderr).
- The worker-support guard refuses everything outside the allowed same-origin path prefixes.

## [0.2.0-alpha.1] - 2026-11-14 (untagged)

Sprint 4 (alpha): manifest spec v0.1 published in runtime/spec (committed; public after the owner's push) as
spec release 0.4.0, a verifier that meets it, a Tamper lab in the demo, the Stop button, and the Sprint 3
carry-overs that fit. Nothing is published, tagged or reserved. WebLLM: not yet (cut from Sprint 4; revisit
after the Sprint 5 measurement), so it is neither added nor claimed.

### Added

- Spec release 0.4.0: manifest 0.1.1 (**published**, "manifest spec v0.1": the standalone `spec/MANIFEST.md`),
  the status vocabulary and the release numbering rule, 19 new manifest negatives (32 in all: six with the TD-26 amendment and nine with TD-29), 15 tamper
  vectors with `tamper.json`, 3 signed asset manifests with `expect.json` (normative and informative
  fields), 6 new descriptor negatives (20 in all, the last with TD-29), storage API 0.2.0 and event 0.1.3 (the contracts
  localdata implements), backend adapter 0.3.1 and model descriptor 0.2.1; `SPEC_RELEASE`, `SPEC_STATUS`,
  `RFC8032_TEST_PUBLIC_KEYS_HEX`, `RFC8032_TEST_KEY_IDS`, `MANIFEST_REJECT_PRECEDENCE` and
  `DESCRIPTOR_REJECT_PRECEDENCE`; `spec/CHANGELOG.md` has the detail (D1-01, S1-074, S1-075,
  BUG-T2-S3-22, BUG-T2-S3-23-R2).
- `verifyManifest()` takes the manifest text as well as an object: text goes through the repeated-member
  scan first, and a truncated or non-JSON text is `invalid_json` (D1-02).
- `test/tamper-vectors.test.ts`: every tamper row and every negative row through `verifyManifest()` with a
  spy downgrade store (0 writes for a refused manifest, exactly one for the accepted rotation), the three
  asset manifests on fresh memory stores (0 bytes to a consumer, `getBlob` rejects, no `blob:` URL), the five
  test keys by key id and by bytes, and the S < L boundary (D1-02).
- The demo's **Tamper lab** (`demo/tamper-lab.ts`, `demo/tools/tamper-fixture.mjs`): thirteen cases run the
  real verifier and asset manager over bytes copied verbatim from the spec vectors (the build fails if a
  copy's sha256 differs), each showing the refusal reason, the per-signature reasons, the stage and
  "Requests after refusal: N"; its own trust set (two RFC 8032 public test keys), downgrade state and
  memory stores, nothing shared with the page or with persistent storage. Browser proof in installed Chrome:
  `test/browser/tamper.spec.ts` (D1-03).
- The **Stop** button on the backend page (`demo/run-control.ts`): enabled only while the model answers,
  fires the existing `AbortController`, and the read-out says "Stopped" with the time to stop; the loopback
  test parameter `?maxTokens=` lengthens an answer for the browser test (D1-04).
- `assertTestKeysAllowed()`, `isNonCanonicalS()` and `parseJsonText()` are exported (D1-02).
- `pack:check` calls `verifyManifest()` on tamper-01 from the installed tarball (it prints
  `no_valid_signature`), scans every shipped file for builder paths and checks that `spec/MANIFEST.md` ships
  (D1-05).
- `test/manifest-fix2.test.ts`, `test/out-dir.test.ts` and `test/browser/out-dir.ts` (fix round 2, TD-29): every
  undeclared member name through `verifyManifest()` and `parseDescriptor()` at the top level, in entries,
  `minProfile`, signatures and descriptor objects; `canonicalize()` of an own `__proto__` member; all 64 last
  base64 characters of `sig` and `publicKey`; every BMP code point against the forbidden url set; the nine new
  manifest negatives and the descriptor negative; the sha fixture `test/fixtures/spec-frozen-before-fix2.sha256.txt`
  (the 5 positives, the 13 + 4 + 6 earlier negatives, `tamper/`, `tamper-assets/`, `storage-api.ts`, `event.ts`
  stay byte-identical).
- `decodeBase64()` is exported from `src/manifest.ts` (internal; not part of the package entry point), and
  `spec/manifest.ts` exports `SIGNATURE_SIG_PATTERN`, `SIGNATURE_PUBLIC_KEY_PATTERN` and `ENTRY_URL_PATTERN` so that
  dockit re-vendors the patterns (TD-29).

### Changed

- S1-074: `backend.egress.refused` carries the host's own adapter id, a `reporter` (`main` or `worker`), an
  `origin` (`new URL(x).origin` computed by the page, `'null'` when opaque; the fixed string
  `worker-reported` for a worker report) and, for a worker report, a `count` of 1 to 16 per `loadId`; later
  reports are dropped. The worker's text is validated for shape and discarded, so no worker-provided string
  reaches an event (D1-02, S1-074).
- The reason of a refusal follows the precedence list: parse stage, then `bad_spec`, `bad_url`, `schema`,
  `unsorted_entries`, `duplicate_entries`, `expired`, `no_valid_signature`, `downgrade`; a descriptor's is
  parse stage, `bad_spec`, `schema`, `unsorted_files`, `duplicate_paths`, `unsorted_devices`. `unsorted_entries`
  now wins over `duplicate_entries` wherever the duplicate sits, and a signature `alg` that is a string but
  not a token (`ED25519`) is a `schema` fault before any signature is examined (D1-02).
- The demo's not-yet boxes say WebLLM is "not yet (cut from Sprint 4; revisit after the Sprint 5 measurement)"
  and list Windows and 8 GB no-GPU measurements, embeddings through the worker host, revocation of a signing
  key and an expected-id check; the root page shows its status line (D1-05).
- The test helpers' second key (`OTHER_*`) is no longer an RFC 8032 key, because all five of those are now
  refused unless `allowTestKeys` (D1-02).
- Manifest 0.1.1 is amended in place before the first push (team decision TD-26; still release 0.4.0 and
  wire string `airplanemode.manifest/0.1`): `Manifest.version` and `ManifestEntry.version` take the strict
  SemVer 2.0 grammar (`SEMVER_PATTERN`, new in `spec/manifest.ts`), the downgrade-state reader uses the same
  grammar, and `verifyManifest()` applies the published Signature schema to every `signatures[]` item. A
  malformed signature member is therefore `schema` (it used to be a per-signature `malformed_sig` or
  `malformed_key_id`, or went unnoticed for `signedAt`); the two per-signature reasons stay defined for a
  signature object that did not pass the schema. `parseSemver()` returns `bigint` for the numeric parts
  (BUG-T2-S4-02, BUG-T2-S4-04).
- Fix round 2 (TD-29), the last amendment of manifest 0.1.1 before the first push (still release 0.4.0, same wire
  string; the contract is frozen from the owner's push on): `schema.ts` decides which members are declared and which
  required members are present by OWN-property tests (`Object.hasOwn`), never `in`; `canonicalize()` builds
  null-prototype objects whose members are defined as own data properties; `checkParsed()` refuses an object whose
  prototype is neither `Object.prototype` nor null; `sig` is `^[A-Za-z0-9+/]{85}[AQgw]==$` and `publicKey`
  `^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`, and `decodeBase64()` refuses any input whose re-encoding differs; the
  forbidden url characters are an explicit list written as `\uXXXX` ranges (no `\s`). Nine manifest negatives take
  `negative.json` from 23 to 32 rows and `neg-proto-member` takes the descriptor vectors from 19 to 20; the five
  positives, the 13 + 4 + 6 earlier negatives, `tamper/`, `tamper-assets/`, `storage-api.ts` and `event.ts` are
  byte-identical, and all 15 tamper rows keep their tabled result.
- Six new manifest negative vectors take `negative.json` from 17 to 23 rows (`neg-version-leading-zero`,
  `neg-version-empty-prerelease-id`, `neg-null-optional`, `neg-sig-unknown-member`, `neg-sig-bad-signedat`,
  `neg-precedence-digitkey-nosigs`); the five positives and the 17 earlier negatives are byte-identical.

### Fixed

- BUG-T2-S4-11 (high): a validly signed manifest could carry unsigned data under a member named `__proto__`,
  `constructor`, `toString`, `hasOwnProperty` or `valueOf`. The schema validator tested members with `k in props`
  (inherited `Object.prototype` names counted as declared, so `additionalProperties: false` did not apply) and the
  canonicaliser assigned `out[key]` on a plain object (an own `__proto__` member set a prototype and was dropped
  from the signed bytes), so `verifyManifest()` returned valid and a consumer reading `entry.pin` or
  `entry.chunkSize` could get a value no signature covers. Any undeclared member of any name is now `schema` in a
  manifest (top level, entries, `minProfile`, signatures) and in a descriptor, matching cp-manifest.
- BUG-T2-S4-14: non-canonical base64 (non-zero pad bits) in `sig` and `publicKey` was accepted by the TypeScript
  verifier (`atob` ignores the bits) and refused by Rust; one spelling per signature and key is now accepted.
- BUG-T2-S4-15 and S1-095: the entry url character class was `[^\s?#]` in the TypeScript schema and a different
  list in cp-manifest (Unicode spaces refused by one, ASCII controls by the other); the forbidden set is now one
  explicit list in MANIFEST.md and the schema.
- S1-096: the browser specs and the Playwright configs resolved their default results folder against the working
  directory, so `RUNTIME_MODEL=1 npm run test:demo` wrote `tamper-lab.png`, `tamper-results.json` and the run JSON
  files into the parent Projects folder. The default is `runtime/test-results/` (git-ignored), resolved from the
  file's own directory (`test/browser/out-dir.ts`); nothing is written outside the repository unless a
  `RUNTIME_*_OUT` variable says so.
- T3-S4-OBS-01b: the README's CI paragraph says "tests-first evidence Done (red/green logs); local macOS green; CI
  on three OSes configured, pending the owner's push" for the Sprint 4 work.
- BUG-T2-S3-22: a webllm descriptor with the wire string `airplanemode.model/0.1` is a `schema` fault
  (branch C pins `airplanemode.model/0.2`) (D1-01).
- S1-075 and BUG-T2-S3-23-R2: duplicate `devices` in a descriptor have a shared vector (`neg-dup-devices`)
  and are `schema` in every implementation (D1-01).
- T3-S3-035: the comment at the top of `test/spec-0.3.test.ts` cites `evidence/sprint-3/D1/red-D1-01.log`,
  not a scratch path (D1-04).
- A rung skipped because `cacheOnly` found no stored file says "the file is not stored on this device
  (cache-only mode)"; "the download was not approved" is used only when the user actually declined
  (D1-04).
- `make-vectors.mjs --check` no longer reports the `descriptor/` directory as an unexpected file, and the
  spec CHANGELOG's `[0.1.0]` date is the date of its commit (2026-11-09) (D1-01).
- A document nested 20,000 levels deep is a `schema` rejection, not a `RangeError` (D1-02).
- BUG-T2-S4-04: a version such as `01.0.0` or `1.0.0-a..b` was schema-valid but unreadable by the
  downgrade-state reader, so one accepted manifest locked its id into reason `state`; both now use the
  strict grammar.
- BUG-T2-S4-05: `compareSemver()` compares numeric identifiers exactly (`bigint`), so a patch or numeric
  prerelease identifier above 2^53 no longer compares equal to its neighbour and lets a rollback through.
- BUG-T2-S4-02: the parse stage covers `signatures[]` (a digit-leading key, a float or a lone surrogate
  inside a signature is the parse reason) and an extra member, a missing member or a bad `signedAt` in a
  signature is `schema`, matching control-plane's text path.
- BUG-T2-S4-03: a missing or non-array `signatures` member is judged after the parse stage, so a document
  with such a member and a digit-leading key reports `digit_key` (`MANIFEST_REJECT_PRECEDENCE` holds).
- S1-089: `assertTestKeysAllowed()` fails closed (a trust object that is not a `Map`, or whose iteration
  throws, is `test_key_refused`), and the signature loop refuses a trusted test key by key id or raw bytes
  for the key it actually uses.
- S1-091: `spec/MANIFEST.md` says `allowDowngrade` is an explicit rollback that lowers the stored state and
  must be reachable only from an authenticated admin action (documentation only).
- BUG-T2-S4-10: `spec/storage-api.md` says the 1024 UTF-16-unit key rule dominates for vector keys and 4096
  bytes is the on-disk bound (prose only; `storage-api.ts` and `event.ts` are untouched).
- T1-S4-02: after Stop terminates the worker, "Download test model and load" is enabled again (and after a
  run that reports the engine is not loaded), so the message that points at it is actionable; one click
  reloads from the stored files with 0 B downloaded (`test/browser/stop.spec.ts`).
- BUG-T3-S4-03: `docs/security/FINDINGS.md` no longer cites a scratch folder, quotes no removed wording in
  the S1-085 row and records that the localdata and glyphsift trailer commits exist only on stale
  `origin/dependabot/*` branches (deleting them is an owner step).
- BUG-T3-S4-07: `NOTICE` names no package version; the README byte counts equal `pack:check`.

### Security

- All five RFC 8032 section 7.1 test keys are refused in a trust set, by key id and by raw key bytes under
  any key id, before anything is parsed, unless `allowTestKeys === true` (a strict boolean: the string
  `'true'` is refused); `AssetManager` refuses before it opens its store or fetches the manifest, and its
  constructor refuses a non-boolean `allowTestKeys` (TD-22; D1-02).
- Test keys fail closed: a hostile or non-`Map` trust object cannot hide a test key from the refusal, and
  JSON text whose value is a string is `schema` (the inner text is never parsed a second time, which
  would have skipped the repeated-member scan) (S1-089, TD-26).
- A repeated member name at any depth is `invalid_json`, so a signature over the parsed value cannot pass
  for a document whose first member differs from the one signed (D1-02).
- A signature with S >= L is `bad_signature`, checked before WebCrypto so the verdict does not depend on
  the browser engine (D1-02).
- The downgrade state is written only after a valid signature and a passed downgrade check: a spy store
  records 0 writes for every refused vector (D1-02).
- The Tamper lab never shares the page's trust roots, downgrade state or persistent stores; the browser test
  finds no `tamper-base` state and no asset part in OPFS or IndexedDB afterwards (D1-03).

## [0.2.0-alpha.0] - UNRELEASED (not tagged, not published)

Sprint 3 (alpha): contracts 0.3.0, cache-only at `acquire()`, the integrity reason, observability and a
DevTools panel, packaging. Nothing is published, tagged or reserved; the npm scope `@airplanemode` is a
placeholder. Entries below the Sprint 3 groups are the Sprint 1 and 2 work that this alpha also ships.

### Added

- Spec release 0.3.0 (draft): backend adapter 0.3.0 (`cacheOnly`, the codes `integrity` and `not_cached`,
  `firstTokenMs`, `host`, rules R2w, R3w and R7 to R13), event 0.1.2 and model descriptor 0.2.0 with 3
  positive and 14 negative shared vectors; `spec/CHANGELOG.md` has the detail (D1-01, S1-053, S1-066,
  T1-S2-07, T1-S2-01, T1-S2-02).
- `AcquireOptions.cacheOnly` enforced inside `AssetManager.acquire()`: a missing, row-only, truncated or
  `.part`-only asset rejects `not_cached` before any request, with no Range header and no
  `asset.download.*` event; the chain loads a rung that needs no download cache-only (Sprint 3 spec touch;
  D1-02, S1-053).
- The `integrity` reason: a file that fails its hash check at download or at the R2 re-hash is
  `AdapterError('integrity')` naming the manifest entry, and `loadWithFallback()` never acquires it again
  in the same call (the next rung is recorded failed with reason `integrity`, no consent question, one GET
  per path); the message reads "a downloaded file failed its integrity check" (D1-02, T1-S2-07).
- Model descriptor `sessionOptions.graphOptimizationLevel` reaches ONNX Runtime as a fresh object literal;
  `createDefaultAdapters()` loads Qwen3-1.7B q4f16 without the application passing `sessionOptions`; the
  `chatTemplateKwargs` keys `__proto__`, `constructor` and `prototype` are refused (D1-03).
- Observability: `newLoadId()`, `PhaseTimer`, `sampleMemory()` and `emitMemorySample()`; the main-thread
  Transformers adapter emits one `model.load.phase` per phase (acquire, verify, handoff, session,
  first_token) and `memory.sample` at before-load, after-session and after-first-token under one `loadId`
  with `host: 'main'`; `GenerateResult.timings.firstTokenMs`; memory figures are read from
  `performance.memory` and are null where it is absent, never estimated (D1-06).
- `exposeDevtoolsHook(bus)` (opt-in, one frozen non-enumerable global; nothing in `src/` calls it) and the
  `airplanemode.devtools/0.1` snapshot (at most 1000 events and 2 MiB) (D1-06).
- `devtools/`: a Manifest V3 Chrome DevTools extension, the Airplane Mode panel, with no permissions and
  `connect-src 'none'`; `npm run devtools:build`; Playwright proof in installed Chrome, renderer and the
  real DevTools window (`npm run test:devtools`, `RUNTIME_DEVTOOLS_HEADED=1`) (D1-07).
- The engine in a dedicated module worker (`createTransformersAdapter({ workerUrl })`,
  `createDefaultAdapters({ workerUrl })`, `dist/worker/engine-worker.js` as `@airplanemode/runtime/worker`):
  one fresh worker per `load()` started from a `blob:` bootstrap (`'import ' + JSON.stringify(abs) + ';'`,
  validated before `URL.createObjectURL`, through the singleton Trusted Types policy `airplanemode-worker`),
  the page does R1 and R2 and posts the same re-hashed Blobs, an egress guard is the first import of the
  worker (fetch on every prototype owner, XHR, WebSocket, WebTransport, EventSource, `Worker`,
  `SharedWorker`, `importScripts`, `serviceWorker.register`, `Cache.add` and `addAll`, all locked
  non-writable and non-configurable), every worker message is validated strictly on the page (R13),
  an abort that is not answered within 250 ms terminates the worker, and the asset holds, the bootstrap
  URL and the registry keys are released after every terminate (D1-04, T1-S2-01, T1-S2-02).
- `--flip-byte <url path>:<offset>` on the range test server, and an isolation fixture whose WebGPU
  descriptor names a malformed ONNX file (`model-fixture.mjs --isolation`) (D1-04).
- Trusted Types on `demo/models.html`: `require-trusted-types-for 'script'` with the single policy
  `airplanemode-worker`, no `allow-duplicates`, no default policy; `worker-src 'self' blob:`
  (D1-09).
- The backend demo page: an engine picker (Auto, Transformers.js WebGPU, Transformers.js WebAssembly), an
  "Engine runs in a worker" line driven by `backend.worker` events and a "Load timing and memory"
  read-out built with the DevTools panel's own model and view; `pages.yml` records the built demo's size
  per model and refuses a build over 1 GB (D1-11).
- Alpha packaging: `0.2.0-alpha.0`, an exports map with types, `sideEffects` for the worker files,
  `scripts/pack-check.mjs` (`npm run pack:check`: contents, no source map, no engine-default URL, offline
  install into a fresh empty directory with an empty npm cache, a real Node call), `test:install`, and
  `docs/release.md` with the seven definition-of-done rows (D1-10).

### Changed

- The published tarball no longer carries source maps, `spec/vectors/` or `spec/examples/`, and `tsup`
  keeps `@huggingface/transformers`, `onnxruntime-web`, `onnxruntime-common` and `@mlc-ai/web-llm`
  external (D1-10).
- `model.load` and `model.load.failed` carry `loadId` and `host`; `model.generate` carries `firstTokenMs`
  and `host`; `backend.select` may report reason `integrity` (Event 0.1.2) (D1-06, D1-02).
- `loadDescriptor()` and the adapters read a descriptor with both wire strings `airplanemode.model/0.1`
  and `/0.2`; a rejection is a `DescriptorError` (an `AdapterError` `bad_descriptor`) with a `reason`
  (D1-01).
- `onnxruntime-web` is the stable 1.31.1 (a `package.json` override of the nightly the engine declares);
  `src/backends/ort-pins.ts` pins its wasm and factory, and `PROVENANCE.json` of a `DEMO_MODELS=1` build
  carries an `ort` block with the lockfile integrity, the attestation status and the cross-check
  (D1-08, S1-055).
- The engine-independent parts of the Transformers adapter moved to `src/backends/tjs-core.ts` (shared by
  the main-thread adapter and the worker host); the models page of the demo now runs the engine in a worker
  and its CSP gains `worker-src blob:` (D1-04).
- The Transformers adapter acquires every file, then re-hashes every file, so the two phases are timed on
  their own; the application option `sessionOptions` is deprecated in favour of the descriptor field (D1-06,
  D1-03).

### Fixed

- T1-S2-01 and T1-S2-02: a WebGPU failure after session creation no longer poisons WebAssembly in the same
  page, and the page no longer freezes on WebAssembly nor waits for the next yield to abort, when the
  engine runs in the worker host; the main-thread adapter keeps both limitations and says so (D1-04).
- S1-055: the nightly `-dev` onnxruntime-web is replaced by the stable 1.31.1 (D1-08).
- T1-S2-07: a file that fails its hash check was reported as "could not be started" and downloaded again by
  the next rung (D1-02).
- S1-053: cache-only was enforced in the chain only; `acquire()` could still download a file that vanished
  between the plan and the load (D1-02).
- S1-066: `asset.hold.unknown` was emitted but not reserved in `RUNTIME_EVENT_NAMES` (D1-01).
- `dist-pack/` and `*.tgz` are ignored by git and Prettier, so `npm run pack:check` and `npm pack` leave no
  untracked file in a clone (T3-S3-018).
- README Install reads the exact "Not published yet" sentence with registry commands only under "After the
  owner publishes", and every Benchmarks 8 GB Windows no-GPU laptop cell reads "not measured" (T3-S3-019).
- README packed-size figures match the final tarball: 159,991 B in 31 files, 567,785 B unpacked
  (T3-S3-020).
- `demo/THIRD-PARTY-NOTICES.txt` quoted the digests of the replaced 1.31.0-dev ONNX Runtime pin; it now
  quotes the 1.31.1 factory and wasm digests of `src/backends/ort-pins.ts`, and a unit test fails if the two
  drift apart (S1-083, T3-S3-031).

### Security

- Worker egress (R3w): the guard is the first import and locks its replacements; dynamic `import()` and
  FontFace loads are stopped only by the inherited CSP, which Chrome applies to blob workers (measured:
  `script-src-elem` and `font-src` violations, no request left the browser); a `workerUrl` with a quote,
  newline, backslash, `javascript:`, `data:`, another origin or a query string is refused before the Blob
  is made; worker messages are untrusted and `error.cause` and every other worker string are dropped (D1-04,
  S1-068 to S1-071).
- Trusted Types are required on the models page, with zero violations in the page and the worker on both
  rungs (D1-09).
- The DevTools panel reads the page with one constant expression through property descriptors (a page
  getter is never invoked), rechecks type and size, validates every event, writes text only and makes no
  network request; its manifest declares no permissions, host permissions, content scripts, background,
  web-accessible resources or external connections (D1-07, S1-070).
- `chatTemplateKwargs` and `sessionOptions` are copied into fresh object literals, never with
  `Object.assign`, `for...in` or spread, and prototype-polluting keys are refused (D1-03).
- The packed `dist/` is checked for engine-default endpoints (huggingface.co, raw.githubusercontent.com,
  cdn.jsdelivr.net, unpkg.com) by an allow-list that is empty (D1-10).
- The release dry run's throwaway ed25519 key and signed manifest were deleted from the sprint scratch;
  only `release-dry-run.log` is kept as evidence, and no key is in the repository (S1-080).

### Earlier work that the alpha ships (Sprint 1 and 2)

#### Added

- Backend adapters behind the `BackendAdapter` contract 0.2.0, exported from
  `@airplanemode/runtime/backends` (the main entry never imports an engine): a Transformers.js adapter
  for ONNX Runtime Web on WebGPU and on WebAssembly (`createTransformersAdapter`), an opt-in Chrome
  Prompt API adapter (`createChromePromptAdapter`) and the `loadWithFallback()` chain (WebGPU, then
  WebAssembly, then the Chrome built-in model only with `allowBuiltin: true`, then a plain-language
  `BackendRefusedError`), with `backend.select`, `backend.refused`, `backend.egress.refused`,
  `model.load`, `model.load.failed` and `model.generate` events (D1-05, D1-06, D1-07).
- Model descriptor 0.1.0 loader (`loadDescriptor`, `parseDescriptor`): size cap before download, strict
  canonical parse, schema and ordering rules, cross-checks bound to the asset manager's manifest (D1-05).
- The verified-file shim and registry (`src/backends/verified-files.ts`): the engine's network function is
  replaced by one that serves exactly the Blobs the asset manager verified and refuses everything else
  with `egress_refused`; `@huggingface/transformers` 4.3.1 is an optional exact-version peer dependency
  and a devDependency, `src/backends/ort-pins.ts` pins the ONNX Runtime Web version and the wasm and
  factory SHA-256 (generated by `test/tools/gen-ort-pins.mjs`, re-hashed by `test/ort-pins.test.ts`) (D1-05).
- `AssetManager.acquire(entryId, opts)` takes the refcount and a shared Web Lock
  `airplanemode-held:<sha>` inside the asset lock; `LockProvider.hold()` and `isHeld()`; stores report
  `binModified` (S1-015, S1-021).
- `test/tools/fetch-model.mjs` (https only, no token, sha256-pinned `models.json`, `.part` then rename,
  re-hash on every run, writes confined to `--dest`, `--pin` for first pinning) and the gitignored
  `.cache/` (D1-04); `docs/model-choice.md` records the model decision and the licence rule, the planned
  and contingency descriptors are in `docs/examples/` (D1-04, D1-09).
- Browser proof of the done-when: `test/browser/model.spec.ts` (`npm run test:model`) answers the same
  prompt with SmolLM2-135M-Instruct (q4) on WebGPU and on forced WebAssembly behind an aborting network
  gate, with a signed test manifest (`model-fixture.mjs`) and a `/models/` route on the range server that
  serves realpath-confined regular files only; the local Qwen3-1.7B Hindi smoke run
  (`test/browser/hindi-smoke.spec.ts`, `npm run test:hindi-smoke`) loaded the planned model on WebGPU and
  answered five synthetic prompts, unscored (D1-08, D1-09).
- `demo/models.html` and `demo/backend-panel.ts`: the backend demo (tier, plan, user-initiated download
  of the bundled test model, Force WASM, Allow Chrome built-in model, prompt box) with its own strict CSP;
  `DEMO_MODELS=1` bundles the Apache-2.0 test model with licence texts and a provenance file;
  `demo/THIRD-PARTY-NOTICES.txt`; `test/tools/dist-url-inventory.mjs` attributes every library URL
  string in a build (D1-10).
- CI: a separate, non-required `model-wasm (ubuntu-latest)` job (configured, not yet executed) and a
  cache-then-fetch-then-`DEMO_MODELS=1` build in `pages.yml` (D1-10).
- Fix round 1 additions: `probeWebGpuDevice()` and the `gpuProbe` adapter option, `engineBlocked()` on the
  transformers adapters with the optional `EngineStateProbe` interface and `RELOAD_SENTENCE` in the
  chain, `AssetManager.storedSize()` and `ChainAssets.storedSize` / `ChainAssets.events`, and the demo
  helpers `demo/build-id.ts`, `demo/limits.ts` and `demo/engine-defaults.ts`; the loopback hook
  `__models.run` takes `abortAfterTokens` (T1-S2-01, S1-053, T1-S2-08).

#### Changed

- `BackendAdapter` 0.2.0 (see `spec/CHANGELOG.md`): `device`, `available()`, `LoadOptions.onProgress`,
  `AssetSource.acquire(entryId, opts)`, three new error codes; `load(entry)` takes the descriptor entry;
  `MockAdapter` is `device: 'wasm'` with `available() === true` (D1-01).
- Event 0.1.1: `asset.quota` documents `usageSource` and the six backend and model event names are
  reserved (T1R2-02, T3-13).
- The README is reordered to Install, Quick start, How it works, Contracts, Demo, Benchmarks, Limitations,
  Security and privacy, Develop, Licence; the Develop section carries the Vitest `--legacy-peer-deps`
  decision (D1-10).
- Benchmarks cite `evidence/sprint-1/...` instead of scratch paths, the IndexedDB quota row records the
  measured 6252 ms as an Apple-silicon placeholder, and the browser test notes describe quota usage as
  `max(estimate().usage, accounted bytes)` with `usageSource` (T1R2-01, T3-12, T3-13, T1R2-02).
- Spec release 0.2.0 (draft): shared negative vector `neg-bad-alg-token.json` (D1-01).

#### Fixed

- The asset manager ignores `Content-Length` when a response carries a `Content-Encoding` other than
  `identity`: GitHub Pages gzips JSON on the fly, so the header counted compressed bytes and every
  descriptor download on the hosted backend demo failed with `content-length`. The streaming size cap and
  the SHA-256 check still decide (found on the live demo after the Sprint 2 push).
- README, `test/browser/README.md` and the `ci.yml` comment no longer call the Windows legs and the
  `model-wasm` job "configured, not yet executed": both first ran on GitHub on 9 Nov 2026, green; the
  docs and demo-DOM tests pin the new wording.
- IndexedDB `fileSize()` sums the stored chunk Blob sizes, so a truncated or replaced chunk makes
  `getBlob()` reject `not_verified` without `rehash` and the row is removed (S1-018).
- `reconcile()` no longer deletes a committed file whose `asset:<sha>` lock is held, that is held under
  `airplanemode-held:<sha>`, or that is younger than 60 s where the store reports a time (S1-015).
- `acquire()` takes its refcount inside the asset lock, closing the eviction window between `ensure()`
  and the hold, and eviction (`evict`, `evictToFit`, the quota path) and `reconcile()` skip an asset held
  in any instance or tab (S1-021).
- A stored downgrade state that is not `{ valid SemVer, calendar-valid createdAt }` fails closed with
  reason `state` instead of failing open on the same-version tie-breaker or surfacing as `schema`
  (S1-031).
- The WebGPU to WebAssembly fallback is honest on a machine with a weak or blocked GPU. `available()` on
  the WebGPU device now asks the browser for a device and destroys it, so a GPU that exists but cannot
  create a device is recorded as `unavailable` before any session exists and WebAssembly loads in a
  clean engine. A load that fails after the engine began reading the weights marks the engine module as
  unable to create another session (@huggingface/transformers chains every session creation on one
  promise): the next rung then fails with `load_failed` without a download question, without
  `pipeline()` and with nothing held, and the refusal message adds "Reload the page and choose
  WebAssembly to try again." Real-engine browser tests (`npm run test:model`) cover a rejected device
  and a failure after session creation; the README Limitations say per-rung engine isolation is
  Sprint 3 (T1-S2-01).
- WebAssembly generation runs on the main thread, so the page freezes and a timer or button
  `AbortSignal` is honoured only between engine steps that yield; abort from `onToken` works and is now
  covered by a browser test (a second generate afterwards works). The limitation is stated in the README
  Limitations and in `spec/backend-adapter.md` ("Known limitation (0.2.0 draft)"), the demo keeps
  WebAssembly answers to 24 tokens and says the page freezes; moving the engine off the main thread is
  Sprint 3 (T1-S2-02).
- One model-card claim in the README, `demo/models.html` and `docs/model-choice.md`: the planned
  production model sentence verbatim, then "Loaded once in a browser: a local, unscored WebGPU smoke run
  of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation
  turned off", with the `graphOptimizationLevel 'disabled'` finding, the `sessionOptions` requirement of
  `createDefaultAdapters()` and the Sprint 3 architect decision stated (T1-S2-04, T3-S2-004).
- README Benchmarks say the peak JS heap excludes WebAssembly linear memory, Blob backing stores and GPU
  memory (Chrome exposes no GPU-memory figure) and add a renderer process RSS peak row as an
  Apple-silicon placeholder (T1-S2-06).
- README Limitations: a model file that fails its hash check is reported as "could not be started" and
  the next rung downloads it again; a distinct integrity reason is planned with the Sprint 3 event
  minor (T1-S2-07).
- The demo build also rewrites the Hugging Face host allow-list literal of the engine's Node-only token
  path to an inert value (it fails the build if the literal is not found), and
  `test/tools/dist-url-inventory.mjs` scans bare host names (huggingface.co, hf.co, jsdelivr, unpkg,
  cdnjs, github.com, raw.githubusercontent.com, googleapis, gstatic) as well as https strings and exits
  1 on any unattributed hit, so `grep -rIoE 'huggingface\.co' demo/dist` finds only documentation link
  text (T1-S2-08).
- README Benchmarks: the GPU-process range is 0.35-0.42 GiB and cites `rep1-webgpu.json` to
  `rep3-webgpu.json` and `rep1-wasm.json` (T1-R1-02).
- README Install and Security and privacy name `onnxruntime-node` and `protobufjs` as the packages with
  install scripts and describe `sharp` as prebuilt native code from the optional `@img/*` packages with
  no install script (S1-067).

#### Added (Sprint 1)

- Public demo at <https://airplanemode-labs.github.io/runtime/> with a build-time-signed synthetic
  fixture: `demo/tools/make-fixture.mjs` writes three xorshift64* streams and a manifest signed by a
  key pair generated for that build (public half embedded as the trust root), `.github/workflows/pages.yml`
  builds and deploys `demo/dist`, and CI runs the same `npm run demo:build`. The page states its
  browser requirements by feature detection, confines storage listing to `airplanemode-runtime`,
  checks a pasted manifest URL's origin against an allowed list before any request, and carries a
  "What this demo does not do yet" box.
- Open contracts 0.1.0 under `spec/`: Manifest, Capability profile, Event, Storage API and Backend
  adapter as JSON Schema 2020-12 plus TypeScript, with examples, the RFC 8032 test key note and
  the shared canonicalisation vectors (`npm run spec:vectors`).
- `detectCapabilities(env?)` and `satisfies(profile, minProfile)` with allow-listed adapter details;
  never reads `navigator.userAgent` or `userAgentData`.
- `canonicalize()`, `compareSemver()`, `parseManifest()` and `verifyManifest()` (WebCrypto Ed25519,
  verification order, downgrade rule, test-key refusal, never throws on malformed signature material).
- `EventBus` (ring buffer of 1000, `subscribe()`) and `newEvent()` with the attrs privacy rules
  enforced in code; `test/no-egress.test.ts` greps `src/` for network APIs.
- `AssetManager`: resumable chunked download with Range and If-Range, response validation
  (206/200/416, Content-Range, Content-Length, oversize cap), streaming SHA-256 verification before
  commit, OPFS, IndexedDB and memory stores, Web Locks (or in-process locks) around `ensure()` and
  every index read-modify-write, LRU eviction with pins and refcounted handles, `allowedOrigins`
  policy enforced before any fetch, `reconcile()`, and the reserved `asset.*` events.
- `MockAdapter` (echo generation, deterministic 64-dimension embeddings) and `AdapterError`.
- Package skeleton: tsup build (ESM + d.ts), Vitest, Playwright on the installed Chrome
  (`channel: "chrome"`), three-OS CI with pinned actions, Apache-2.0 LICENSE and NOTICE.

#### Fixed (Sprint 1)

- Quota usage is never `navigator.storage.estimate().usage` alone (T1R-01): every quota decision
  (proactive `makeRoom` before a download or commit, and the evict-and-retry after a
  `QuotaExceededError`) uses the larger of the estimate and the bytes the manager accounts for
  itself (index row sizes plus bytes written to in-flight parts), so the IndexedDB store, for which
  Chrome reports about 0.627 of the stored bytes, evicts against `quotaBytes` like OPFS does.
  `asset.quota` attrs gain `usageSource` (`estimate` | `accounted`).
- OPFS commit at the quota edge (T1-B1): `commit()` streams the chunks into `<sha>.bin` and removes
  each chunk once written, so the transient overhead is one chunk instead of a second full copy;
  the manager reserves that chunk (`AssetStore.commitReserve`) before committing, retries a
  quota-failed commit after evicting one LRU row, and on terminal failure removes the half-written
  file and the part so no orphan or stuck complete part remains, rejecting with `quota` not `store`.
  A complete part (`bytesWritten == size`) is committed without a Range request.
- The abort-then-resume test locates the resume request by predicate rather than index (BUG-T2-2).

#### Security

- Model bytes reach an engine only from files the asset manager fetched and SHA-256-verified against a
  signed manifest entry: the engine's network function is a shim that serves only verified Blobs, the
  engine's remote host, caches and CDN `wasmPaths` default are overridden and re-asserted before every
  `pipeline()` and `generate()`, and the ONNX Runtime wasm is pinned by SHA-256 (D1-05).
- Errors and events are built from enums only; engine messages live only in `Error.cause` (D1-05, D1-06).
- The Chrome built-in model is opt-in and its availability is never queried while it is off; `create()` is
  only called when `availability()` is `available` (D1-06, D1-07).
- Downloads are consented per rung, cache-only by default (D1-07).
- npm supply chain for the new dependency: every added version is at least 14 days old (`overrides` pin
  `global-agent`, `semver`, `tslib` and `@huggingface/jinja` to older releases), every new lockfile entry
  is on registry.npmjs.org with sha512 integrity, `npm audit signatures` passes and no install script ran
  (D1-05).
- `fetch-model.mjs` refuses unpinned files outside `--pin`, re-hashes every cached file, writes `.part`
  then renames and confines writes to `--dest`; `range-server.mjs` serves realpath-confined regular files
  only under `/models/` (D1-04, D1-08).
- The backend demo page has its own CSP (`connect-src 'self'`), renders everything with `textContent`,
  creates its AssetManager only in the click handler with `allowTestKeys: false`, and never fetches a URL
  the user typed (D1-10).
- The demo build id is the first 12 characters of `GITHUB_SHA` only when it is 40 lowercase hex,
  otherwise `local` (unset, empty, short, uppercase, a trailing newline), as in pagetriage and
  glyphsift (S1-052).
- Interim consent fix: the chain counts a file as present only when the store holds a verified row and a
  stored file of exactly the manifest size, so a row that survived without its file (or with a truncated
  one) is asked about or declined in cache-only mode, and "Nothing was downloaded" is derived from
  observed `asset.download.start` events instead of approvals. Enforcing cache-only inside `acquire()`
  (`AcquireOptions.cacheOnly`) is a backend-adapter minor for Sprint 3, recorded by the architect
  (S1-053).
- Eviction and `reconcile()` fail closed when the hold state cannot be read: `LockProvider.isHeld()` may
  answer `'unknown'` (`WebLocksProvider` does when `navigator.locks.query` is missing or throws), the
  asset manager treats that as held for `evict`, `evictToFit`, the make-room and quota paths and
  `reconcile()`, and emits one `asset.hold.unknown` warn event with `reason: lock_state_unavailable`
  and no engine text (S1-054).
- README Install and Security and privacy warn that the optional `@huggingface/transformers` peer pulls
  `onnxruntime-node` and `sharp`, which have install scripts the browser never uses, and recommend
  `npm install --ignore-scripts` or `ignore-scripts=true`; linked to PRE-PILOT-CHECKLIST row 8
  (S1-056).
- CI no longer installs Chrome with `npx playwright install --with-deps chrome` (an apt install with no
  sha256 pin): the `check (ubuntu-latest)` browser tests and the `model-wasm (ubuntu-latest)` job use
  the Google Chrome preinstalled on ubuntu-latest through Playwright channel "chrome", log
  `google-chrome --version` and fail when it is missing. Configured, not yet executed (S1-058).

#### Security (Sprint 1)

- Every store write goes through one helper that maps the platform `QuotaExceededError` to
  `AssetError 'quota'` and anything else to `AssetError 'store'` (S1-019).
- `verifyManifest` re-runs the parse and schema stages on its input and never throws for malformed
  objects, even with an events sink (S1-012); the downgrade rule fails closed with reason `state`
  when the state store is unreadable (S1-013); `createdAt`/`expiresAt`/`signedAt` must be
  calendar-valid (S1-014); the manifest schema accepts unknown `alg` tokens that verifiers ignore
  (S1-011).
- `loadManifest(url)` streams the body with a hard 4 MiB cap (`network`/`oversize`) and honours an
  `AbortSignal` (S1-016).
- Part state read back from storage is validated before a resume; anything malformed restarts from
  zero with reason `part-mismatch` (S1-017).
- `evict(entryId)` refuses held or downloading assets unless `{ force: true }` (S1-020).
- `.npmrc` sets `ignore-scripts=true`, so no package install script runs. In the committed lockfile
  `esbuild` (pulled in by tsup) is the only package that carries an install script and it is not
  executed; `playwright` 1.65.0 ships none, so no browser is downloaded: CI used
  `npx playwright install --with-deps chrome` on Linux in Sprint 1 (replaced in Sprint 2 by the
  preinstalled Chrome, see S1-058 above) and locally the installed Chrome is used via
  `channel: "chrome"`. `npm run deps:scripts` lists the packages with pre/post/install scripts.
- Zero runtime dependencies. Any new dependency needs a one-line justification in this file.
- vite 7.3.7 as a devDependency to build demo/ for the Playwright suites (demo:build); not shipped in the package.
