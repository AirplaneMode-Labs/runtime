/**
 * Capability profile detection. Reads only: navigator.gpu, deviceMemory, hardwareConcurrency,
 * storage (estimate/persisted/getDirectory), indexedDB, WebAssembly.validate, crossOriginIsolated
 * and SharedArrayBuffer. The user-agent string, client hints, platform and connection info are
 * never read (test/no-egress.test.ts greps this file for them).
 * Adapter details are allow-listed (vendor, architecture, numeric limits); description and device
 * strings are dropped.
 */

import {
  CAPABILITY_DETAILS_ALLOWED_KEYS,
  CAPABILITY_PROFILE_SPEC,
  type BackendTier,
  type CapabilityDetails,
  type CapabilityProfile,
} from '../spec/capability-profile';
import type { EventSink } from '../spec/event';
import { newEvent } from './events';
import { SCHEMAS, validateSchema } from './schema';

export interface GpuAdapterLike {
  features: { has(name: string): boolean } | Iterable<string>;
  limits?: object | undefined;
  info?: object | undefined;
  requestAdapterInfo?: () => Promise<object>;
}

export interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null | undefined>;
}

export interface StorageLike {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  getDirectory?: unknown;
}

/** Everything detectCapabilities reads, abstracted so tests can fake it. */
export interface CapabilityEnv {
  gpu?: GpuLike | undefined;
  deviceMemory?: number | undefined;
  hardwareConcurrency?: number | undefined;
  storage?: StorageLike | undefined;
  indexedDB?: unknown;
  wasmValidate?: ((bytes: Uint8Array) => boolean) | undefined;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  now?: () => Date;
}

export interface GlobalLike {
  navigator?: unknown;
  indexedDB?: unknown;
  WebAssembly?: { validate(bytes: BufferSource): boolean } | undefined;
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
}

/**
 * Minimal valid WebAssembly module whose single function body is `v128.const i32x4 0 0 0 0; drop`.
 * WebAssembly.validate() returns true only on engines with the SIMD proposal.
 */
export const SIMD_PROBE: Uint8Array = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic + version
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00, // type section: () -> ()
  0x03,
  0x02,
  0x01,
  0x00, // function section: one function of type 0
  0x0a,
  0x17,
  0x01,
  0x15,
  0x00, // code section: one body of 21 bytes, no locals
  0xfd,
  0x0c,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0, // v128.const 0
  0x1a, // drop
  0x0b, // end
]);

function safeGet<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Builds an env from globals, touching only the allow-listed navigator properties. */
export function envFromGlobals(g: GlobalLike = globalThis as unknown as GlobalLike): CapabilityEnv {
  const nav = (safeGet(() => g.navigator) ?? {}) as Record<string, unknown>;
  const gpu = safeGet(() => nav['gpu']) as GpuLike | undefined;
  const deviceMemory = safeGet(() => nav['deviceMemory']);
  const hardwareConcurrency = safeGet(() => nav['hardwareConcurrency']);
  const storage = safeGet(() => nav['storage']) as StorageLike | undefined;
  const wasm = safeGet(() => g.WebAssembly);
  const env: CapabilityEnv = {
    gpu: gpu && typeof gpu.requestAdapter === 'function' ? gpu : undefined,
    deviceMemory: typeof deviceMemory === 'number' ? deviceMemory : undefined,
    hardwareConcurrency: typeof hardwareConcurrency === 'number' ? hardwareConcurrency : undefined,
    storage: storage && typeof storage === 'object' ? bindStorage(storage) : undefined,
    indexedDB: safeGet(() => g.indexedDB),
    wasmValidate:
      wasm && typeof wasm.validate === 'function'
        ? (b) => wasm.validate(b as BufferSource)
        : undefined,
    crossOriginIsolated: safeGet(() => g.crossOriginIsolated) === true,
    sharedArrayBuffer: typeof safeGet(() => g.SharedArrayBuffer) === 'function',
  };
  return env;
}

function bindStorage(s: StorageLike): StorageLike {
  const out: StorageLike = {};
  const estimate = safeGet(() => s.estimate);
  const persisted = safeGet(() => s.persisted);
  const getDirectory = safeGet(() => s.getDirectory);
  if (typeof estimate === 'function') out.estimate = () => estimate.call(s);
  if (typeof persisted === 'function') out.persisted = () => persisted.call(s);
  if (typeof getDirectory === 'function') out.getDirectory = getDirectory;
  return out;
}

function hasFeature(adapter: GpuAdapterLike, name: string): boolean {
  const f = adapter.features as { has?: (n: string) => boolean } & Partial<Iterable<string>>;
  if (f && typeof f.has === 'function') return Boolean(safeGet(() => f.has!(name)));
  if (f && typeof (f as Iterable<string>)[Symbol.iterator] === 'function') {
    for (const x of f as Iterable<string>) if (x === name) return true;
  }
  return false;
}

async function adapterDetails(adapter: GpuAdapterLike): Promise<CapabilityDetails | undefined> {
  const details: CapabilityDetails = {};
  let info = safeGet(() => adapter.info) as Record<string, unknown> | undefined;
  if ((!info || typeof info !== 'object') && typeof adapter.requestAdapterInfo === 'function') {
    try {
      info = (await adapter.requestAdapterInfo()) as Record<string, unknown>;
    } catch {
      info = undefined;
    }
  }
  if (info && typeof info === 'object') {
    for (const key of ['vendor', 'architecture'] as const) {
      const v = safeGet(() => info[key]);
      if (typeof v === 'string' && v.length > 0) details[key] = v.slice(0, 64);
    }
  }
  const limits = safeGet(() => adapter.limits) as Record<string, unknown> | undefined;
  if (limits && typeof limits === 'object') {
    for (const key of [
      'maxBufferSize',
      'maxStorageBufferBindingSize',
      'maxComputeWorkgroupStorageSize',
      'maxComputeInvocationsPerWorkgroup',
    ] as const) {
      const v = safeGet(() => limits[key]);
      if (typeof v === 'number' && Number.isFinite(v)) details[key] = v;
    }
  }
  // Belt and braces: only allow-listed keys can be present.
  for (const k of Object.keys(details)) {
    if (!(CAPABILITY_DETAILS_ALLOWED_KEYS as readonly string[]).includes(k))
      delete details[k as keyof CapabilityDetails];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Measures the device once. Resolves within a couple of seconds in Chrome; never throws on a hostile env. */
export async function detectCapabilities(
  env: CapabilityEnv = envFromGlobals(),
  opts: { events?: EventSink } = {},
): Promise<CapabilityProfile> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  let adapter: GpuAdapterLike | undefined;
  if (env.gpu) {
    try {
      adapter = (await env.gpu.requestAdapter()) ?? undefined;
    } catch {
      adapter = undefined;
    }
  }
  const webgpu = adapter !== undefined;
  const shaderF16 = webgpu && hasFeature(adapter!, 'shader-f16');

  let wasmSimd = false;
  let wasm = false;
  if (typeof env.wasmValidate === 'function') {
    wasm = true;
    try {
      wasmSimd = env.wasmValidate(SIMD_PROBE) === true;
    } catch {
      wasmSimd = false;
    }
  }

  let storageFreeGb = 0;
  let persistentStorage = false;
  const storage = env.storage;
  if (storage && typeof storage.estimate === 'function') {
    try {
      const est = await storage.estimate();
      if (
        typeof est?.quota === 'number' &&
        typeof est.usage === 'number' &&
        est.quota >= est.usage
      ) {
        storageFreeGb = Math.round(((est.quota - est.usage) / 2 ** 30) * 100) / 100;
      }
    } catch {
      storageFreeGb = 0;
    }
  }
  if (storage && typeof storage.persisted === 'function') {
    try {
      persistentStorage = (await storage.persisted()) === true;
    } catch {
      persistentStorage = false;
    }
  }

  const backendTier: BackendTier = shaderF16
    ? 'webgpu-f16'
    : webgpu
      ? 'webgpu-f32'
      : wasmSimd
        ? 'wasm-simd'
        : wasm
          ? 'wasm'
          : 'none';

  const ramGb =
    typeof env.deviceMemory === 'number' && env.deviceMemory >= 0 ? env.deviceMemory : 0;
  const cores =
    typeof env.hardwareConcurrency === 'number' &&
    Number.isInteger(env.hardwareConcurrency) &&
    env.hardwareConcurrency >= 1
      ? env.hardwareConcurrency
      : 1;

  const profile: CapabilityProfile = {
    spec: CAPABILITY_PROFILE_SPEC,
    gpu: webgpu ? 'webgpu' : 'none',
    ramGb,
    storageFreeGb,
    cores,
    backendTier,
    features: {
      webgpu,
      shaderF16,
      wasmSimd,
      wasmThreads: env.crossOriginIsolated === true && env.sharedArrayBuffer === true,
      opfs: Boolean(storage && typeof storage.getDirectory === 'function'),
      indexedDb: env.indexedDB !== undefined && env.indexedDB !== null,
      persistentStorage,
    },
    measuredAt: rfc3339(env.now ? env.now() : new Date()),
  };
  if (adapter) {
    const details = await adapterDetails(adapter);
    if (details) profile.details = details;
  }

  const check = validateSchema(SCHEMAS.capabilityProfile, profile);
  if (!check.ok) {
    throw new Error(
      `capability profile failed schema validation: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    );
  }

  if (opts.events) {
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    opts.events.emit(
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'capability.measured',
        level: 'info',
        durationMs: Math.max(0, t1 - t0),
        attrs: { gpu: profile.gpu, backendTier: profile.backendTier },
      }),
    );
  }
  return profile;
}
