# Release checklist: runtime 0.3.0-beta.2

Status of the seven definition-of-done items for the runtime beta, written on 20 Nov 2026 (Sprint 7; first written on 14 Nov
2026 for the alpha). The beta is **not tag-ready (TD-30)**: rows 2 to 6 are open.
**Nothing is published, tagged or reserved**; the npm scope `@airplanemode` is a placeholder. The tag and every
Open row below are the owner's steps, after review, and the ordered list of them, with the exact commands and the reason the
team cannot do each one, is [`RELEASING.md`](RELEASING.md). Release order (team decision TD-07, owner delegation of
14 Nov 2026): runtime first (0.2.0-alpha.1, then 0.3.0-beta.0, 0.3.0-beta.1, now 0.3.0-beta.2), because it carries the spec and
the verifier, then glyphsift, then localdata, then pagetriage when its rows close. Sprint 7 creates no gate-1 evidence: paid
pilots, stars and qualified conversations read 0, 0 and 0, and only the owner can move them.

| #   | Definition-of-done item                            | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Owner                    | Blocks the tag |
| --- | -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------- |
| 1   | Tests first, README limitations section, CHANGELOG | Done    | Red then green logs per task (Sprint 7: `D1/red/D1-NN-*.log` before `D1/green/D1-NN-*.log`); the README has a Limitations section; `CHANGELOG.md` has `[0.3.0-beta.2]`, `[0.3.0-beta.1]` and the earlier sections                                                                                                                                                                                                                                                                                           | D1                       | No             |
| 2   | CI on Linux, macOS and Windows                     | Partial | tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push (`.github/workflows/ci.yml`, matrix of the three). The Sprint 6 head 7d3777b was green on all three (CI run 44580189216, read with gh on 20 Nov 2026). Sprint 7 adds the job `release-rehearsal (<os>)` (the clean install, the test-key rehearsal and the quick start), which first runs after the push; the Windows junction refusal and the LF `SHA256SUMS` are provable only there | Owner (push, read CI)    | Yes            |
| 3   | 8 GB Windows no-GPU laptop benchmark in the README | Open    | The README Benchmarks tables read "not measured on 8 GB" in the 8 GB column; every figure is an Apple-silicon placeholder. No emulated figure fills a laptop cell (TD-51)                                                                                                                                                                                                                                                                                                                                   | Owner (Sprint 5)         | Yes            |
| 4   | Signed artifacts and manifest                      | Open    | No real key exists. The rehearsal (`npm run release:rehearse`, CI `release-rehearsal (<os>)`) builds the artefacts, writes `release-manifest.json` and `SHA256SUMS`, signs with the published RFC 8032 test key, verifies with `release-tool` and shows the same files refused without the flag (`test_key_refused`) and against an empty `docs/release-keys.json` (`no_trusted_key`); the real signature is the owner's (cp-sign, offline, `--no-expiry`)                                                  | Owner (key custody)      | Yes            |
| 5   | Semver tag                                         | Open    | `package.json` says `0.3.0-beta.2`; no tag exists in any repo; the publish job refuses a tag that does not resolve to the commit it runs on                                                                                                                                                                                                                                                                                                                                                                 | Owner (after review)     | Yes            |
| 6   | Installable from a clean machine, and published    | Open    | Proven from the packed tarball in a fresh directory with no sibling repository, offline, with one asserted call, on macOS (`evidence/sprint-7/D1/`) and, after the push, on three operating systems by `release-rehearsal (<os>)`; the README quick start is executed by `test/quickstart.test.ts`. Not published; the scope and names are not reserved; `publish.yml` has never been run                                                                                                                   | Owner (reserve, publish) | Yes            |
| 7   | Short write-up                                     | Open    | draft exists; finishing it waits on the 8 GB figure (owner): `docs/writeup-0.3.0-beta.2-draft.md`, marked draft, not published                                                                                                                                                                                                                                                                                                                                                                              | Owner                    | No             |

## What the team closed in Sprint 7

Every row the team owns is closed with the commit group that closes it and the test that proves it; what is left is the owner's.

| Team row                                                                                 | State  | Commit group  | Proof                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| Spec 0.6.1: manifest 0.1.4 Release manifests (R1 to R5), event 0.1.6, storage API 0.4.1  | Closed | spec          | `test/spec-0.6.1.test.ts`, every 0.6.0 vector byte-identical                                              |
| The release tool and its vectors (every `release.json` case, symlink and junction cases) | Closed | feat          | `test/release-tool.test.ts` (TypeScript entry and committed bundle), allowlist test                       |
| Release rehearsal with the test key, refusal proofs, a self-test                         | Closed | feat and ci   | `test/release-rehearse.test.ts`, `npm run release:rehearse`, CI `release-rehearsal (<os>)` after the push |
| Clean-install check from the packed artefact                                             | Closed | feat and ci   | the same script; the quick start test                                                                     |
| Publish workflow that cannot start by accident, with a dry run                           | Closed | ci            | `test/workflows-release.test.ts` (triggers, locks, order, secrets, pins)                                  |
| RELEASING.md with owner-only steps                                                       | Closed | docs          | `test/docs.test.ts` (order, reasons, the commands, no test-key flag outside a "never")                    |
| Dependabot: five updates, two applied, three deferred with reasons                       | Closed | feat          | `test/lock-optionals.test.ts`, `scripts/check-lock-optionals.mjs`, D1/dependabot.md                       |
| Quick start without a model download, executed by a test                                 | Closed | docs and test | `test/quickstart.test.ts`                                                                                 |
| Live demo line in the first screen, issue forms, CONTRIBUTING                            | Closed | docs          | `test/docs.test.ts`                                                                                       |
| Write-up draft                                                                           | Closed | docs          | `test/docs.test.ts` (draft marker, every figure traced)                                                   |

## What the owner must do

Owner must: do the fourteen steps of [`RELEASING.md`](RELEASING.md) in order. Each row below names the steps that close it.
Nothing is pushed or published by the team.

### Row 2: CI on three operating systems

Owner must: push, then read every leg (step list: the main session pushes between sprints and reads CI; the owner reads it before a tag).

```sh
git -C <workspace>/runtime push origin main
gh run watch --repo AirplaneMode-Labs/runtime
```

Read `check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)`, `model-wasm (ubuntu-latest)` and the new
`release-rehearsal (ubuntu-latest)`, `(macos-latest)` and `(windows-latest)`.

### Row 3: the 8 GB benchmark

Owner must: run the model proof on the 8 GB Windows no-GPU laptop and enter the figures in the README Benchmarks table, replacing
"not measured on 8 GB" (RELEASING.md step 5).

```sh
node test/tools/fetch-model.mjs smollm2-135m-instruct
RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model
```

### Row 4: signed artifacts

Owner must: generate the real key offline with `cp-sign keygen`, commit its public key to `docs/release-keys.json`, then sign the
candidate's `release-manifest.json` with `cp-sign sign --no-expiry` and verify it with `release-tool verify --trust-file
docs/release-keys.json --expect-id runtime-release` (RELEASING.md steps 2, 3, 8 and 9). Never commit `key.secret`.

### Row 5: the tag

Owner must: after rows 2, 3, 4 and 6 are done and the review is finished, tag the exact commit of the candidate run (RELEASING.md
step 10).

### Row 6: reserve the names, then publish

Owner must: reserve the scope (due 22 Nov 2026), create the `release` environment, the variables and the short-lived token,
dispatch `publish.yml` and approve the deployment (RELEASING.md steps 1, 4, 7, 11, 12 and 13). The publish job verifies the
signed manifest, the tag and the registry before it touches the registry.

### Row 7: the write-up

Owner must: finish `docs/writeup-0.3.0-beta.2-draft.md` with the 8 GB figure, publish it after the tag and the publish, and link
it from the README (RELEASING.md step 14).
