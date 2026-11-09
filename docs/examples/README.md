# Example model descriptors

The two planned production descriptors for Qwen3-1.7B (see [`../model-choice.md`](../model-choice.md)),
valid against `spec/model-descriptor.schema.json` (a test checks this):

- `qwen3-1.7b.tjs-webgpu-q4f16.descriptor.json`: WebGPU, dtype `q4f16`. This one was loaded in a
  browser once, in the local smoke run (`test/browser/hindi-smoke.spec.ts`), with its entry in a
  manifest signed by the public RFC 8032 test key. Its manifest entry carries
  `minProfile { gpu: webgpu, backendTier: webgpu-f16, ramGb: 8 }`.
- `qwen3-1.7b.tjs-wasm-q8.descriptor.json`: WebAssembly, dtype `q8` (`onnx/model_quantized.onnx`,
  1,742,387,852 B). **Documented only; not run.** Its manifest entry would carry
  `minProfile { backendTier: wasm-simd, ramGb: 8 }`.

Both set `generation.chatTemplateKwargs { "enable_thinking": false }` (thinking mode off) and name the
base model `Qwen/Qwen3-1.7B`'s ONNX conversion `onnx-community/Qwen3-1.7B-ONNX` at revision
`3231b522c6e703b2f9b3cd8ea27426a1289a02f2` (Apache-2.0). The model weights are never in this repository.
