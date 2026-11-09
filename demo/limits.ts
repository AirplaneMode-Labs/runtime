// Generation limits of the backend demo page (models.html).
//
// On WebAssembly the engine runs on the main thread: the tab does not repaint or run timers until
// generation ends, so the page keeps the answer short there (T1-S2-02). WebGPU runs asynchronously on
// the GPU and keeps a longer budget.

export const WASM_MAX_TOKENS = 24;
export const WEBGPU_MAX_TOKENS = 64;

export function maxTokensFor(rung: 'webgpu' | 'wasm' | 'builtin'): number {
  return rung === 'wasm' ? WASM_MAX_TOKENS : WEBGPU_MAX_TOKENS;
}
