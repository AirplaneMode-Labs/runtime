// D1-02: a file that fails its hash check is reported as 'integrity' (T1-S2-07), never as "could not
// be started", and the next rung does not download it again (R9). Written before the implementation.

import { describe, expect, it, vi } from 'vitest';
import {
  AdapterError,
  type AdapterCapabilities,
  type AssetSource,
  type BackendAdapter,
  type ExecutionDevice,
  type LoadOptions,
} from '../spec/backend-adapter';
import {
  BackendRefusedError,
  loadWithFallback,
  type AttemptReason,
  type LoadWithFallbackOptions,
} from '../src/backends/chain';
import { createTransformersAdapter } from '../src/backends/transformers';
import { AssetError } from '../src/errors';
import { EventBus, newEvent } from '../src/events';
import {
  ONNX_BYTES,
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

const flipped = (b: Uint8Array, at = 5): Uint8Array => {
  const c = b.slice();
  c[at] = c[at]! ^ 0x01;
  return c;
};

function realAdapter(device: 'webgpu' | 'wasm', engine = mockEngine()) {
  return {
    engine,
    adapter: createTransformersAdapter({
      device,
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
      pins: pinsFor(),
      gpuProbe: async () => true,
      engine: async () => engine.module as never,
    }),
  };
}

const getsOf = (w: World, id: string) =>
  w.server.requests.filter((r) => r.method === 'GET' && r.url.endsWith(`/assets/${id}`)).length;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('the adapter maps a failed hash check to integrity (T1-S2-07)', () => {
  it('a flipped byte at download: AdapterError integrity naming the entry, the AssetError kept as cause', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      w.server.addAsset('m.onnx-q4', flipped(ONNX_BYTES));
      const { adapter, engine } = realAdapter('wasm');
      const events = new EventBus();
      const e = (await rejection(
        adapter.load(w.descriptorEntry, {
          assets: w.mgr as AssetSource,
          profile: profileOf('wasm-simd'),
          events,
        }),
      )) as AdapterError & { entryId?: string };
      expect(e).toBeInstanceOf(AdapterError);
      expect(e.code).toBe('integrity');
      expect(e.entryId).toBe('m.onnx-q4');
      expect((e.cause as AssetError).code).toBe('hash_mismatch');
      expect(e.message).not.toMatch(/could not be started/);
      expect(engine.pipeline).not.toHaveBeenCalled();
      const failed = eventsNamed(events, 'model.load.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.attrs['code']).toBe('integrity');
      expect(getsOf(w, 'm.onnx-q4')).toBe(1);
    } finally {
      restore();
    }
  });

  it('a flipped byte after verification (the R2 re-hash at getBlob): integrity, before any engine call', async () => {
    const restore = installLocation();
    try {
      for (const id of ['m.descriptor', 'm.onnx-q4', 'ort.wasm']) {
        const w = await makeWorld();
        for (const x of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(x)).release();
        const sha = w.entries[id]!.sha256;
        const bytes = new Uint8Array(await (await w.store.readBlob(sha)).arrayBuffer());
        w.store.corruptBin(sha, flipped(bytes, bytes.length >> 1));
        const { adapter, engine } = realAdapter('wasm');
        const e = (await rejection(
          adapter.load(w.descriptorEntry, {
            assets: w.mgr as AssetSource,
            profile: profileOf('wasm-simd'),
          }),
        )) as AdapterError & { entryId?: string };
        expect(e, id).toBeInstanceOf(AdapterError);
        expect(e.code, id).toBe('integrity');
        expect(e.entryId, id).toBe(id);
        expect(engine.pipeline, id).not.toHaveBeenCalled();
        expect(
          (await w.mgr.list()).every((r) => r.refcount === 0),
          id,
        ).toBe(true);
      }
    } finally {
      restore();
    }
  });

  it('getBlob error mapping: NotFoundError and a missing file are not_cached; NotReadableError and a size change are integrity', async () => {
    const restore = installLocation();
    try {
      const id = 'm.onnx-q4';
      // each arrangement runs right after acquire(m.onnx-q4) resolved: the change happens between
      // acquire and the R2 re-hash, so it is getBlob that has to notice
      const readFails = (w: World, sha: string, name: string) => {
        const real = w.store.readBlob.bind(w.store);
        vi.spyOn(w.store, 'readBlob').mockImplementation(async (x) => {
          if (x === sha) throw new DOMException('x', name);
          return real(x);
        });
      };
      const cases: [string, (w: World, sha: string) => void | Promise<void>, string][] = [
        [
          'NotFoundError from readBlob',
          (w, sha) => readFails(w, sha, 'NotFoundError'),
          'not_cached',
        ],
        [
          'the file is gone',
          async (w, sha) => {
            await w.store.remove(sha);
          },
          'not_cached',
        ],
        [
          'NotReadableError from readBlob (the OPFS snapshot changed)',
          (w, sha) => readFails(w, sha, 'NotReadableError'),
          'integrity',
        ],
        [
          'a size change',
          async (w, sha) => {
            const b = new Uint8Array(await (await w.store.readBlob(sha)).arrayBuffer());
            w.store.corruptBin(sha, b.slice(0, b.length - 3));
          },
          'integrity',
        ],
      ];
      for (const [label, arrange, code] of cases) {
        const w = await makeWorld();
        for (const x of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(x)).release();
        w.server.reset();
        const realAcquire = w.mgr.acquire.bind(w.mgr);
        vi.spyOn(w.mgr, 'acquire').mockImplementation(async (x, o) => {
          const h = await realAcquire(x, o);
          if (x === id) await arrange(w, w.entries[id]!.sha256);
          return h;
        });
        const { adapter, engine } = realAdapter('wasm');
        const e = (await rejection(
          adapter.load(w.descriptorEntry, {
            assets: w.mgr as AssetSource,
            profile: profileOf('wasm-simd'),
          }),
        )) as AdapterError & { entryId?: string };
        expect(e, label).toBeInstanceOf(AdapterError);
        expect(e.code, label).toBe(code);
        expect(e.entryId, label).toBe(id);
        expect(engine.pipeline, label).not.toHaveBeenCalled();
        expect(
          (await w.mgr.list()).every((r) => r.refcount === 0),
          label,
        ).toBe(true);
      }
    } finally {
      restore();
    }
  });
});

describe('S1-073: an unreadable stream during the R2 re-hash is integrity', () => {
  it('getBlob(rehash) maps a NotReadableError from the stream to AssetError not_verified/unreadable, drops the row and emits asset.verify.failed', async () => {
    const w = await makeWorld();
    const id = 'm.onnx-q4';
    (await w.mgr.ensure(id)).release();
    const sha = w.entries[id]!.sha256;
    const real = w.store.readBlob.bind(w.store);
    vi.spyOn(w.store, 'readBlob').mockImplementation(async (x) => {
      const b = await real(x);
      if (x !== sha) return b;
      return Object.assign(b, {
        stream: () =>
          new ReadableStream({
            pull() {
              throw new DOMException('changed', 'NotReadableError');
            },
          }),
      });
    });
    const e = (await rejection(w.mgr.getBlob(id, { rehash: true }))) as AssetError;
    expect(e).toBeInstanceOf(AssetError);
    expect(e.code).toBe('not_verified');
    expect(e.reason).toBe('unreadable');
    expect(await w.mgr.has(id)).toBe(false);
    expect(eventsNamed(w.events, 'asset.verify.failed').length).toBeGreaterThan(0);
  });
});

describe('the chain: one integrity failure, one GET per path, an honest message (R9)', () => {
  const profile = profileOf('webgpu-f16');

  it('flipped byte in the weights: the WebGPU rung fails integrity; the WASM rung needing the same entry is failed/integrity with no consent question and no load', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      w.server.addAsset('m.onnx-q4', flipped(ONNX_BYTES));
      const gpu = realAdapter('webgpu');
      const wasm = realAdapter('wasm');
      const wasmLoad = vi.spyOn(wasm.adapter, 'load');
      const asked: unknown[] = [];
      const events = new EventBus();
      const opts: LoadWithFallbackOptions = {
        profile,
        assets: w.mgr,
        models: ['m.descriptor'],
        adapters: [gpu.adapter, wasm.adapter],
        events,
        beforeDownload: async (info) => {
          asked.push(info);
          return true;
        },
      };
      const err = (await rejection(loadWithFallback(opts))) as BackendRefusedError;
      expect(err).toBeInstanceOf(BackendRefusedError);
      expect(err.attempts.slice(0, 2)).toEqual([
        {
          rung: 'webgpu',
          adapter: 'transformers-js',
          model: 'm.descriptor',
          outcome: 'failed',
          reason: 'integrity',
        },
        {
          rung: 'wasm',
          adapter: 'transformers-js',
          model: 'm.descriptor',
          outcome: 'failed',
          reason: 'integrity',
        },
      ]);
      expect(asked).toHaveLength(1); // webgpu only
      expect(wasmLoad).not.toHaveBeenCalled();
      expect(getsOf(w, 'm.onnx-q4')).toBe(1);
      for (const id of [...w.fileIds, 'm.descriptor'])
        expect(getsOf(w, id), id).toBeLessThanOrEqual(1);
      expect(err.userMessage).toContain('failed its integrity check');
      expect(err.userMessage).not.toContain('could not be started');
      expect(err.userMessage).not.toContain('Nothing was downloaded');
      const sel = eventsNamed(events, 'backend.select');
      expect(sel.slice(0, 2).map((e) => e.attrs['reason'])).toEqual(['integrity', 'integrity']);
      expect(eventsNamed(events, 'model.load.failed')).toHaveLength(1);
      expect(eventsNamed(events, 'backend.refused')[0]!.attrs['reasons']).toContain('integrity');
      expect(gpu.engine.pipeline).not.toHaveBeenCalled();
      expect(wasm.engine.pipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('the descriptor itself failing its hash is also not fetched again by the next rung', async () => {
    const restore = installLocation();
    try {
      const w = await makeWorld();
      // same length, different bytes: the download completes and its hash does not match
      w.server.addAsset('m.descriptor', new Uint8Array(w.descriptorEntry.size).fill(32));
      const gpu = realAdapter('webgpu');
      const wasm = realAdapter('wasm');
      const err = (await rejection(
        loadWithFallback({
          profile,
          assets: w.mgr,
          models: ['m.descriptor'],
          adapters: [gpu.adapter, wasm.adapter],
          beforeDownload: async () => true,
        }),
      )) as BackendRefusedError;
      expect(err.attempts.slice(0, 2).map((a) => a.reason)).toEqual(['integrity', 'integrity']);
      expect(getsOf(w, 'm.descriptor')).toBe(1);
    } finally {
      restore();
    }
  });

  it('the type of the new reason is part of AttemptReason', () => {
    const r: AttemptReason = 'integrity';
    expect(r).toBe('integrity');
  });
});

describe('the chain learns of a failed entry from the error or from asset.verify.failed (R9)', () => {
  function fake(
    device: ExecutionDevice,
    load: (entryId: string, opts: LoadOptions) => Promise<void>,
  ): BackendAdapter & { loads: string[] } {
    const a = {
      id: 'transformers-js',
      tier: device === 'webgpu' ? 'webgpu-f32' : 'wasm',
      device,
      loads: [] as string[],
      capabilities: (): AdapterCapabilities => ({ generate: true, embed: false, streaming: false }),
      available: async () => true,
      async load(entry: { id: string }, opts: LoadOptions) {
        a.loads.push(entry.id);
        await load(entry.id, opts);
      },
      generate: async () => ({ text: '', finishReason: 'stop' as const, usage: {}, timings: {} }),
      embed: async () => {
        throw new AdapterError('unsupported_operation', 'no');
      },
      unload: async () => undefined,
    };
    return a as unknown as BackendAdapter & { loads: string[] };
  }

  async function cached(): Promise<World> {
    const w = await makeWorld();
    for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
    w.server.reset();
    return w;
  }

  it('an integrity AdapterError whose entryId names a file the next rung needs', async () => {
    const w = await cached();
    const { AdapterEntryError } = await import('../src/backends/entry-error');
    const gpu = fake('webgpu', async () => {
      throw new AdapterEntryError(
        'integrity',
        'a downloaded file failed its integrity check',
        'm.onnx-q4',
      );
    });
    const wasm = fake('wasm', async () => undefined);
    const err = (await rejection(
      loadWithFallback({
        profile: profileOf('webgpu-f16'),
        assets: w.mgr,
        models: ['m.descriptor'],
        adapters: [gpu, wasm],
        beforeDownload: async () => true,
      }),
    )) as BackendRefusedError;
    expect(err.attempts.slice(0, 2).map((a) => [a.rung, a.outcome, a.reason])).toEqual([
      ['webgpu', 'failed', 'integrity'],
      ['wasm', 'failed', 'integrity'],
    ]);
    expect(wasm.loads).toEqual([]);
  });

  it('an asset.verify.failed event on the asset bus, then a plain integrity error without an entry', async () => {
    const w = await cached();
    const gpu = fake('webgpu', async () => {
      w.events.emit(
        newEvent({
          source: 'runtime',
          kind: 'error',
          name: 'asset.verify.failed',
          level: 'error',
          attrs: { entryId: 'ort.wasm', reason: 'hash_mismatch' },
        }),
      );
      throw new AdapterError('integrity', 'a downloaded file failed its integrity check');
    });
    const wasm = fake('wasm', async () => undefined);
    const err = (await rejection(
      loadWithFallback({
        profile: profileOf('webgpu-f16'),
        assets: w.mgr,
        models: ['m.descriptor'],
        adapters: [gpu, wasm],
        beforeDownload: async () => true,
      }),
    )) as BackendRefusedError;
    expect(err.attempts.slice(0, 2).map((a) => a.reason)).toEqual(['integrity', 'integrity']);
    expect(wasm.loads).toEqual([]);
  });

  it('an integrity failure of an entry the next rung does not need does not block it', async () => {
    const w = await cached();
    const gpu = fake('webgpu', async () => {
      throw new AdapterError('integrity', 'x');
    });
    // a failed entry that is in no descriptor of this manifest
    w.events.emit(
      newEvent({
        source: 'runtime',
        kind: 'error',
        name: 'asset.verify.failed',
        level: 'error',
        attrs: { entryId: 'unrelated', reason: 'hash_mismatch' },
      }),
    );
    const wasm = fake('wasm', async () => undefined);
    const r = await loadWithFallback({
      profile: profileOf('webgpu-f16'),
      assets: w.mgr,
      models: ['m.descriptor'],
      adapters: [gpu, wasm],
      beforeDownload: async () => true,
    });
    expect(r.rung).toBe('wasm');
    expect(wasm.loads).toEqual(['m.descriptor']);
  });
});
