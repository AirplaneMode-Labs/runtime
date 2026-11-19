# Release checklist: runtime 0.3.0-beta.1

Status of the seven definition-of-done items for the runtime beta, written on 18 Nov 2026 (Sprint 5; first written
on 14 Nov 2026 for the alpha). The beta is **not tag-ready (TD-30)**: rows 2 to 6 are open.
**Nothing is published, tagged or reserved**; the npm scope `@airplanemode` is a placeholder. The tag and every
Open row below are the owner's steps, after review. Release order (team decision TD-07, owner delegation of
14 Nov 2026): runtime first (0.2.0-alpha.1, then 0.3.0-beta.0, now 0.3.0-beta.1), because it carries the spec and the verifier, then glyphsift 0.1.0,
then localdata 0.2.0-alpha.0, then pagetriage 1.0.0 when its rows close. Manifest spec v0.1 published in
runtime/spec (committed; public after the owner's push).

| #   | Definition-of-done item                            | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner                    | Blocks the tag |
| --- | -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------- |
| 1   | Tests first, README limitations section, CHANGELOG | Done    | Red then green logs per task in `evidence/sprint-3/D1/` (`red-D1-NN.log` before `green-D1-NN.log`); the README has a Limitations section; `CHANGELOG.md` has `[0.2.0-alpha.1]`; Sprint 4 logs in `evidence/sprint-4/D1/`                                                                                                                                                                                                                                             | D1                       | No             |
| 2   | CI on Linux, macOS and Windows                     | Partial | tests-first evidence Done (red/green logs); local macOS green; CI on three OSes configured, pending the owner's push (`.github/workflows/ci.yml`, matrix of the three, `pack:check` in it). The Sprint 4 push (15 Nov, runtime 3bf53c6) was red on windows-latest (`devtools-hook.test.ts`, fixed by D1-01) and in `model-wasm (ubuntu-latest)` (`model.spec.ts`, fixed by D1-02, which had also skipped five serial tests); the next push must show both legs green | Owner (push, read CI)    | Yes            |
| 3   | 8 GB Windows no-GPU laptop benchmark in the README | Open    | The README Benchmarks tables read "not measured on 8 GB" in the 8 GB column; every figure is an Apple-silicon placeholder                                                                                                                                                                                                                                                                                                                                            | Owner (Sprint 5)         | Yes            |
| 4   | Signed artifacts and manifest                      | Open    | No real key exists. `scripts/pack-check.mjs` produces the tarball; the signing steps are below                                                                                                                                                                                                                                                                                                                                                                       | Owner (key custody)      | Yes            |
| 5   | Semver tag                                         | Open    | `package.json` says `0.3.0-beta.1`; no tag exists in any repo                                                                                                                                                                                                                                                                                                                                                                                                        | Owner (after review)     | Yes            |
| 6   | Installable from a clean machine, and published    | Open    | Proven from a locally built tarball on macOS arm64: `evidence/sprint-4/D1/pack/pack-check.json` (installs offline into a fresh directory; `verifyManifest` on tamper-01 prints `no_valid_signature`). Not published; the scope and names are not reserved                                                                                                                                                                                                            | Owner (reserve, publish) | Yes            |
| 7   | Short write-up                                     | Open    | The Sprint 3 write-up skeleton is drafted on the site (draft, unlinked); finishing it is cut to Sprint 5 (drop order TD-25); publishing waits for the tag and the publish                                                                                                                                                                                                                                                                                            | Owner                    | No             |

## What the owner must do

Every command below uses `git -C <absolute repo path>` or runs inside the runtime repository; nothing is
pushed or published by the team.

### Row 2: CI on three operating systems

Owner must: push, then read every leg.

```sh
git -C <workspace>/runtime push origin main
gh run watch --repo AirplaneMode-Labs/runtime
```

Read `check (ubuntu-latest)`, `check (macos-latest)` and `check (windows-latest)` (they run `npm run ci`,
the demo build and `npm run pack:check`), then `model-wasm (ubuntu-latest)`.

### Row 3: the 8 GB benchmark

Owner must: run the model proof on the 8 GB Windows no-GPU laptop and enter the figures in the README
Benchmarks table, replacing "not measured".

```sh
node test/tools/fetch-model.mjs smollm2-135m-instruct
RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model
```

### Row 4: signed artifacts

Owner must: generate the real key offline, build an unsigned manifest for the tarball with the release-manifest
procedure that pagetriage and glyphsift use (see `glyphsift/docs/release.md`, row 4, and
`glyphsift/scripts/release-manifest.mjs`; a runtime copy of that script is cut to Sprint 5), then
sign and verify it. Never commit `key.secret`.

```sh
cd <workspace>/control-plane
cargo run -p cp-sign -- keygen --out ./keys                 # offline, on the machine that keeps the key
cargo run -p cp-sign -- keyid --pub ./keys/key.pub          # record the keyId in the release notes
cd <workspace>/runtime && npm run pack:check -- --out ./dist-pack   # writes the tarball and pack-check.json
cd <workspace>/control-plane
cargo run -p cp-sign -- sign --key ./keys/key.secret <unsigned-manifest.json> --out <signed-manifest.json>
cargo run -p cp-sign -- verify --pub ./keys/key.pub <signed-manifest.json>
```

### Row 5: the tag

Owner must: after rows 2, 3, 4 and 6 are done and the review is finished.

```sh
git -C <workspace>/runtime tag -a v0.3.0-beta.1 -m "runtime 0.3.0-beta.1"
git -C <workspace>/runtime push origin v0.3.0-beta.1
```

### Row 6: reserve the names, then publish

Owner must: reserve the scope and the names (due 22 Nov 2026), then build the tarball and publish in the release order.

```sh
npm org ls airplanemode                                          # or create the scope on npmjs.com
cd <workspace>/runtime && npm run pack:check -- --out ./dist-pack
```

After the owner publishes (the registry step; nothing here has been run by the team):

```sh
npm publish ./dist-pack/airplanemode-runtime-0.3.0-beta.1.tgz --access public --tag beta
```

### Row 7: the write-up

Owner must: review the draft write-up on the site, publish it after the tag and the publish, and link it.

```sh
sed -n 1,40p <workspace>/site/README.md   # the one-line link step
```
