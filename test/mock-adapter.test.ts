import { describe, expect, it } from 'vitest';
import { AdapterError, type AssetHandle, type AssetSource } from '../spec/backend-adapter';
import type { CapabilityProfile } from '../spec/capability-profile';
import type { ManifestEntry } from '../spec/manifest';
import { MockAdapter } from '../src/backends/mock';
import { EventBus } from '../src/events';
import { makeEntry } from './helpers';

const profile: CapabilityProfile = {
  spec: 'airplanemode.capability/0.1',
  gpu: 'none',
  ramGb: 8,
  storageFreeGb: 10,
  cores: 4,
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
};

function fakeAssets(entry: ManifestEntry) {
  const released: string[] = [];
  const acquired: string[] = [];
  const blobs: string[] = [];
  const assets: AssetSource = {
    getEntry: () => entry,
    async getBlob(id) {
      blobs.push(id);
      return new Blob([new Uint8Array([1, 2, 3])]);
    },
    async acquire(id): Promise<AssetHandle> {
      acquired.push(id);
      return {
        entryId: id,
        sha256: entry.sha256,
        size: entry.size,
        held: true,
        release: () => released.push(id),
      };
    },
  };
  return { assets, released, acquired, blobs };
}

describe('MockAdapter', () => {
  it('reports id, tier and capabilities', () => {
    const a = new MockAdapter();
    expect(a.id).toBe('mock');
    expect(a.tier).toBe('none');
    expect(a.capabilities()).toEqual({ generate: true, embed: true, streaming: true });
  });

  it('generate/embed before load reject with not_loaded', async () => {
    const a = new MockAdapter();
    await expect(a.generate('hi')).rejects.toMatchObject({ code: 'not_loaded' });
    await expect(a.embed(['hi'])).rejects.toMatchObject({ code: 'not_loaded' });
  });

  it('load rejects unsupported_profile when the entry needs more than the device has', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model', minProfile: { gpu: 'webgpu' } });
    const { assets, acquired } = fakeAssets(entry);
    await expect(a.load(entry, { assets, profile })).rejects.toBeInstanceOf(AdapterError);
    await expect(a.load(entry, { assets, profile })).rejects.toMatchObject({
      code: 'unsupported_profile',
    });
    expect(acquired).toEqual([]);
  });

  it('load acquires a handle, unload releases it; load never fetches', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    const { assets, acquired, released } = fakeAssets(entry);
    const events = new EventBus();
    await a.load(entry, { assets, profile, events });
    expect(acquired).toEqual(['m']);
    expect(events.snapshot().some((e) => e.kind === 'model-load')).toBe(true);
    await a.unload();
    expect(released).toEqual(['m']);
    await expect(a.generate('x')).rejects.toMatchObject({ code: 'not_loaded' });
  });

  it('load works with an AssetSource that lacks acquire()', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    const { assets } = fakeAssets(entry);
    delete (assets as { acquire?: unknown }).acquire;
    await a.load(entry, { assets, profile });
    expect((await a.generate('ok')).text).toBe('ok');
  });

  it('echo generation returns the prompt text and streams whitespace tokens', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    await a.load(entry, { assets: fakeAssets(entry).assets, profile });
    const tokens: string[] = [];
    const r = await a.generate('hello offline world', { onToken: (t) => tokens.push(t) });
    expect(r.text).toBe('hello offline world');
    expect(tokens.join('')).toBe('hello offline world');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.completionTokens).toBe(3);
    expect(r.timings.decodeMs).toBeGreaterThanOrEqual(0);
  });

  it('echoes the last user message of a chat and honours maxTokens with finishReason length', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    await a.load(entry, { assets: fakeAssets(entry).assets, profile });
    const r = await a.generate(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'one two three four five' },
      ],
      { maxTokens: 2 },
    );
    expect(r.text).toBe('one two');
    expect(r.finishReason).toBe('length');
  });

  it('abort signal => finishReason abort', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    await a.load(entry, { assets: fakeAssets(entry).assets, profile });
    const ac = new AbortController();
    ac.abort();
    const r = await a.generate('a b c', { signal: ac.signal });
    expect(r.finishReason).toBe('abort');
  });

  it('embeddings are 64-dim, unit length, deterministic and differ between texts', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    await a.load(entry, { assets: fakeAssets(entry).assets, profile });
    const r = await a.embed(['नमस्ते', 'hello', 'नमस्ते']);
    expect(r.dims).toBe(64);
    expect(r.normalized).toBe(true);
    expect(r.vectors).toHaveLength(3);
    for (const v of r.vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(64);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
    }
    expect(Array.from(r.vectors[0]!)).toEqual(Array.from(r.vectors[2]!));
    expect(Array.from(r.vectors[0]!)).not.toEqual(Array.from(r.vectors[1]!));
  });

  it('embed of an empty list returns no vectors', async () => {
    const a = new MockAdapter();
    const entry = makeEntry('m', { kind: 'model' });
    await a.load(entry, { assets: fakeAssets(entry).assets, profile });
    const r = await a.embed([]);
    expect(r.vectors).toEqual([]);
    expect(r.dims).toBe(64);
  });
});
