// D1-02: cacheOnly enforced at acquire() (AcquireOptions.cacheOnly, S1-053 rest) and carried through the
// chain (R10). Written before the implementation: red-D1-02.log precedes green-D1-02.log.

import { describe, expect, it, vi } from 'vitest';
import type { AssetSource, BackendAdapter } from '../spec/backend-adapter';
import { loadWithFallback, type LoadWithFallbackOptions } from '../src/backends/chain';
import { createTransformersAdapter } from '../src/backends/transformers';
import { AssetError } from '../src/errors';
import { EventBus } from '../src/events';
import type { PartState } from '../src/store/types';
import {
  ORT_FACTORY_URL,
  PREFIX,
  eventsNamed,
  installLocation,
  makeWorld,
  mockEngine,
  pinsFor,
  profileOf,
  type World,
} from './backends-helpers';

const downloadEvents = (w: World) =>
  w.events
    .snapshot()
    .map((e) => e.name)
    .filter((n) => n.startsWith('asset.download'));

async function expectNotCached(p: Promise<unknown>): Promise<AssetError> {
  try {
    await p;
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(AssetError);
    expect((e as AssetError).code).toBe('not_cached');
    return e as AssetError;
  }
  throw new Error('expected AssetError not_cached');
}

/** A complete or partial part with its state, as an interrupted download leaves it. */
async function writePart(w: World, id: string, bytes: Uint8Array): Promise<void> {
  const e = w.entries[id]!;
  const state: PartState = {
    sha256: e.sha256,
    size: e.size,
    url: e.url,
    chunkSize: 1048576,
    bytesWritten: bytes.length,
    updatedAt: Date.now(),
  };
  await w.store.openPart(e.sha256);
  await w.store.appendPart(e.sha256, bytes);
  await w.store.writePartState(e.sha256, state);
}

describe('acquire({ cacheOnly: true }): a miss rejects not_cached with no network and no download event', () => {
  it('no index row and no file', async () => {
    const w = await makeWorld();
    const err = await expectNotCached(w.mgr.acquire('m.onnx-q4', { cacheOnly: true }));
    expect(err.message).not.toMatch(/https?:\/\//);
    expect(w.server.calls).toBe(0);
    expect(w.server.requests).toHaveLength(0);
    expect(downloadEvents(w)).toEqual([]);
    expect(await w.store.partLength(w.entries['m.onnx-q4']!.sha256)).toBe(0);
  });

  it('a row without its file', async () => {
    const w = await makeWorld();
    (await w.mgr.ensure('m.onnx-q4')).release();
    const sha = w.entries['m.onnx-q4']!.sha256;
    await w.store.remove(sha);
    w.server.reset();
    w.events.clear();
    await expectNotCached(w.mgr.acquire('m.onnx-q4', { cacheOnly: true }));
    expect(w.server.calls).toBe(0);
    expect(downloadEvents(w)).toEqual([]);
    expect(await w.store.fileSize(sha)).toBeUndefined();
  });

  it('a truncated file (committed bytes shorter than the manifest size)', async () => {
    const w = await makeWorld();
    (await w.mgr.ensure('m.onnx-q4')).release();
    const e = w.entries['m.onnx-q4']!;
    await w.store.remove(e.sha256);
    await w.store.openPart(e.sha256);
    await w.store.appendPart(e.sha256, new Uint8Array(e.size - 10));
    await w.store.commit(e.sha256);
    expect(await w.store.fileSize(e.sha256)).toBe(e.size - 10);
    w.server.reset();
    w.events.clear();
    await expectNotCached(w.mgr.acquire('m.onnx-q4', { cacheOnly: true }));
    expect(w.server.calls).toBe(0);
    expect(downloadEvents(w)).toEqual([]);
  });

  it('a complete .part with no committed file is never read, committed, resumed or removed', async () => {
    const w = await makeWorld();
    const id = 'm.onnx-q4';
    const e = w.entries[id]!;
    const full = new Uint8Array(e.size).fill(7);
    await writePart(w, id, full);
    const commit = vi.spyOn(w.store, 'commit');
    const read = vi.spyOn(w.store, 'readPart');
    await expectNotCached(w.mgr.acquire(id, { cacheOnly: true }));
    expect(commit).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(w.server.calls).toBe(0);
    expect(w.server.requests.some((r) => r.range !== undefined)).toBe(false);
    expect(downloadEvents(w)).toEqual([]);
    expect(await w.store.partLength(e.sha256)).toBe(e.size);
    expect(await w.store.fileSize(e.sha256)).toBeUndefined();
    expect(await w.store.partState(e.sha256)).toBeDefined();
  });

  it('a partial .part is left alone too, and no Range header is ever sent', async () => {
    const w = await makeWorld();
    const id = 'm.onnx-q4';
    const e = w.entries[id]!;
    await writePart(w, id, new Uint8Array(1048576 > e.size ? 0 : 1048576));
    await expectNotCached(w.mgr.acquire(id, { cacheOnly: true }));
    expect(w.server.requests).toHaveLength(0);
    expect(await w.store.partState(e.sha256)).toBeDefined();
  });

  it('the miss path never evaluates the download policy: no asset.download.blocked either', async () => {
    const w = await makeWorld();
    // an entry whose url is outside allowedOrigins would emit asset.download.blocked on a normal acquire
    const e = w.mgr.getEntry('m.config');
    (e as { url: string }).url = 'https://elsewhere.invalid/m.config';
    await expectNotCached(w.mgr.acquire('m.config', { cacheOnly: true }));
    expect(downloadEvents(w)).toEqual([]);
    expect(w.server.calls).toBe(0);
  });
});

describe('acquire({ cacheOnly: true }): a hit', () => {
  it('resolves a held handle for a verified row with a stored file of exactly entry.size, with no request', async () => {
    const w = await makeWorld();
    (await w.mgr.ensure('m.onnx-q4')).release();
    w.server.reset();
    w.events.clear();
    const h = await w.mgr.acquire('m.onnx-q4', { cacheOnly: true });
    expect(h.held).toBe(true);
    expect(h.entryId).toBe('m.onnx-q4');
    expect((await w.mgr.list()).find((r) => r.entryId === 'm.onnx-q4')!.refcount).toBe(1);
    expect(w.server.calls).toBe(0);
    expect(downloadEvents(w)).toEqual([]);
    const blob = await w.mgr.getBlob('m.onnx-q4', { rehash: true });
    expect(blob.size).toBe(w.entries['m.onnx-q4']!.size);
    h.release();
  });

  it('does not rehash: a flipped byte of the right length is still accepted at acquire and refused at getBlob (R2)', async () => {
    const w = await makeWorld();
    (await w.mgr.ensure('m.onnx-q4')).release();
    const sha = w.entries['m.onnx-q4']!.sha256;
    const bytes = new Uint8Array(await (await w.store.readBlob(sha)).arrayBuffer());
    bytes[3] = bytes[3]! ^ 1;
    w.store.corruptBin(sha, bytes);
    const h = await w.mgr.acquire('m.onnx-q4', { cacheOnly: true });
    await expect(w.mgr.getBlob('m.onnx-q4', { rehash: true })).rejects.toBeInstanceOf(AssetError);
    h.release();
  });

  it('without cacheOnly a miss still downloads (the default is unchanged)', async () => {
    const w = await makeWorld();
    const h = await w.mgr.acquire('m.config');
    expect(w.server.calls).toBeGreaterThan(0);
    h.release();
  });
});

describe('the chain loads a rung that needs no download with cacheOnly (R10)', () => {
  const profile = profileOf('webgpu-f16');

  function adapters(w: World, engine: ReturnType<typeof mockEngine>, spy: (o: unknown) => void) {
    const mk = (device: 'webgpu' | 'wasm') => {
      const inner = createTransformersAdapter({
        device,
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: PREFIX,
        pins: pinsFor(),
        gpuProbe: async () => true,
        engine: async () => engine.module as never,
      });
      return new Proxy(inner, {
        get(target, prop) {
          if (prop === 'load')
            return (entry: unknown, opts: Record<string, unknown>) => {
              spy(opts['cacheOnly']);
              return (target.load as (e: unknown, o: unknown) => Promise<void>)(entry, opts);
            };
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as BackendAdapter;
    };
    void w;
    return [mk('webgpu'), mk('wasm')];
  }

  const base = (w: World, over: Partial<LoadWithFallbackOptions>): LoadWithFallbackOptions => ({
    profile,
    assets: w.mgr,
    models: ['m.descriptor'],
    ...over,
  });

  it('plan 0 bytes: load gets cacheOnly true; after an approved download it is false', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      const seen: unknown[] = [];
      const engine = mockEngine();
      const list = adapters(w, engine, (v) => seen.push(v));
      // cold store: needs bytes, the caller approves
      const r = await loadWithFallback(
        base(w, { adapters: list, beforeDownload: async () => true, events: new EventBus() }),
      );
      expect(r.rung).toBe('webgpu');
      expect(seen).toEqual([false]);
      await r.adapter.unload();
      // warm store: plan 0 bytes, no consent is asked and the load is cache-only
      const asked = vi.fn(async () => true);
      seen.length = 0;
      const r2 = await loadWithFallback(
        base(w, { adapters: list, beforeDownload: asked, events: new EventBus() }),
      );
      expect(asked).not.toHaveBeenCalled();
      expect(seen).toEqual([true]);
      await r2.adapter.unload();
    } finally {
      restore();
    }
  });

  it('the plan-then-delete race: a file removed after the plan gives 0 requests, the rung declined and "Nothing was downloaded"', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
      w.server.reset();
      const sha = w.entries['m.onnx-q4']!.sha256;
      const engine = mockEngine();
      const events = new EventBus();
      const [gpuInner, wasmInner] = adapters(w, engine, () => {});
      // the race: the weights disappear between planDownload() and load()
      const racing = (a: BackendAdapter): BackendAdapter =>
        new Proxy(a, {
          get(t, p) {
            if (p === 'load')
              return async (e: never, o: never) => {
                await w.store.remove(sha);
                return t.load(e, o);
              };
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
          },
        });
      let error: unknown;
      try {
        await loadWithFallback(
          base(w, {
            adapters: [racing(gpuInner!), wasmInner!],
            profile: profileOf('webgpu-f16'),
            events,
            // an approval is never asked on a rung whose plan is 0 bytes; the second rung finds the
            // file gone and is asked: the caller declines, so nothing may be fetched
            beforeDownload: async () => false,
          }),
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      const attempts = (error as { attempts: { rung: string; outcome: string; reason: string }[] })
        .attempts;
      expect(attempts[0]).toMatchObject({
        rung: 'webgpu',
        outcome: 'declined',
        reason: 'declined',
      });
      expect(w.server.calls).toBe(0);
      expect((error as { userMessage: string }).userMessage).toContain('Nothing was downloaded');
      expect(eventsNamed(events, 'backend.select')[0]!.attrs['reason']).toBe('declined');
    } finally {
      restore();
    }
  });
});

describe('the adapter passes cacheOnly to every acquire()', () => {
  it('LoadOptions.cacheOnly reaches the descriptor acquire and every file acquire', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
      const spy = vi.spyOn(w.mgr, 'acquire');
      const engine = mockEngine();
      const a = createTransformersAdapter({
        device: 'wasm',
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: PREFIX,
        pins: pinsFor(),
        engine: async () => engine.module as never,
      });
      await a.load(w.descriptorEntry, {
        assets: w.mgr as AssetSource,
        profile: profileOf('wasm-simd'),
        cacheOnly: true,
      });
      expect(spy.mock.calls.length).toBe(w.fileIds.length + 1);
      for (const c of spy.mock.calls)
        expect((c[1] as { cacheOnly?: boolean }).cacheOnly).toBe(true);
      await a.unload();
    } finally {
      restore();
    }
  });

  it('a cold store with cacheOnly: load rejects not_cached, nothing was fetched, every handle released', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      const engine = mockEngine();
      const a = createTransformersAdapter({
        device: 'wasm',
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: PREFIX,
        pins: pinsFor(),
        engine: async () => engine.module as never,
      });
      await expect(
        a.load(w.descriptorEntry, {
          assets: w.mgr as AssetSource,
          profile: profileOf('wasm-simd'),
          cacheOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'not_cached' });
      expect(w.server.calls).toBe(0);
      expect(engine.pipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
