import { describe, expect, it } from 'vitest';
import type { BackendTier, CapabilityProfile } from '../spec/capability-profile';
import { BACKEND_TIER_RANK } from '../spec/capability-profile';
import type { MinProfile } from '../spec/manifest';
import { satisfies } from '../src/satisfies';

function profile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    spec: 'airplanemode.capability/0.1',
    gpu: 'none',
    ramGb: 8,
    storageFreeGb: 40,
    cores: 8,
    backendTier: 'wasm-simd',
    features: {
      webgpu: false,
      shaderF16: false,
      wasmSimd: true,
      wasmThreads: false,
      opfs: true,
      indexedDb: true,
      persistentStorage: false,
    },
    measuredAt: '2026-11-09T00:00:00Z',
    ...overrides,
  };
}

describe('satisfies', () => {
  it('empty minProfile matches any device, including a zero-everything one', () => {
    expect(satisfies(profile(), {})).toBe(true);
    expect(
      satisfies(profile({ ramGb: 0, storageFreeGb: 0, cores: 1, backendTier: 'none' }), {}),
    ).toBe(true);
  });

  it('gpu: absent or none matches anything; webgpu requires a webgpu device', () => {
    expect(satisfies(profile({ gpu: 'none' }), { gpu: 'none' })).toBe(true);
    expect(satisfies(profile({ gpu: 'webgpu' }), { gpu: 'none' })).toBe(true);
    expect(satisfies(profile({ gpu: 'none' }), { gpu: 'webgpu' })).toBe(false);
    expect(satisfies(profile({ gpu: 'webgpu' }), { gpu: 'webgpu' })).toBe(true);
  });

  it('ramGb, storageFreeGb and cores are >= comparisons', () => {
    expect(satisfies(profile({ ramGb: 8 }), { ramGb: 8 })).toBe(true);
    expect(satisfies(profile({ ramGb: 8 }), { ramGb: 9 })).toBe(false);
    expect(satisfies(profile({ ramGb: 0 }), { ramGb: 1 })).toBe(false);
    expect(satisfies(profile({ storageFreeGb: 1.5 }), { storageFreeGb: 1 })).toBe(true);
    expect(satisfies(profile({ storageFreeGb: 0.99 }), { storageFreeGb: 1 })).toBe(false);
    expect(satisfies(profile({ cores: 4 }), { cores: 4 })).toBe(true);
    expect(satisfies(profile({ cores: 3 }), { cores: 4 })).toBe(false);
  });

  const tiers: BackendTier[] = ['none', 'wasm', 'wasm-simd', 'webgpu-f32', 'webgpu-f16'];
  it('tier ranks are none 0 < wasm 1 < wasm-simd 2 < webgpu-f32 3 < webgpu-f16 4', () => {
    expect(BACKEND_TIER_RANK).toEqual({
      'webgpu-f16': 4,
      'webgpu-f32': 3,
      'wasm-simd': 2,
      wasm: 1,
      none: 0,
    });
  });

  for (const have of tiers) {
    for (const need of tiers) {
      it(`backendTier ${have} satisfies ${need}: ${BACKEND_TIER_RANK[have] >= BACKEND_TIER_RANK[need]}`, () => {
        expect(satisfies(profile({ backendTier: have }), { backendTier: need })).toBe(
          BACKEND_TIER_RANK[have] >= BACKEND_TIER_RANK[need],
        );
      });
    }
  }

  it('all five fields together: any single failing field fails', () => {
    const min: MinProfile = {
      gpu: 'webgpu',
      ramGb: 8,
      storageFreeGb: 2,
      cores: 4,
      backendTier: 'webgpu-f32',
    };
    const good = profile({
      gpu: 'webgpu',
      ramGb: 8,
      storageFreeGb: 2,
      cores: 4,
      backendTier: 'webgpu-f16',
    });
    expect(satisfies(good, min)).toBe(true);
    expect(satisfies({ ...good, gpu: 'none' }, min)).toBe(false);
    expect(satisfies({ ...good, ramGb: 7.9 }, min)).toBe(false);
    expect(satisfies({ ...good, storageFreeGb: 1 }, min)).toBe(false);
    expect(satisfies({ ...good, cores: 2 }, min)).toBe(false);
    expect(satisfies({ ...good, backendTier: 'wasm-simd' }, min)).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const p = profile();
    const m: MinProfile = { ramGb: 1 };
    const before = JSON.stringify([p, m]);
    satisfies(p, m);
    expect(JSON.stringify([p, m])).toBe(before);
  });
});
