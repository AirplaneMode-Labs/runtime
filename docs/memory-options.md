# Engine memory options (backend adapter R17) and the unload measurement

Sprint 6, B1. Two findings that sit behind `CHANGELOG.md` and `spec/backend-adapter.md` R16 and R17. Every figure is
from one Apple M5 Pro with 48 GB, Chrome (installed), macOS arm64, SmolLM2-135M-Instruct q4 on WebAssembly through the
worker host. Not measured on 8 GB. Raw data: [`benchmarks/unload-memory.json`](benchmarks/unload-memory.json) (the runs with and
without the options, and a later run of the final tree), with the date, commit and command.

## R17: the memory options reach ONNX Runtime and change nothing

On device `wasm` the worker host creates sessions with `enableCpuMemArena: false` and `enableMemPattern: false`
(`memorySessionOptions()` in `src/backends/tjs-core.ts`; they are fixed by the host and are not part of the
application-facing `sessionOptions`, which still accepts `graphOptimizationLevel` and nothing else).

- They do reach the engine: Transformers.js 4.3.1 spreads `session_options` into `InferenceSession.create()`
  (`src/backends/onnx.js`, `createInferenceSession`), and onnxruntime-web 1.31.1 passes them to the native
  `_OrtCreateSessionOptions`.
- They change nothing on this stack: onnxruntime-web hands the native call `!!sessionOptions.enableCpuMemArena` and
  `!!sessionOptions.enableMemPattern`, so an unset option is already `false`. Transformers.js sets neither. The CPU
  arena and memory-pattern planning were therefore already off on the WebAssembly path before this change.
- Measured, same machine, same command, HEAD copy against this change: the greedy answer is token-identical
  ("The capital of France is Paris.", 8 tokens) and the worker's WebAssembly memory peak is 726.7 MiB in both. The
  Chrome process-tree RSS before the unload read 2,276.7 MiB with the options and 2,238.6 and 2,230.1 MiB without: the
  difference is run-to-run noise, not a saving.

So M2 is landed (explicit, tested, token-identical) and has no measured effect; it protects against a future ONNX
Runtime release that changes the default. It must not be counted as a memory reduction. `sessionMemoryOptions` in
`LANDED.json` reads `green` for that reason, with this paragraph as its qualification.

## R16: unload() frees the model

Same model, load then generate, then `unload()`, 3 s settle (`test/browser/model.spec.ts`, the D1-04 (f) test,
`RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model`):

| figure                                        | value                                                           |
| --------------------------------------------- | --------------------------------------------------------------- |
| load `model.memory` peak (WebAssembly.Memory) | 726.7 MiB                                                       |
| process-tree RSS before the unload            | 2,276.7 MiB (7 processes)                                       |
| process-tree RSS 3 s after the unload         | 1,331.8 MiB (7 processes)                                       |
| drop                                          | 944.9 MiB, 130 percent of the load peak (required: at least 50) |
| engine worker targets before and after        | 1 and 0                                                         |

WebAssembly memory is returned to the system only by ending the worker, never by an in-worker `dispose()`: the drop is
the worker being terminated. The cost is that the next `load()` is a first load (R19): it re-verifies, re-acquires and
re-hashes every engine-readable file again (about 1.8 s for the dockit answer model on this Mac, TD-64; a dockit measurement, raw data not kept).

## The KV cache is not pre-allocated

Transformers.js 4.3.1 grows a `DynamicCache` from zero length with the real sequence, so a smaller `contextLength` saves
no cache memory for a short prompt. A smaller context window is therefore not a memory measure here (TD-66, M5).
