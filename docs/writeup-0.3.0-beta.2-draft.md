# @airplanemode/runtime 0.3.0-beta.2: a browser runtime whose release path you can rehearse

**Draft, not published.** Written 20 Nov 2026 for release row 7 of [release.md](release.md). It uses only evidence that
exists today. Every figure names the file it comes from; a figure without a path is not in this draft. The 8 GB laptop figures
read "not measured on 8 GB" because nobody has measured them, and the draft cannot be finished until [row 3](release.md) closes.
Nothing here is tagged, announced or on a registry, and the package names are placeholders until the owner reserves them. Paths
starting with `evidence/sprint-7/D1/` are copied into the workspace by the architect at wrap-up.

## What it is

A TypeScript library for the browser that downloads, verifies, caches and evicts model and data files, measures what the
device can run, loads a model on the best backend it has (WebGPU, then WebAssembly), and runs the model in a worker that cannot
reach the network. It also carries the open contracts the other Airplane Mode Labs repositories are built on: a signed manifest,
a capability profile, an event shape, a storage API and a backend adapter. Source: [README](../README.md), [spec](../spec/README.md).

## What was tried

The beta's claim is narrow: a file that fails its hash or its signature never reaches the engine, and everything the engine can
read is hashed again inside the worker. The Sprint 7 work added a second claim, about the release itself: that the path from a
clean checkout to a signed, verifiable set of artefacts can be exercised before anyone holds a real key, and that the exercise
cannot be mistaken for a release.

- **The manifest.** A list of files with their SHA-256, size, version and licence, signed with Ed25519. The shared vectors are 5
  positive and 32 negative manifests, 15 tamper cases and 26 weak-key rows
  ([spec/vectors](../spec/vectors), [CHANGELOG](../CHANGELOG.md)); a verifier written from the spec alone checks them.
- **The release path.** A release manifest has the id `runtime-release`, a rehearsal has `runtime-rehearsal`, and a published
  test key (RFC 8032 TEST 1) can sign only the second. `spec/vectors/release/` holds 36 cases and a 44-id table of the two id
  patterns ([release.json](../spec/vectors/release/release.json), [ids.json](../spec/vectors/release/ids.json)); the release
  tool, a bundled copy of the library's own verifier, gives every case its exit code and reason
  ([release-tool test](../test/release-tool.test.ts)).
- **The rehearsal.** `npm run release:rehearse` builds the package, installs the tarball into an empty directory outside the
  checkout with no sibling repository, makes one real call, signs a manifest with the test key, verifies it only because the
  test-key flag was given, and then proves nine refusals: the flag missing, an empty release-keys file, a release id, a changed
  byte, a changed checksum line and an edited manifest ([rehearse.mjs](../scripts/release/rehearse.mjs)). A self-test points the
  script at tools that lie and checks that it goes red.

## What held up

- The same inputs give the same bytes: two rehearsal runs with the same `SOURCE_DATE_EPOCH` produced an identical manifest,
  `SHA256SUMS` and tarball on macOS (`evidence/sprint-7/D1/green/D1-03-determinism.log`).
- The packed tarball installs offline and the installed copy is the one that runs: its module path sits under the fresh
  directory's `node_modules` ([rehearsal report](../scripts/release/rehearse.mjs), step 2).
- Large files: a 700 MB (734,003,200 B) download with SHA-256 verification took 4060 ms on OPFS and 2561 ms on IndexedDB, and a
  reload at about 38 % resumed with exactly one `Range` request ([README, Benchmarks](../README.md#benchmarks); Apple M5 Pro 48 GB,
  not measured on 8 GB).
- A model answers in the browser with the network gated: SmolLM2-135M-Instruct on forced WebAssembly loaded in 2592 ms and
  decoded at 10.9 tokens/s, and a Stop from a timer ended the answer in about 253 ms ([README, Benchmarks](../README.md#benchmarks);
  Apple M5 Pro 48 GB, not measured on 8 GB).

## What did not

- **Nothing was run on GitHub's runners yet.** The job `release-rehearsal (<os>)`, the Windows junction and symlink refusals and
  the publish workflow's checks first run after the owner's push; until then they are proven on macOS and by reading the files.
- **The publish workflow has never run.** It cannot start by accident (a manual dispatch on `main`, an environment that waits for
  the owner, an arming variable, a signed manifest checked against a committed key, a tag that must name the same commit), and
  that is all that is known about it: it has not touched a registry.
- **No real key exists.** `docs/release-keys.json` is committed with no key, so a real verification is refused with
  `no_trusted_key` today, and the rehearsal says so on purpose.
- **Dependabot majors.** TypeScript 7, @types/node 26 and tsup 9 are deferred, each with a reason
  ([CHANGELOG](../CHANGELOG.md), Changed and Deferred); vite 8.3.8 and vitest 5.1.0 were applied after the browser and demo checks passed.

## On the 8 GB Windows laptop without a GPU

Not measured on 8 GB. Every figure above comes from one Apple M5 Pro with 48 GB. The owner's runbook (`PLAN.md` in the workspace, not in this repository,
step 5) measures the same things on an 8 GB Windows laptop; until it does, no emulated figure stands in for a laptop figure.

## Install, today

Not on a registry. From a clone: the commands in [Try it in two minutes](../README.md#try-it-in-two-minutes) build the tarball and
install it into an empty directory, and `test/quickstart.test.ts` runs them.

## What it does not do

It does not publish, tag or sign a real release. It has no key revocation and no transparency log. It does not run WebLLM (cut)
or any model larger than the test models on this page, it does not run with WebAssembly threads on a static host, and it makes no
claim about Indic text quality. The full list is the README's Limitations section.

## To finish this draft

Enter the 8 GB figures, delete the "Draft, not published" marker, add the registry link after the owner publishes, and publish it
after the tag ([RELEASING.md](RELEASING.md), step 14).
