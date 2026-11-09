# Changelog

All notable changes to `@airplanemode/runtime` are recorded here. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/). Nothing is released yet; the package version is
`0.1.0-dev` and no tag exists. The open contracts have their own log in `spec/CHANGELOG.md`.

## [Unreleased]

### Added

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

### Fixed

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

### Security

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
  executed; `playwright` 1.65.0 ships none, so browsers are installed explicitly with
  `npx playwright install --with-deps chrome` on Linux CI (locally the installed Chrome is used via
  `channel: "chrome"`). `npm run deps:scripts` lists the packages with pre/post/install scripts.
- Zero runtime dependencies. Any new dependency needs a one-line justification in this file.
- vite 7.3.7 as a devDependency to build demo/ for the Playwright suites (demo:build); not shipped in the package.
