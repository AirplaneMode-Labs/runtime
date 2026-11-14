// Generation limits of the backend demo page (models.html).
//
// The engine runs in a worker, so the page stays responsive during generation; WebAssembly is much slower
// than WebGPU, so the page keeps the answer short there. WebGPU keeps a longer budget.

export const WASM_MAX_TOKENS = 24;
export const WEBGPU_MAX_TOKENS = 64;

export function maxTokensFor(rung: 'webgpu' | 'wasm' | 'builtin'): number {
  return rung === 'wasm' ? WASM_MAX_TOKENS : WEBGPU_MAX_TOKENS;
}
