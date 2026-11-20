# The engine-load retry: root cause investigation (Sprint 6, D1-07)

**Status: the hypothesis was tested and refuted; the root cause is not reproduced. One small fix landed for a
neighbouring gap (R20). dockit's one retry stays, with a note for D5. Every figure is from one Apple M5 Pro with 48 GB,
installed Chrome, macOS arm64. Not measured on 8 GB.**

## The observation

Sprint 5, Chrome 157, dockit (`dockit/src/model/model-service.ts`, `LOAD_RETRY_PAUSE_MS` 1500): a model file that had
been written to OPFS less than about a second earlier could fail its first read by the engine with code `backend`; the
same load a moment later succeeded. dockit retries once after a pause, never on `integrity`.

## The hypothesis

The OPFS write had not settled when the R15 File snapshot was taken and read: `getFile()` straight after `close()` hands
back a snapshot that is short, stale or unreadable, so the in-worker hash passes or fails oddly and the engine's read
fails (an engine error the host reports as `backend`).

## The reproduction

`test/browser/opfs-snapshot.spec.ts` (rides the model config, so it runs in the CI `model-wasm` leg):

```sh
RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm RUNTIME_SNAPSHOT_ITERATIONS=50 RUNTIME_MODEL_OUT=<dir> \
  npx playwright test -c test/browser/playwright.model.config.ts opfs-snapshot
```

It writes a synthetic file with deterministic bytes the way `src/store/opfs.ts` commits an asset (8 MiB chunk files,
then the chunks streamed into `<sha>.bin` through `createWritable()`, each chunk removed as it is consumed, then
`close()`), takes the File snapshot the instant `close()` resolves, posts it to a worker and reads it there with
`arrayBuffer()`. It compares the size and a 32-bit FNV-1a checksum of what was read with what was written, and
records the error name if the read failed.

| variant                                                                                               | iterations | snapshot size wrong | read failed | read size wrong | checksum wrong | median write | median read         |
| ----------------------------------------------------------------------------------------------------- | ---------- | ------------------- | ----------- | --------------- | -------------- | ------------ | ------------------- |
| 64 MiB, chunked commit path, snapshot immediately, read at once                                       | 50         | 0                   | 0           | 0               | 0              | 116 ms       | 35 ms               |
| 64 MiB, one `createWritable` write, snapshot immediately, read at once                                | 20         | 0                   | 0           | 0               | 0              | 58 ms        | 34 ms               |
| 64 MiB, chunked, snapshot immediately, read 1.5 s later                                               | 10         | 0                   | 0           | 0               | 0              | 112 ms       | 35 ms               |
| 600 MiB (model size), chunked, snapshot immediately, read twice (the hash read, then the engine read) | 3          | 0                   | 0           | 0               | 0              | 1,441 ms     | 837 ms (both reads) |

Result: 80 snapshots of 64 MiB (50 + 20 + 10) and 3 of 600 MiB, 83 in all, taken the instant the write closed, were all the
right size and read back byte for byte. Raw data: [`benchmarks/opfs-snapshot-readback.json`](benchmarks/opfs-snapshot-readback.json)
(its first run is the one the table quotes, a later run of the same day is beside it). The flush-versus-snapshot hypothesis is refuted for this write path in this Chrome.

A last test pins the platform fact that R15 and R20 rely on: after a file is rewritten (same size, other bytes), the OLD
snapshot is unreadable (`NotReadableError`, for the full read and for a one-byte slice); it never serves the new bytes.
So a write between the hash and the engine's read can make a load fail, but never succeed with other bytes.

## What is not known

The failure was observed once, in dockit, and did not reproduce here, so the root cause is not established. The
strongest remaining hypothesis is allocation pressure, not a flush: a model file written less than a second ago means the
page has just finished a download that held buffers of its own, and the engine's first read of a roughly 617 MB file
(a second 617 MB buffer after the worker's hash read, then the copy into the WebAssembly heap) can fail to allocate
until the garbage of the download has been collected. A retry after a pause then succeeds. This is consistent with the
timing and with the code (`backend` was the code of every engine error that was not classified) but it is NOT verified:
nothing here has produced the failure. Since Sprint 6 (backend adapter R18) an allocation failure inside the engine is
classified inside the worker and reported as `out_of_memory`, not `backend`. If the hypothesis is right, the first load
after a download that used to be retried as `backend` would now be refused as `out_of_memory` without a retry.

## What changed (R20), and what did not

R20 requires that the engine consumes exactly the bytes the R15 re-hash covered, and that any size or hash mismatch takes
the `integrity` path, never retried. The shim probes the snapshot with one byte before it serves it, so a file changed
before that probe is already `integrity`. A file changed AFTER the probe fails in the middle of the engine's own read and
reached the host only as an opaque engine error, code `backend`. Fix (small, in `src/worker/tjs-engine.ts`): when the load
fails with a plain engine error, the worker reads one byte of every hashed snapshot again, and a snapshot that can no
longer be read makes the failure `integrity`. An error that already has a better code (integrity, out_of_memory) is left
alone; nothing is read when the engine did not fail. Red before (`test/worker-integrity.test.ts`, "R20", code `backend`),
green after (`integrity`, one worker, one `pipeline()` call: never retried; no `model.load`; every hold released).

What did NOT change: no snapshot is re-taken after the hash, no copy of a hashed file is made (method (i) was tried in
Sprint 5 and refused: a 617 MB copy made the engine's read fail), and the data path of the engine's read is untouched,
so memory does not grow.

## Does dockit's retry stay?

Yes, as it is: one extra attempt after `LOAD_RETRY_PAUSE_MS` (1500 ms) on `backend`, never on `integrity`. It costs 1.5 s
in a case that was observed once, and every retry is a full first load (R19: it re-verifies the stored manifest,
re-acquires under `cacheOnly` and re-hashes every file), so a retry can never accept a file that a first attempt would
have refused. A note for D5, who owns that code: because of R18, if the allocation hypothesis is right the same failure
now arrives as `out_of_memory`. dockit should allow the single retry for `out_of_memory` ONLY on the first load after the
model was downloaded in this page session (the one case that was observed), and never on a later load or when the memory
line refused the load (TD-67); that decision is D5's and the architect's, and needs a measurement that this lane could
not make.

## What would settle it

A run that produces the failure: dockit's first answer after a cold download of the 617 MB model, with the model's
`model.load.failed` event (it carries the code) and the `model.memory` peaks. If the code reads `out_of_memory`, the
allocation hypothesis holds and the retry condition above is the fix; if it reads `backend`, the cause is elsewhere and
the next step is to log which engine call failed (inside the worker, never into an event).
