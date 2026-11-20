# Benchmarks

The raw results behind every measured figure this repository quotes (the README, `docs/`, the demo, the write-up draft).
One JSON file per benchmark. A figure quoted anywhere without a row in one of these files is not done.

**Nothing here is measured on an 8 GB laptop unless a file says so, and no file does yet.** Every file records
`"laptop8gb": "not measured on 8 GB"`, and every figure comes from one Apple M5 Pro with 48 GB (macOS arm64, installed Google
Chrome 157), a development machine. An 8 GB Windows laptop without a GPU is the target machine; it has not been measured.

## What a file holds

```text
schema      airplanemode.runtime.benchmark/1
id          the file name without .json
title       what was measured
measuredAt  the date of the run (YYYY-MM-DD)
commit      { recorded, base | sha, note }: the commit, or how the run relates to the history (below)
machine     { label: "<model> <N> GB", cores, os, browser }: model and RAM only in the label
laptop8gb   "not measured on 8 GB"
method      how the figure is taken: what the clock covers, what the sample interval is
commands    the exact commands that reproduce it (or, where a lane script was used, the command and what replaces it)
files       the raw output, unchanged: { name, origin, source, sha256, json | text }
```

`files[].json` and `files[].text` are the output of the run exactly as it was written, parsed or read, never recomputed.
`source` is where the file was copied from (a path in the lab workspace, `evidence/sprint-N/...`, which a clone of this
repository does not have) and `sha256` is the hash of the original bytes, so a copy can be matched against the workspace.
One copy is redacted: `devtools-load-phases.json` replaces the Chrome unpacked-extension id (derived from a local
install path) with `<redacted-extension-id>`, says so in its `redactions` field, and keeps `sha256` as the hash of the
unredacted original.
`origin` is `workspace-evidence` for a copy, or `generated` for a run made by a script in this repository.

**The commit.** Every run before Sprint 7 was made on a sprint's working tree, and the tree was committed after the
sprint, so no commit hash existed or was recorded. For those files `commit.recorded` is `false`, `commit.base` is the last
commit that existed before the run (`null` for Sprint 1, which ran before the first commit) and `commit.note` names the
commits that later held the tree. `pack-size.json` was made now and records the commit it ran at.

## The files

| File                                                                   | What                                                                                                                 | Measured   | Base commit     | Reproduce                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [asset-download-700mb.json](asset-download-700mb.json)                 | 700 MB full download and SHA-256 verify, OPFS and IndexedDB; two runs                                                | 2026-11-09 | none (first)    | `node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints --asset big=734003200`, then `RUNTIME_BIG=1 RUNTIME_BIG_OUT=<dir> npx playwright test -c test/browser/playwright.config.ts big.spec.ts`, then `node test/tools/asset-digest.mjs big 734003200`                        |
| [asset-resume-700mb.json](asset-resume-700mb.json)                     | reload at about 38 percent, then one Range request, both stores; two runs                                            | 2026-11-09 | none (first)    | `node test/browser/range-server.mjs --port 8787 --serve demo/dist --test-endpoints --asset big=734003200`, then `RUNTIME_BIG=1 RUNTIME_BIG_OUT=<dir> npx playwright test -c test/browser/playwright.config.ts big.spec.ts` (it throttles the download, reloads at 38-42 percent and counts the requests) |
| [asset-quota-eviction-700mb.json](asset-quota-eviction-700mb.json)     | a (700 MB), b (400 MB), read a, then c (500 MB) under a 1.5 GiB quota: exactly b evicted; OPFS twice, IndexedDB once | 2026-11-09 | none (first)    | `big.spec.ts` runs the same sequence with the range server started with `--asset a=734003200 --asset b=419430400 --asset c=524288000`; the two scripts that wrote these files are the test lane's, not in this repository                                                                                |
| [idb-usage-reporting.json](idb-usage-reporting.json)                   | Chrome reports about 63 percent of the IndexedDB Blob bytes stored; no QuotaExceededError under a CDP override       | 2026-11-09 | none (first)    | the two diagnostics are lane scripts, not in this repository; the in-repository quota specs (`RUNTIME_BENCH_OUT=<dir> npm run test:browser`) record estimate and accounted usage per store                                                                                                               |
| [model-answer-smollm2.json](model-answer-smollm2.json)                 | SmolLM2-135M-Instruct (q4): one prompt on WebGPU and on forced WebAssembly (the Sprint 2 done-when)                  | 2026-11-09 | c2b6166         | `node test/tools/fetch-model.mjs smollm2-135m-instruct`, then `RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 RUNTIME_MODEL_OUT=<dir> npm run test:model`                                                                                                                                                      |
| [model-hindi-smoke-qwen3-1.7b.json](model-hindi-smoke-qwen3-1.7b.json) | Qwen3-1.7B (q4f16) on WebGPU, five synthetic Hindi prompts, unscored; and the transcript of the failed first attempt | 2026-11-09 | c2b6166         | `node test/tools/fetch-model.mjs qwen3-1.7b-webgpu-q4f16`, then `RUNTIME_HINDI_SMOKE=1 RUNTIME_MODEL_OUT=<dir> npm run test:hindi-smoke` (1.43 GB)                                                                                                                                                       |
| [model-rss-smollm2.json](model-rss-smollm2.json)                       | Chrome process RSS peak per process kind, three repetitions per path                                                 | 2026-11-09 | c2b6166         | the harness is a workspace script (`runtime-legs.mjs`), not in this repository; `RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model` samples the process tree the same way through `test/browser/rss.ts`                                                                                         |
| [devtools-load-phases.json](devtools-load-phases.json)                 | model load phases and page heap as the DevTools panel shows them                                                     | 2026-11-14 | 15c6d58         | `node test/tools/fetch-model.mjs smollm2-135m-instruct`, then `RUNTIME_MODEL=1 RUNTIME_DEVTOOLS_HEADED=1 npm run test:devtools`                                                                                                                                                                          |
| [worker-abort-long-task.json](worker-abort-long-task.json)             | abort latency over five runs; longest main-thread long task during a 32-token answer                                 | 2026-11-14 | 15c6d58         | `RUNTIME_MODEL=1 RUNTIME_REQUIRE_WEBGPU=1 RUNTIME_WORKER_OUT=<dir> npm run test:worker`                                                                                                                                                                                                                  |
| [demo-build-size.json](demo-build-size.json)                           | size of the `DEMO_MODELS=1` demo build (a file size, not a timing)                                                   | 2026-11-14 | 15c6d58         | `DEMO_MODELS=1 npm run demo:build`, then `du` over `demo/dist`                                                                                                                                                                                                                                           |
| [stop-button.json](stop-button.json)                                   | the demo's Stop button: time to stop with the test model                                                             | 2026-11-14 | 4338267         | `RUNTIME_MODEL=1 RUNTIME_STOP_OUT=<dir> npm run test:demo -- stop.spec.ts`                                                                                                                                                                                                                               |
| [opfs-snapshot-readback.json](opfs-snapshot-readback.json)             | an OPFS File snapshot taken the instant a write closes reads back whole: 64 MiB and 600 MiB                          | 2026-11-19 | 4f5b011         | `RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm RUNTIME_SNAPSHOT_ITERATIONS=50 RUNTIME_MODEL_OUT=<dir> npx playwright test -c test/browser/playwright.model.config.ts opfs-snapshot`                                                                                                                            |
| [unload-memory.json](unload-memory.json)                               | `unload()` frees the model: process-tree RSS before and after, with and without the R17 memory options               | 2026-11-19 | 4f5b011         | `RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm RUNTIME_MODEL_OUT=<dir> npx playwright test -c test/browser/playwright.model.config.ts model.spec.ts -g "D1-04 (f)"`                                                                                                                                            |
| [pack-size.json](pack-size.json)                                       | packed tarball: file count, packed bytes, unpacked bytes (a file size, not a timing)                                 | 2026-11-20 | b3bc39150586 \* | `npm run build && node scripts/bench-pack.mjs`                                                                                                                                                                                                                                                           |

\* with uncommitted changes in the working tree (the change that stores the file), so the hash is the parent of the commit that
holds it.

Run-to-run spread: the three 700 MB files, `opfs-snapshot-readback.json` and `unload-memory.json` hold more than one run of
the same benchmark, `model-rss-smollm2.json` holds three repetitions per path and `worker-abort-long-task.json` holds five
aborts. The README tables quote one run (the `method` of the file says which); the other runs are there so that nobody has to
trust one number.

## How the README is held to these files

`node scripts/bench-readme.mjs` writes the two tables of the README Benchmarks section from the files; `--check` (run by
`test/bench-readme.test.ts` in `npm run ci`) fails when

- a file is not well formed (a date, a commit note, a machine label of the form `<model> <N> GB`, the 8 GB phrase, no file
  over 5 MB, no personal or employer string) or is not indexed in the table above;
- a README table differs from what the files produce (the build also throws when a raw file contradicts the sentence it feeds:
  a resume that was not one Range request, an eviction of anything but b, a digest that differs from the independent one);
- a timing or throughput figure in the prose of the README, the docs, the CHANGELOG, the write-up draft or the demo pages
  (and a MiB or GiB figure with a decimal) occurs in no raw file, is not on the short list of design constants and scenario
  parameters in `scripts/bench-readme.mjs`, and does not sit in a sentence that says "raw data not kept".

## Quoted without raw data (raw data not kept)

These figures are quoted in the repository and no raw file for them exists in the lab workspace either. Each is marked "raw
data not kept" where it is quoted. They are candidates for a re-measurement; none was reconstructed.

- README Benchmarks: "the WebGPU leg measured 48.1 tokens/s in an earlier run on the same machine". The four recorded
  WebGPU runs in the committed files read 155.9 to 162.3 tokens/s (`model-answer-smollm2.json`, `model-rss-smollm2.json`).
- README Limitations: an abort ends the worker and the next question reloads the model from the cache "(about 2.4 s ...,
  0 bytes downloaded)". The committed files hold first loads that include the download (about 2.4 to 2.7 s in
  `model-answer-smollm2.json` and `devtools-load-phases.json`), and no timed reload from the cache.
- README Limitations and `docs/memory-options.md`: the next load after an unload "about 1.8 s for the 0.6B answer model". It
  is a dockit measurement (TD-64) and belongs in `dockit/docs/benchmarks/`, which does not hold it either.
- CHANGELOG, 0.3.0-beta.1: "64 keys are checked in about 30 ms" (the weak-key check).

## Quoted figures that are not measurements

- File sizes pinned in `test/tools/models.json` (checked by `test/docs.test.ts` and the fetch tool): the 182 MB SmolLM2 file,
  the 617 MB Qwen3-0.6B file, the 1.43 GB and 1.74 GB Qwen3-1.7B files, and the embedding model's download size that the demo page computes
  from its own build.
- Constants of the design: the 250 ms abort grace, the 60 s age under which `reconcile()` leaves a file alone, the 1500 ms
  retry pause of dockit.
- Parameters of a scenario: the 1.5 GiB quota, the 700, 400 and 500 MB assets, the 64 MiB headroom.
- `detectCapabilities()` "under 2 s": a threshold that `test/browser/capability.spec.ts` asserts, not a figure.

## Other repositories, and the security register

- Figures measured in another repository belong in that repository. `docs/security/` quotes the dockit end-to-end peak memory
  with its file and commit (`dockit/docs/benchmarks/e2e.csv` at 840ec8b), which dockit publishes.
- `docs/security/` (the findings register, the threat model, the checklist) also quotes results of security probes: the peak
  memory of a decompression-bomb probe, the time a parser took on a hostile input, fuzz counts. They are probe logs of the
  security reviews, kept in the lab workspace, not benchmarks of this repository, and their raw logs are not published here.
  The scan above does not read that folder.
