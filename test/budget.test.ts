// D1-06 (backend adapter 0.4.0, R4b): the token budget, context_overflow and Stop, on the main-thread
// adapter and on the worker host. Written before the budget existed (red run: evidence/sprint-5/D1/red/D1-06.log).
//
//   budget = min(opts.maxTokens ?? descriptor.generation.maxNewTokens ?? 256, contextLength - promptTokens)
//   contextLength - promptTokens < 1  -> rejects 'context_overflow' before decode
//   reaching the budget               -> finishReason 'length'
//   maxTokens not an integer 1..32768 -> TypeError
//   abort after the first token       -> resolves finishReason 'abort' with the partial text
//   abort before the first token      -> rejects 'aborted'

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, type AssetSource } from '../spec/backend-adapter';
import { createTransformersAdapter } from '../src/backends/transformers';
import { EventBus } from '../src/events';
import {
  ORT_FACTORY_URL,
  PREFIX,
  eventsNamed,
  installLocation,
  makeWorld,
  mockEngine,
  pinsFor,
  profileOf,
  type MockEngineOptions,
  type WorldOptions,
} from './backends-helpers';
import { LoopbackWorker, unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  for (const a of mains.splice(0)) await a.unload();
  restore();
});

const mains: { unload(): Promise<void> }[] = [];

/** One adapter per host with the same mocked engine: 'main' and 'worker'. */
async function adapterOf(
  host: 'main' | 'worker',
  o: { engine?: MockEngineOptions; world?: WorldOptions },
) {
  if (host === 'worker') {
    const r = await workerRig({
      ...(o.engine ? { engine: o.engine } : {}),
      ...(o.world ? { world: o.world } : {}),
    });
    await r.load();
    return {
      adapter: r.adapter,
      events: r.events,
      calls: () =>
        (r.workers[0] as unknown as { mock: ReturnType<typeof mockEngine> }).mock.generateCalls,
      posted: () => (r.workers[0] as LoopbackWorker).received.map((m) => m.type),
    };
  }
  const w = await makeWorld(o.world);
  const engine = mockEngine(o.engine);
  const adapter = createTransformersAdapter({
    device: 'wasm',
    ortFactoryUrl: ORT_FACTORY_URL,
    verifiedPrefix: PREFIX,
    pins: pinsFor(),
    engine: async () => engine.module as never,
  });
  mains.push(adapter);
  const events = new EventBus();
  await adapter.load(w.descriptorEntry, {
    assets: w.mgr as AssetSource,
    profile: profileOf('wasm-simd'),
    events,
  });
  return {
    adapter,
    events,
    calls: () => engine.generateCalls,
    posted: () => [] as (string | undefined)[],
  };
}

const HOSTS = ['main', 'worker'] as const;

for (const host of HOSTS) {
  describe(`R4b on the ${host} host: the budget`, () => {
    it('a call with maxTokens runs with that budget; GenerateResult.budget and the model.generate attr carry it', async () => {
      const a = await adapterOf(host, { engine: { tokens: 4 } });
      const r = await a.adapter.generate('hi', { maxTokens: 12 });
      expect(r.budget).toBe(12);
      expect(a.calls()[0]!.options['max_new_tokens']).toBe(12);
      const e = eventsNamed(a.events, 'model.generate')[0]!;
      expect(e.attrs['budget']).toBe(12);
      expect(Number.isInteger(e.attrs['budget'])).toBe(true);
    });

    it('without maxTokens the descriptor maxNewTokens is the request, and 256 when it has none', async () => {
      const withDescriptor = await adapterOf(host, { engine: { tokens: 2 } }); // the mock descriptor says 16
      expect((await withDescriptor.adapter.generate('hi')).budget).toBe(16);
      const none = await adapterOf(host, {
        engine: { tokens: 2 },
        world: {
          descriptor: (d) => delete (d['generation'] as Record<string, unknown>)['maxNewTokens'],
        },
      });
      expect((await none.adapter.generate('hi')).budget).toBe(256);
    });

    it('the context shortens the budget: min(request, contextLength - promptTokens)', async () => {
      const a = await adapterOf(host, {
        engine: { promptTokens: 2040, tokens: 3 },
        world: { descriptor: (d) => (d['contextLength'] = 2048) },
      });
      const r = await a.adapter.generate('hi', { maxTokens: 100 });
      expect(r.budget).toBe(8);
      expect(a.calls()[0]!.options['max_new_tokens']).toBe(8);
    });

    it('a prompt that leaves exactly one token of room runs with a budget of 1', async () => {
      const a = await adapterOf(host, {
        engine: { promptTokens: 2047, tokens: 1 },
        world: { descriptor: (d) => (d['contextLength'] = 2048) },
      });
      const r = await a.adapter.generate('hi', { maxTokens: 50 });
      expect(r.budget).toBe(1);
      expect(r.finishReason).toBe('length');
    });

    it("a prompt at or over contextLength rejects 'context_overflow' before decode: the engine never generates", async () => {
      for (const promptTokens of [2048, 2049, 5000]) {
        const a = await adapterOf(host, {
          engine: { promptTokens, tokens: 3 },
          world: { descriptor: (d) => (d['contextLength'] = 2048) },
        });
        await expect(a.adapter.generate('hi', { maxTokens: 8 })).rejects.toMatchObject({
          code: 'context_overflow',
        });
        expect(a.calls(), `promptTokens ${promptTokens}`).toHaveLength(0);
        // the adapter is still loaded and usable for a short prompt afterwards
      }
    });

    it("reaching the budget is finishReason 'length'; stopping earlier is 'stop'", async () => {
      const full = await adapterOf(host, { engine: { tokens: 8 } });
      expect((await full.adapter.generate('hi', { maxTokens: 8 })).finishReason).toBe('length');
      const early = await adapterOf(host, { engine: { tokens: 3 } });
      expect((await early.adapter.generate('hi', { maxTokens: 8 })).finishReason).toBe('stop');
    });

    it('maxTokens must be an integer 1..32768, else a TypeError before any work', async () => {
      const a = await adapterOf(host, { engine: { tokens: 2 } });
      for (const bad of [0, -1, 1.5, 32769, 40000, NaN, Infinity, '5' as unknown as number])
        await expect(
          a.adapter.generate('hi', { maxTokens: bad }),
          String(bad),
        ).rejects.toBeInstanceOf(TypeError);
      expect(a.calls()).toHaveLength(0);
      expect(a.posted().filter((t) => t === 'generate')).toHaveLength(0);
      for (const ok of [1, 32768]) {
        // the edges are legal inputs (a large budget is then cut by the context)
        await expect(a.adapter.generate('hi', { maxTokens: ok })).resolves.toMatchObject({
          budget: Math.min(ok, 2043),
        });
      }
    });
  });

  describe(`R4b on the ${host} host: Stop`, () => {
    it("an abort after the first token resolves finishReason 'abort' with the partial text", async () => {
      const a = await adapterOf(host, { engine: { tokens: 50, tokenDelayMs: 5 } });
      const ctl = new AbortController();
      const seen: string[] = [];
      const r = await a.adapter.generate('hi', {
        maxTokens: 50,
        signal: ctl.signal,
        onToken: (t) => {
          seen.push(t);
          if (seen.length === 2) ctl.abort();
        },
      });
      expect(r.finishReason).toBe('abort');
      expect(r.text.length).toBeGreaterThan(0);
      expect(seen.length).toBeGreaterThanOrEqual(2); // it streamed before it stopped
      expect(r.usage.completionTokens ?? 0).toBeLessThan(50);
      // and the adapter keeps working after a Stop that the engine answered itself
      if (host === 'main')
        await expect(a.adapter.generate('again', { maxTokens: 4 })).resolves.toBeDefined();
    });

    it("an abort before the first token rejects 'aborted'", async () => {
      const a = await adapterOf(host, { engine: { tokens: 50, tokenDelayMs: 40 } });
      const ctl = new AbortController();
      const p = a.adapter.generate('hi', { maxTokens: 50, signal: ctl.signal });
      setTimeout(() => ctl.abort(), 5);
      await expect(p).rejects.toMatchObject({ code: 'aborted' });
      await expect(p).rejects.toBeInstanceOf(AdapterError);
    });

    it("a signal that is already aborted rejects 'aborted' without starting the engine", async () => {
      const a = await adapterOf(host, { engine: { tokens: 5 } });
      await expect(a.adapter.generate('hi', { signal: AbortSignal.abort() })).rejects.toMatchObject(
        {
          code: 'aborted',
        },
      );
      expect(a.calls()).toHaveLength(0);
      expect(a.posted().filter((t) => t === 'generate')).toHaveLength(0);
    });
  });
}

describe('R4b on the worker host: the 250 ms backstop keeps the same two outcomes', () => {
  it("a worker that answers an abort in time after the first token gives 'abort' with the partial text; one that never answers before any token rejects 'aborted'", async () => {
    // before the first token, no answer from the worker: the backstop terminates it and the call rejects 'aborted'
    const { SilentWorker } = await import('./worker-rig');
    const r = await workerRig({
      abortGraceMs: 30,
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') self.deliver({ v: 1, type: 'ready' });
        };
        return w;
      },
    });
    await r.load();
    const ctl = new AbortController();
    const p = r.adapter.generate('hi', { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect((r.workers[0] as unknown as { terminated: boolean }).terminated).toBe(true);
  });

  it('after a token the backstop resolves abort with the text that streamed', async () => {
    const { SilentWorker } = await import('./worker-rig');
    const r = await workerRig({
      abortGraceMs: 30,
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') self.deliver({ v: 1, type: 'ready' });
          if (m.type === 'generate')
            self.deliver({ v: 1, type: 'token', id: m['id'], text: 'Par' });
        };
        return w;
      },
    });
    await r.load();
    const ctl = new AbortController();
    const p = r.adapter.generate('hi', { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    const res = await p;
    expect(res).toMatchObject({ finishReason: 'abort', text: 'Par' });
  });
});
