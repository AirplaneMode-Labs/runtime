# Backend adapter 0.1.0

Normative definition: `backend-adapter.ts`. One interface over WebLLM, Transformers.js (ONNX
Runtime Web) and the Chrome Prompt API, so the fallback chain WebGPU -> WASM -> built-in can pick a
backend without the application changing.

## Shape

```ts
interface BackendAdapter {
  readonly id: 'webllm' | 'transformers-js' | 'chrome-prompt-api' | (string & {});
  readonly tier: BackendTier;
  capabilities(): { generate: boolean; embed: boolean; streaming: boolean };
  load(entry: ManifestEntry, opts: LoadOptions): Promise<void>;
  generate(prompt: string | ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<EmbedResult>;
  unload(): Promise<void>;
}
```

`LoadOptions = { assets: AssetSource; profile: CapabilityProfile; signal?; events? }`.

## Rules

- `load()` rejects with `AdapterError("unsupported_profile")` when
  `!satisfies(opts.profile, entry.minProfile)`.
- An adapter never fetches the network itself. Every byte comes from the `AssetSource`, which only
  hands out fully verified files (`getBlob` rejects `not_verified` otherwise).
- When the source offers `acquire()`, the adapter acquires a refcounted `AssetHandle` in `load()`
  and holds it until `unload()`; held assets are never evicted.
- `generate()` streams through `onToken` when `capabilities().streaming` is true and honours
  `signal` (`finishReason: 'abort'`) and `maxTokens` (`finishReason: 'length'`).
- `embed()` returns `{ vectors, dims, normalized }`; `normalized` is true when every vector has unit
  length.
- Calling `generate()` or `embed()` before `load()` rejects with `AdapterError("not_loaded")`; an
  operation the backend lacks rejects with `unsupported_operation`; backend failures surface as
  `backend` with `cause` set.

## Sprint 1 scope

The interface, `AdapterError` and a `MockAdapter` (`src/backends/mock.ts`: echo generation,
deterministic hashed 64-dimension embeddings) ship now and are used by tests and dockit stubs. Real
adapters and the WebGPU -> WASM fallback chain are Sprint 2.
