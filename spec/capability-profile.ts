/**
 * Capability profile contract 0.1.0 (airplanemode.capability/0.1).
 *
 * Normative JSON Schema: capability-profile.schema.json
 * ($id urn:airplanemode:spec:capability-profile:0.1.0).
 *
 * Measured once per page load by the runtime (`detectCapabilities()`), used by manifests
 * (MinProfile), by the backend fallback chain and later by control-plane policy.
 * Never contains the user-agent string, client hints, adapter description or device strings.
 */

export const CAPABILITY_PROFILE_SPEC = 'airplanemode.capability/0.1' as const;
export type CapabilityProfileSpec = typeof CAPABILITY_PROFILE_SPEC;

/** Ranked backend tiers, best first. */
export type BackendTier = 'webgpu-f16' | 'webgpu-f32' | 'wasm-simd' | 'wasm' | 'none';

/** Numeric rank of each tier for `satisfies()` comparisons. */
export const BACKEND_TIER_RANK: Readonly<Record<BackendTier, number>> = Object.freeze({
  'webgpu-f16': 4,
  'webgpu-f32': 3,
  'wasm-simd': 2,
  wasm: 1,
  none: 0,
});

export type GpuKind = 'webgpu' | 'none';

export interface CapabilityFeatures {
  /** navigator.gpu.requestAdapter() returned an adapter. */
  webgpu: boolean;
  /** adapter.features has "shader-f16". */
  shaderF16: boolean;
  /** WebAssembly.validate accepts the v128 SIMD probe module. */
  wasmSimd: boolean;
  /** crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'. */
  wasmThreads: boolean;
  /** navigator.storage.getDirectory exists. */
  opfs: boolean;
  indexedDb: boolean;
  /** await navigator.storage.persisted(). */
  persistentStorage: boolean;
}

/** The only keys permitted in `details`. Everything else is dropped by the runtime. */
export const CAPABILITY_DETAILS_ALLOWED_KEYS = Object.freeze([
  'vendor',
  'architecture',
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
] as const);

export type CapabilityDetailKey = (typeof CAPABILITY_DETAILS_ALLOWED_KEYS)[number];

export type CapabilityDetails = Partial<
  Record<CapabilityDetailKey, string | number | boolean | null>
>;

export interface CapabilityProfile {
  spec: CapabilityProfileSpec;
  /** webgpu iff requestAdapter() returned an adapter. */
  gpu: GpuKind;
  /** navigator.deviceMemory (browsers cap at 8); 0 = unknown. */
  ramGb: number;
  /** (quota - usage) / 2^30 to 2 decimals; 0 if unknown. */
  storageFreeGb: number;
  /** hardwareConcurrency; 1 if unknown. */
  cores: number;
  backendTier: BackendTier;
  features: CapabilityFeatures;
  /** RFC 3339 UTC `YYYY-MM-DDTHH:MM:SSZ`. */
  measuredAt: string;
  /** Allow-listed adapter details only (vendor, architecture, numeric limits). */
  details?: CapabilityDetails;
}
