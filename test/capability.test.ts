import { describe, expect, it } from 'vitest';
import { CAPABILITY_DETAILS_ALLOWED_KEYS } from '../spec/capability-profile';
import {
  SIMD_PROBE,
  detectCapabilities,
  envFromGlobals,
  type CapabilityEnv,
  type GpuAdapterLike,
} from '../src/capability';
import { SCHEMAS, validateSchema } from '../src/schema';

/** An 8 GB Windows laptop without WebGPU, SIMD-capable WebAssembly, OPFS and IndexedDB present. */
function laptopEnv(overrides: Partial<CapabilityEnv> = {}): CapabilityEnv {
  return {
    gpu: undefined,
    deviceMemory: 8,
    hardwareConcurrency: 8,
    storage: {
      estimate: async () => ({ usage: 1 * 2 ** 30, quota: 42.27 * 2 ** 30 }),
      persisted: async () => false,
      getDirectory: () => Promise.resolve({}),
    },
    indexedDB: {},
    wasmValidate: (bytes: Uint8Array) => bytes.length > 0,
    crossOriginIsolated: false,
    sharedArrayBuffer: false,
    now: () => new Date('2026-11-09T10:00:00Z'),
    ...overrides,
  };
}

function adapter(
  opts: { f16?: boolean; info?: Record<string, unknown>; limits?: Record<string, unknown> } = {},
): GpuAdapterLike {
  const features = new Set<string>(
    opts.f16 ? ['shader-f16', 'timestamp-query'] : ['timestamp-query'],
  );
  return {
    features,
    limits: {
      maxBufferSize: 2147483648,
      maxStorageBufferBindingSize: 2147483644,
      maxComputeWorkgroupStorageSize: 32768,
      maxComputeInvocationsPerWorkgroup: 1024,
      maxTextureDimension2D: 16384,
      ...opts.limits,
    },
    info: {
      vendor: 'apple',
      architecture: 'metal-3',
      description: 'Apple M2 Pro driver 23.4.1 (fingerprint!)',
      device: 'Apple M2 Pro',
      ...opts.info,
    },
  };
}

describe('detectCapabilities', () => {
  it('no-gpu 8 GB laptop => gpu none, backendTier wasm-simd, ram 8, cores 8, storage to 2 decimals', async () => {
    const p = await detectCapabilities(laptopEnv());
    expect(p.spec).toBe('airplanemode.capability/0.1');
    expect(p.gpu).toBe('none');
    expect(p.backendTier).toBe('wasm-simd');
    expect(p.ramGb).toBe(8);
    expect(p.cores).toBe(8);
    expect(p.storageFreeGb).toBe(41.27);
    expect(p.features).toEqual({
      webgpu: false,
      shaderF16: false,
      wasmSimd: true,
      wasmThreads: false,
      opfs: true,
      indexedDb: true,
      persistentStorage: false,
    });
    expect(p.measuredAt).toBe('2026-11-09T10:00:00Z');
    expect(p.details).toBeUndefined();
    expect(validateSchema(SCHEMAS.capabilityProfile, p).errors).toEqual([]);
  });

  it('adapter with shader-f16 => webgpu, webgpu-f16', async () => {
    const p = await detectCapabilities(
      laptopEnv({ gpu: { requestAdapter: async () => adapter({ f16: true }) } }),
    );
    expect(p.gpu).toBe('webgpu');
    expect(p.backendTier).toBe('webgpu-f16');
    expect(p.features.webgpu).toBe(true);
    expect(p.features.shaderF16).toBe(true);
  });

  it('adapter without shader-f16 => webgpu-f32', async () => {
    const p = await detectCapabilities(
      laptopEnv({ gpu: { requestAdapter: async () => adapter() } }),
    );
    expect(p.backendTier).toBe('webgpu-f32');
    expect(p.features.shaderF16).toBe(false);
  });

  it('requestAdapter returning null or throwing => gpu none', async () => {
    const p1 = await detectCapabilities(laptopEnv({ gpu: { requestAdapter: async () => null } }));
    expect(p1.gpu).toBe('none');
    const p2 = await detectCapabilities(
      laptopEnv({
        gpu: {
          requestAdapter: async () => {
            throw new Error('no gpu');
          },
        },
      }),
    );
    expect(p2.gpu).toBe('none');
    expect(p2.backendTier).toBe('wasm-simd');
  });

  it('unknown deviceMemory => 0; unknown hardwareConcurrency => 1', async () => {
    const p = await detectCapabilities(
      laptopEnv({ deviceMemory: undefined, hardwareConcurrency: undefined }),
    );
    expect(p.ramGb).toBe(0);
    expect(p.cores).toBe(1);
  });

  it('estimate missing or throwing => storageFreeGb 0', async () => {
    const p1 = await detectCapabilities(
      laptopEnv({
        storage: { persisted: async () => true, getDirectory: () => Promise.resolve({}) },
      }),
    );
    expect(p1.storageFreeGb).toBe(0);
    expect(p1.features.persistentStorage).toBe(true);
    const p2 = await detectCapabilities(
      laptopEnv({
        storage: {
          estimate: async () => {
            throw new Error('nope');
          },
        },
      }),
    );
    expect(p2.storageFreeGb).toBe(0);
    expect(p2.features.opfs).toBe(false);
    expect(p2.features.persistentStorage).toBe(false);
  });

  it('no storage object at all => opfs false, persistentStorage false, storageFreeGb 0', async () => {
    const p = await detectCapabilities(laptopEnv({ storage: undefined, indexedDB: undefined }));
    expect(p.features.opfs).toBe(false);
    expect(p.features.indexedDb).toBe(false);
    expect(p.storageFreeGb).toBe(0);
  });

  it('wasm without SIMD => wasm; no WebAssembly => none', async () => {
    const p1 = await detectCapabilities(laptopEnv({ wasmValidate: () => false }));
    expect(p1.backendTier).toBe('wasm');
    expect(p1.features.wasmSimd).toBe(false);
    const p2 = await detectCapabilities(laptopEnv({ wasmValidate: undefined }));
    expect(p2.backendTier).toBe('none');
  });

  it('wasmThreads iff crossOriginIsolated and SharedArrayBuffer', async () => {
    expect(
      (await detectCapabilities(laptopEnv({ crossOriginIsolated: true, sharedArrayBuffer: true })))
        .features.wasmThreads,
    ).toBe(true);
    expect(
      (await detectCapabilities(laptopEnv({ crossOriginIsolated: true, sharedArrayBuffer: false })))
        .features.wasmThreads,
    ).toBe(false);
    expect(
      (await detectCapabilities(laptopEnv({ crossOriginIsolated: false, sharedArrayBuffer: true })))
        .features.wasmThreads,
    ).toBe(false);
  });

  it('details contains only allow-listed keys even when the adapter exposes description and device', async () => {
    const p = await detectCapabilities(
      laptopEnv({ gpu: { requestAdapter: async () => adapter({ f16: true }) } }),
    );
    expect(p.details).toBeDefined();
    const keys = Object.keys(p.details!);
    for (const k of keys) expect(CAPABILITY_DETAILS_ALLOWED_KEYS as readonly string[]).toContain(k);
    expect(keys).not.toContain('description');
    expect(keys).not.toContain('device');
    expect(keys).not.toContain('maxTextureDimension2D');
    expect(p.details).toEqual({
      vendor: 'apple',
      architecture: 'metal-3',
      maxBufferSize: 2147483648,
      maxStorageBufferBindingSize: 2147483644,
      maxComputeWorkgroupStorageSize: 32768,
      maxComputeInvocationsPerWorkgroup: 1024,
    });
    expect(JSON.stringify(p)).not.toContain('fingerprint');
    expect(JSON.stringify(p)).not.toContain('M2 Pro');
    expect(validateSchema(SCHEMAS.capabilityProfile, p).errors).toEqual([]);
  });

  it('non-string vendor/architecture and non-numeric limits are dropped', async () => {
    const p = await detectCapabilities(
      laptopEnv({
        gpu: {
          requestAdapter: async () =>
            adapter({
              info: { vendor: { nested: true }, architecture: 'x' },
              limits: { maxBufferSize: 'big' },
            }),
        },
      }),
    );
    expect(p.details).toMatchObject({ architecture: 'x' });
    expect(p.details).not.toHaveProperty('vendor');
    expect(p.details).not.toHaveProperty('maxBufferSize');
  });

  it('the SIMD probe is a valid wasm module using v128.const (accepted by this Node)', () => {
    expect(SIMD_PROBE.slice(0, 4)).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    expect(WebAssembly.validate(SIMD_PROBE as BufferSource)).toBe(true);
    // Contains the v128.const opcode (0xfd 0x0c).
    const hex = Array.from(SIMD_PROBE, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toContain('fd0c');
  });

  it('caps nothing: ramGb 8 from deviceMemory 8 is reported as is; fractional values kept', async () => {
    const p = await detectCapabilities(laptopEnv({ deviceMemory: 0.5 }));
    expect(p.ramGb).toBe(0.5);
  });
});

describe('envFromGlobals never reads userAgent or userAgentData', () => {
  function trappedNavigator(extra: Record<string, unknown> = {}) {
    const target: Record<string, unknown> = {
      hardwareConcurrency: 4,
      deviceMemory: 4,
      storage: {
        estimate: async () => ({ usage: 0, quota: 2 ** 30 }),
        persisted: async () => false,
      },
      ...extra,
    };
    return new Proxy(target, {
      get(t, prop) {
        if (
          prop === 'userAgent' ||
          prop === 'userAgentData' ||
          prop === 'platform' ||
          prop === 'connection'
        ) {
          throw new Error(`forbidden navigator.${String(prop)} access`);
        }
        return t[prop as string];
      },
      has(t, prop) {
        if (prop === 'userAgent' || prop === 'userAgentData')
          throw new Error('forbidden "in" check');
        return prop in t;
      },
    });
  }

  it('builds an env from a navigator-like object without touching forbidden properties', async () => {
    const env = envFromGlobals({
      navigator: trappedNavigator(),
      indexedDB: {},
      WebAssembly: { validate: (b: BufferSource) => WebAssembly.validate(b) },
      crossOriginIsolated: false,
      SharedArrayBuffer: undefined,
    });
    const p = await detectCapabilities(env);
    expect(p.cores).toBe(4);
    expect(p.ramGb).toBe(4);
    expect(p.features.indexedDb).toBe(true);
    expect(p.backendTier).toBe('wasm-simd');
    expect(p.storageFreeGb).toBe(1);
  });

  it('works against this process globals (Node has navigator without gpu)', async () => {
    const p = await detectCapabilities();
    expect(p.gpu).toBe('none');
    expect(p.cores).toBeGreaterThanOrEqual(1);
    expect(validateSchema(SCHEMAS.capabilityProfile, p).errors).toEqual([]);
  });

  it('a navigator whose every property throws still yields a valid profile', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile');
        },
      },
    );
    const p = await detectCapabilities(envFromGlobals({ navigator: hostile }));
    expect(p.gpu).toBe('none');
    expect(p.cores).toBe(1);
    expect(p.ramGb).toBe(0);
    expect(validateSchema(SCHEMAS.capabilityProfile, p).errors).toEqual([]);
  });
});
