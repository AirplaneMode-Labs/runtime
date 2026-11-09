import { describe, expect, it, vi } from 'vitest';
import {
  AdapterError,
  type AdapterCapabilities,
  type BackendAdapter,
  type ExecutionDevice,
  type LoadOptions,
} from '../spec/backend-adapter';
import type { BackendTier } from '../spec/capability-profile';
import type { ManifestEntry } from '../spec/manifest';
import {
  BackendRefusedError,
  createDefaultAdapters,
  loadWithFallback,
  type ChainAssets,
  type LoadWithFallbackOptions,
} from '../src/backends/chain';
import { createChromePromptAdapter } from '../src/backends/chrome-prompt';
import { EventBus } from '../src/events';
import {
  ORT_FACTORY_URL,
  PREFIX,
  eventsNamed,
  makeWorld,
  profileOf,
  type World,
} from './backends-helpers';

type BeforeInfo = { rung: 'webgpu' | 'wasm' | 'builtin'; model: string; bytes: number };

interface FakeAdapter extends BackendAdapter {
  calls: { available: number; load: number; unload: number; loadedModels: string[] };
  engineBlocked?: () => boolean;
}

function fake(
  device: ExecutionDevice,
  over: {
    id?: string;
    tier?: BackendTier;
    available?: boolean;
    load?: (entry: ManifestEntry, opts: LoadOptions, self: FakeAdapter) => Promise<void>;
    /** Gives the adapter the optional engineBlocked() probe (the transformers adapters have it). */
    blocked?: () => boolean;
  } = {},
): FakeAdapter {
  const tier: BackendTier =
    over.tier ?? (device === 'webgpu' ? 'webgpu-f32' : device === 'wasm' ? 'wasm' : 'none');
  const a: FakeAdapter = {
    id: over.id ?? (device === 'builtin' ? 'chrome-prompt-api' : 'transformers-js'),
    tier,
    device,
    calls: { available: 0, load: 0, unload: 0, loadedModels: [] },
    capabilities: (): AdapterCapabilities => ({ generate: true, embed: false, streaming: false }),
    async available(profile) {
      a.calls.available++;
      if (over.available !== undefined) return over.available;
      return device === 'webgpu'
        ? profile.gpu === 'webgpu'
        : device === 'wasm'
          ? profile.backendTier !== 'none'
          : false;
    },
    async load(entry, opts) {
      a.calls.load++;
      a.calls.loadedModels.push(entry.id);
      await over.load?.(entry, opts, a);
    },
    async generate() {
      return { text: 'ok', finishReason: 'stop', usage: {}, timings: {} };
    },
    async embed() {
      throw new AdapterError('unsupported_operation', 'no');
    },
    async unload() {
      a.calls.unload++;
    },
  };
  if (over.blocked) a.engineBlocked = over.blocked;
  return a;
}

async function cacheAll(w: World) {
  for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
  w.server.reset();
}

const base = (w: World, over: Partial<LoadWithFallbackOptions> = {}): LoadWithFallbackOptions => ({
  profile: profileOf('webgpu-f16'),
  assets: w.mgr,
  models: ['m.descriptor'],
  events: new EventBus(),
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<BackendRefusedError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BackendRefusedError);
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as BackendRefusedError).code).toBe('unavailable');
    return e as BackendRefusedError;
  }
  throw new Error('expected BackendRefusedError');
}

describe('loadWithFallback: selection order', () => {
  it('selects the webgpu rung first when it loads', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu');
    const wasm = fake('wasm');
    const events = new EventBus();
    const r = await loadWithFallback(base(w, { adapters: [gpu, wasm, fake('builtin')], events }));
    expect(r.rung).toBe('webgpu');
    expect(r.adapter).toBe(gpu);
    expect(r.model).toBe('m.descriptor');
    expect(r.attempts).toEqual([
      {
        rung: 'webgpu',
        adapter: 'transformers-js',
        model: 'm.descriptor',
        outcome: 'selected',
        reason: 'ok',
      },
    ]);
    expect(wasm.calls.available).toBe(0);
    expect(wasm.calls.load).toBe(0);
    const sel = eventsNamed(events, 'backend.select');
    expect(sel).toHaveLength(1);
    expect(sel[0]!.kind).toBe('log');
    expect(sel[0]!.level).toBe('info');
    expect(sel[0]!.attrs).toEqual({
      rung: 'webgpu',
      adapter: 'transformers-js',
      model: 'm.descriptor',
      outcome: 'selected',
      reason: 'ok',
    });
  });

  it('webgpu fails, then wasm is selected; the failed adapter is unloaded', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu', {
      load: async () => {
        throw new AdapterError('backend', 'device lost', {
          cause: new Error('SENTINEL-ENGINE-TEXT'),
        });
      },
    });
    const wasm = fake('wasm');
    const events = new EventBus();
    const r = await loadWithFallback(base(w, { adapters: [gpu, wasm, fake('builtin')], events }));
    expect(r.rung).toBe('wasm');
    expect(r.attempts.map((a) => `${a.rung}:${a.outcome}:${a.reason}`)).toEqual([
      'webgpu:failed:load_failed',
      'wasm:selected:ok',
    ]);
    expect(gpu.calls.unload).toBe(1);
    expect(eventsNamed(events, 'backend.select')[0]!.level).toBe('warn');
    expect(JSON.stringify(events.snapshot())).not.toContain('SENTINEL');
  });

  it('forceRung wasm never touches webgpu adapters and records the rung above as forced', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu');
    const wasm = fake('wasm');
    const r = await loadWithFallback(base(w, { adapters: [gpu, wasm], forceRung: 'wasm' }));
    expect(r.rung).toBe('wasm');
    expect(gpu.calls).toEqual({ available: 0, load: 0, unload: 0, loadedModels: [] });
    expect(r.attempts[0]).toEqual({
      rung: 'webgpu',
      adapter: 'transformers-js',
      model: null,
      outcome: 'skipped',
      reason: 'forced',
    });
  });

  it('forceRung never moves up: a failing forced rung falls down, not up', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu');
    const wasm = fake('wasm', { available: false });
    const builtin = fake('builtin', { available: true });
    const r = await loadWithFallback(
      base(w, { adapters: [gpu, wasm, builtin], forceRung: 'wasm', allowBuiltin: true }),
    );
    expect(r.rung).toBe('builtin');
    expect(gpu.calls.available).toBe(0);
    expect(r.model).toBeNull();
  });

  it('records why a rung was skipped without loading: no_webgpu, tier_too_low, profile', async () => {
    const w = await makeWorld({ descriptorEntry: { minProfile: { ramGb: 64 } } });
    const none = await loadWithFallback(
      base(w, {
        adapters: [fake('webgpu', { available: false }), fake('wasm', { available: false })],
        profile: profileOf('none'),
      }),
    ).catch((e: BackendRefusedError) => e);
    expect(none).toBeInstanceOf(BackendRefusedError);
    const attempts = (none as BackendRefusedError).attempts;
    expect(attempts.map((a) => `${a.rung}:${a.reason}`)).toEqual([
      'webgpu:no_webgpu',
      'wasm:tier_too_low',
      'builtin:not_allowed',
    ]);
    // descriptor entry minProfile not satisfied (64 GB RAM): skipped with reason profile, no download
    const gpu = fake('webgpu');
    const e2 = await loadWithFallback(base(w, { adapters: [gpu] })).catch(
      (e: BackendRefusedError) => e,
    );
    expect((e2 as BackendRefusedError).attempts[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'profile',
    });
    expect(gpu.calls.load).toBe(0);
  });

  it('tries the models in preference order on a rung: an unknown or failing first model, then the second', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu', {
      load: async (entry) => {
        if (entry.id === 'm.descriptor') return;
      },
    });
    const r = await loadWithFallback(
      base(w, { adapters: [gpu], models: ['no.such.model', 'm.descriptor'] }),
    );
    expect(r.model).toBe('m.descriptor');
    expect(r.attempts.map((a) => `${a.model}:${a.outcome}`)).toEqual([
      'no.such.model:failed',
      'm.descriptor:selected',
    ]);
  });

  it('requires adapters (createDefaultAdapters supplies the defaults)', async () => {
    const w = await makeWorld();
    await expect(loadWithFallback(base(w))).rejects.toBeInstanceOf(TypeError);
  });

  it('createDefaultAdapters accepts optional sessionOptions for the two engine adapters', () => {
    const adapters = createDefaultAdapters({
      ortFactoryUrl: ORT_FACTORY_URL,
      sessionOptions: { graphOptimizationLevel: 'disabled' },
    });
    expect(adapters).toHaveLength(3);
    expect(() =>
      createDefaultAdapters({
        ortFactoryUrl: ORT_FACTORY_URL,
        sessionOptions: { bogus: 1 } as never,
      }),
    ).toThrow(TypeError);
  });

  it('createDefaultAdapters returns transformers-js webgpu, transformers-js wasm and chrome-prompt-api in that order', () => {
    const adapters = createDefaultAdapters({
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
    });
    expect(adapters.map((a) => `${a.id}:${a.device}`)).toEqual([
      'transformers-js:webgpu',
      'transformers-js:wasm',
      'chrome-prompt-api:builtin',
    ]);
    expect(adapters.some((a) => a.id === 'webllm')).toBe(false);
  });
});

describe('loadWithFallback: consent per rung (cache-only by default)', () => {
  it('with no beforeDownload on an empty store: zero acquire calls, zero requests, a refusal that says Nothing was downloaded', async () => {
    const w = await makeWorld();
    const acquire = vi.spyOn(w.mgr, 'acquire');
    const gpu = fake('webgpu');
    const wasm = fake('wasm');
    const e = await refusal(loadWithFallback(base(w, { adapters: [gpu, wasm, fake('builtin')] })));
    expect(acquire).not.toHaveBeenCalled();
    expect(w.server.requests).toHaveLength(0);
    expect(gpu.calls.load + wasm.calls.load).toBe(0);
    expect(e.userMessage).toContain('Nothing was downloaded');
    expect(e.attempts.map((a) => `${a.rung}:${a.outcome}:${a.reason}`)).toEqual([
      'webgpu:declined:declined',
      'wasm:declined:declined',
      'builtin:skipped:not_allowed',
    ]);
  });

  it('a cached model loads without any consent', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => true);
    const r = await loadWithFallback(base(w, { adapters: [fake('webgpu')], beforeDownload }));
    expect(r.rung).toBe('webgpu');
    expect(beforeDownload).not.toHaveBeenCalled();
  });

  it('asks with the rung, the model and the exact byte count of what the store does not have', async () => {
    const w = await makeWorld();
    // the descriptor is cached, so the chain can read the file list and count exactly
    (await w.mgr.ensure('m.descriptor')).release();
    (await w.mgr.ensure('m.config')).release();
    const missing = w.totalBytes - w.entries['m.descriptor']!.size - w.entries['m.config']!.size;
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => false);
    await loadWithFallback(base(w, { adapters: [fake('webgpu')], beforeDownload })).catch(
      () => undefined,
    );
    expect(beforeDownload).toHaveBeenCalledWith({
      rung: 'webgpu',
      model: 'm.descriptor',
      bytes: missing,
    });
  });

  it('when the descriptor itself is not cached the count is the upper bound: every entry the store lacks', async () => {
    const w = await makeWorld();
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => false);
    await loadWithFallback(base(w, { adapters: [fake('webgpu')], beforeDownload })).catch(
      () => undefined,
    );
    expect(beforeDownload).toHaveBeenCalledWith({
      rung: 'webgpu',
      model: 'm.descriptor',
      bytes: w.totalBytes,
    });
  });

  it("a WebGPU rung that fails after downloading leads to a second beforeDownload call for the wasm rung with that rung's own byte count", async () => {
    const w = await makeWorld();
    const gpu = fake('webgpu', {
      load: async () => {
        // the download happened (descriptor and the weights), then the engine failed
        (await w.mgr.ensure('m.descriptor')).release();
        (await w.mgr.ensure('m.onnx-q4')).release();
        throw new AdapterError('backend', 'device lost');
      },
    });
    const wasm = fake('wasm');
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => true);
    const r = await loadWithFallback(base(w, { adapters: [gpu, wasm], beforeDownload }));
    expect(r.rung).toBe('wasm');
    expect(beforeDownload).toHaveBeenCalledTimes(2);
    const [first, second] = beforeDownload.mock.calls.map(
      (c) => c[0] as { rung: string; bytes: number },
    );
    expect(first).toMatchObject({ rung: 'webgpu', bytes: w.totalBytes });
    const downloaded = w.entries['m.descriptor']!.size + w.entries['m.onnx-q4']!.size;
    expect(second).toEqual({
      rung: 'wasm',
      model: 'm.descriptor',
      bytes: w.totalBytes - downloaded,
    });
    expect(second!.bytes).toBeGreaterThan(0);
  });

  it('declining one rung does not decline the next: beforeDownload is asked again per rung', async () => {
    const w = await makeWorld();
    const answers = [false, true];
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => answers.shift() ?? false);
    const wasm = fake('wasm');
    const r = await loadWithFallback(base(w, { adapters: [fake('webgpu'), wasm], beforeDownload }));
    expect(r.rung).toBe('wasm');
    expect(beforeDownload.mock.calls.map((c) => (c[0] as { rung: string }).rung)).toEqual([
      'webgpu',
      'wasm',
    ]);
    expect(r.attempts.map((a) => `${a.rung}:${a.outcome}`)).toEqual([
      'webgpu:declined',
      'wasm:selected',
    ]);
  });

  it('a refusal after an approved download that started does not claim that nothing was downloaded', async () => {
    const w = await makeWorld();
    const gpu = fake('webgpu', {
      load: async () => {
        (await w.mgr.ensure('m.descriptor')).release(); // the download really starts
        throw new AdapterError('backend', 'device lost');
      },
    });
    const e = await refusal(
      loadWithFallback(
        base(w, {
          adapters: [gpu, fake('wasm', { available: false })],
          beforeDownload: async () => true,
        }),
      ),
    );
    expect(e.userMessage).not.toContain('Nothing was downloaded');
  });
});

describe('loadWithFallback: the Chrome built-in model is opt-in (R6)', () => {
  function lm(state: string) {
    const calls = { availability: 0, create: 0 };
    return {
      calls,
      lm: {
        availability: async () => {
          calls.availability++;
          return state;
        },
        create: async () => {
          calls.create++;
          return {
            prompt: async () => 'x',
            promptStreaming: () => new ReadableStream<string>(),
            destroy() {},
          };
        },
      },
    };
  }

  it('allowBuiltin unset: availability() and create() are called 0 times, reason not_allowed, userMessage says "Chrome built-in model: not enabled"', async () => {
    const w = await makeWorld();
    const f = lm('available');
    const e = await refusal(
      loadWithFallback(
        base(w, {
          adapters: [
            fake('webgpu', { available: false }),
            fake('wasm', { available: false }),
            createChromePromptAdapter({ languageModel: f.lm }),
          ],
          events: undefined,
        }),
      ),
    );
    expect(f.calls).toEqual({ availability: 0, create: 0 });
    expect(e.attempts.at(-1)).toEqual({
      rung: 'builtin',
      adapter: 'chrome-prompt-api',
      model: null,
      outcome: 'skipped',
      reason: 'not_allowed',
    });
    expect(e.userMessage).toContain('Chrome built-in model: not enabled');
  });

  it('allowBuiltin true: create() only when availability() === "available", and the rung is selected with model null', async () => {
    const w = await makeWorld();
    const f = lm('available');
    const events = new EventBus();
    const r = await loadWithFallback(
      base(w, {
        adapters: [
          fake('webgpu', { available: false }),
          fake('wasm', { available: false }),
          createChromePromptAdapter({ languageModel: f.lm }),
        ],
        allowBuiltin: true,
        events,
      }),
    );
    expect(r.rung).toBe('builtin');
    expect(r.model).toBeNull();
    expect(f.calls.create).toBe(1);
    const load = eventsNamed(events, 'model.load')[0]!;
    expect(load.attrs['verified']).toBe(false);
  });

  it('allowBuiltin true but downloadable/downloading/unavailable: skipped as unavailable, create() never called', async () => {
    for (const state of ['downloadable', 'downloading', 'unavailable']) {
      const w = await makeWorld();
      const f = lm(state);
      const e = await refusal(
        loadWithFallback(
          base(w, {
            adapters: [
              fake('webgpu', { available: false }),
              fake('wasm', { available: false }),
              createChromePromptAdapter({ languageModel: f.lm }),
            ],
            allowBuiltin: true,
          }),
        ),
      );
      expect(f.calls.create, state).toBe(0);
      expect(e.attempts.at(-1), state).toMatchObject({
        rung: 'builtin',
        outcome: 'skipped',
        reason: 'unavailable',
      });
    }
  });
});

describe('loadWithFallback: refusal (BackendRefusedError)', () => {
  it('a total refusal names all three rungs in plain language with no stack, no "Error:" prefix and no engine text', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const secret = new Error('SENTINEL-ENGINE-TEXT at Object.<anonymous> (/Users/x/y.js:1:1)');
    const gpu = fake('webgpu', {
      load: async () => {
        throw new AdapterError('backend', 'GPU failed', { cause: secret });
      },
    });
    const wasm = fake('wasm', {
      load: async () => {
        throw secret;
      },
    });
    const events = new EventBus();
    const e = await refusal(
      loadWithFallback(base(w, { adapters: [gpu, wasm, fake('builtin')], events })),
    );
    for (const name of ['WebGPU', 'WebAssembly', 'Chrome built-in model'])
      expect(e.userMessage).toContain(name);
    expect(e.userMessage).not.toMatch(/Error:|\n\s+at |SENTINEL|\/Users\//);
    // everything was already cached, so no download happened and the message may say so
    expect(e.userMessage).toContain('Nothing was downloaded');
    expect(JSON.stringify(events.snapshot())).not.toContain('SENTINEL');
    const refused = eventsNamed(events, 'backend.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.kind).toBe('error');
    expect(refused[0]!.attrs).toEqual({
      attempts: 3,
      reasons: 'load_failed,load_failed,not_allowed',
    });
    expect(e.attempts).toHaveLength(3);
  });

  it('the userMessage is built from enums only: no model ids, URLs or sizes', async () => {
    const w = await makeWorld();
    const e = await refusal(
      loadWithFallback(base(w, { adapters: [fake('webgpu'), fake('wasm')] })),
    );
    expect(e.userMessage).not.toMatch(/m\.descriptor|https?:|\d{4,}/);
    expect(e.message).toBe(e.userMessage);
  });
});

describe('loadWithFallback: abort', () => {
  it('an abort signal that is already aborted rejects immediately without trying any rung', async () => {
    const w = await makeWorld();
    const gpu = fake('webgpu');
    const ac = new AbortController();
    ac.abort();
    await expect(
      loadWithFallback(base(w, { adapters: [gpu], signal: ac.signal })),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(gpu.calls.available).toBe(0);
  });

  it('an aborted load propagates without trying the lower rungs, and the adapter is unloaded', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu', {
      load: async () => {
        throw new AdapterError('aborted', 'aborted');
      },
    });
    const wasm = fake('wasm');
    await expect(loadWithFallback(base(w, { adapters: [gpu, wasm] }))).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(wasm.calls.available).toBe(0);
    expect(wasm.calls.load).toBe(0);
    expect(gpu.calls.unload).toBe(1);
  });

  it('a DOM AbortError from an adapter is also an abort', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu', {
      load: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(
      loadWithFallback(base(w, { adapters: [gpu, fake('wasm')] })),
    ).rejects.toMatchObject({ name: expect.stringMatching(/Abort/) });
  });
});

// ---- T1-S2-01 ------------------------------------------------------------------------------------

const RELOAD = 'Reload the page and choose WebAssembly to try again.';

describe('T1-S2-01: the chain with a failing or poisoned WebGPU engine', () => {
  it('a webgpu adapter that is unavailable on a webgpu profile (device cannot be created) is recorded as unavailable, and wasm answers', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const gpu = fake('webgpu', { available: false });
    const wasm = fake('wasm');
    const events = new EventBus();
    const r = await loadWithFallback(base(w, { adapters: [gpu, wasm], events }));
    expect(r.rung).toBe('wasm');
    expect(r.attempts[0]).toEqual({
      rung: 'webgpu',
      adapter: 'transformers-js',
      model: null,
      outcome: 'skipped',
      reason: 'unavailable',
    });
    expect(gpu.calls.load).toBe(0);
    expect(eventsNamed(events, 'backend.select')[0]!.attrs['reason']).toBe('unavailable');
  });

  it('a webgpu rung below the needed tier is still tier_too_low, and a profile without WebGPU is still no_webgpu', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const a = await loadWithFallback(
      base(w, {
        adapters: [fake('webgpu', { available: false }), fake('wasm')],
        profile: profileOf('wasm-simd', { gpu: 'webgpu' }),
      }),
    );
    expect(a.attempts[0]!.reason).toBe('tier_too_low');
    const b = await loadWithFallback(
      base(w, {
        adapters: [fake('webgpu', { available: false }), fake('wasm')],
        profile: profileOf('wasm-simd'),
      }),
    );
    expect(b.attempts[0]!.reason).toBe('no_webgpu');
  });

  it('a wasm adapter whose engine is blocked is not asked for consent, never loads, and the refusal carries the reload sentence', async () => {
    const w = await makeWorld(); // empty store: loading would need a download
    const wasm = fake('wasm', { blocked: () => true });
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => true);
    const events = new EventBus();
    const e = await refusal(
      loadWithFallback(base(w, { adapters: [wasm], forceRung: 'wasm', beforeDownload, events })),
    );
    expect(beforeDownload).not.toHaveBeenCalled();
    expect(wasm.calls.load).toBe(0);
    expect(w.server.requests).toHaveLength(0);
    expect(e.attempts.find((a) => a.rung === 'wasm')).toEqual({
      rung: 'wasm',
      adapter: 'transformers-js',
      model: null,
      outcome: 'failed',
      reason: 'load_failed',
    });
    expect(e.userMessage).toContain(RELOAD);
    expect(e.userMessage).toContain('Nothing was downloaded');
    expect(e.userMessage).not.toMatch(/Error:|\n\s+at /);
    expect(eventsNamed(events, 'backend.select').map((x) => x.attrs['reason'])).toContain(
      'load_failed',
    );
  });

  it('a WebGPU rung that poisons the engine while loading leads to a wasm rung that fails without loading, and the reload sentence', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const state = { blocked: false };
    const gpu = fake('webgpu', {
      load: async () => {
        state.blocked = true; // the engine's session creation rejected
        throw new AdapterError('backend', 'device lost', {
          cause: new Error('SENTINEL-ENGINE-TEXT 9949928'),
        });
      },
    });
    const wasm = fake('wasm', { blocked: () => state.blocked });
    gpu.engineBlocked = () => state.blocked;
    const events = new EventBus();
    const e = await refusal(loadWithFallback(base(w, { adapters: [gpu, wasm], events })));
    expect(wasm.calls.load).toBe(0);
    expect(e.attempts.map((a) => `${a.rung}:${a.outcome}:${a.reason}`)).toEqual([
      'webgpu:failed:load_failed',
      'wasm:failed:load_failed',
      'builtin:skipped:not_allowed',
    ]);
    expect(e.userMessage).toContain(RELOAD);
    expect(e.userMessage).not.toContain('SENTINEL');
    expect(JSON.stringify(events.snapshot())).not.toContain('SENTINEL');
  });

  it('an ordinary failure, with no blocked engine, has no reload sentence', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const e = await refusal(
      loadWithFallback(
        base(w, {
          adapters: [
            fake('webgpu', { load: async () => Promise.reject(new AdapterError('backend', 'x')) }),
            fake('wasm', { load: async () => Promise.reject(new AdapterError('backend', 'x')) }),
          ],
        }),
      ),
    );
    expect(e.userMessage).not.toContain('Reload');
  });

  it('the wasm rung failing and blocking the engine itself does not tell the user to choose WebAssembly', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const state = { blocked: false };
    const wasm = fake('wasm', {
      load: async () => {
        state.blocked = true;
        throw new AdapterError('backend', 'out of memory');
      },
      blocked: () => state.blocked,
    });
    const e = await refusal(loadWithFallback(base(w, { adapters: [wasm], forceRung: 'wasm' })));
    expect(e.userMessage).not.toContain(RELOAD);
  });

  it('the transformers adapters expose engineBlocked(); the chrome built-in adapter does not need to', () => {
    const adapters = createDefaultAdapters({
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
    });
    for (const a of adapters.slice(0, 2))
      expect(typeof (a as unknown as { engineBlocked?: unknown }).engineBlocked).toBe('function');
    expect(
      adapters
        .slice(0, 2)
        .map((a) => (a as unknown as { engineBlocked(): boolean }).engineBlocked()),
    ).toEqual([false, false]);
  });
});

// ---- S1-053 --------------------------------------------------------------------------------------

describe('S1-053: cache-only consent counts only intact files and never claims a download that started', () => {
  it('the index row survives but the stored file is gone: no beforeDownload means 0 acquires, 0 requests, every rung declined, and the message is still true', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    await w.store.remove(w.entries['m.onnx-q4']!.sha256); // row stays, file is gone
    expect(await w.mgr.has('m.onnx-q4')).toBe(true);
    const acquire = vi.spyOn(w.mgr, 'acquire');
    const e = await refusal(
      loadWithFallback(base(w, { adapters: [fake('webgpu'), fake('wasm')] })),
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(w.server.requests).toHaveLength(0);
    expect(e.attempts.map((a) => `${a.rung}:${a.outcome}`)).toEqual([
      'webgpu:declined',
      'wasm:declined',
      'builtin:skipped',
    ]);
    expect(e.userMessage).toContain('Nothing was downloaded');
  });

  it('a truncated stored file counts toward the rung bytes, so beforeDownload is asked with its full size', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const target = w.entries['m.onnx-q4']!;
    const real = w.store.fileSize.bind(w.store);
    vi.spyOn(w.store, 'fileSize').mockImplementation(async (sha: string) =>
      sha === target.sha256 ? target.size - 1 : real(sha),
    );
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => false);
    await loadWithFallback(base(w, { adapters: [fake('webgpu')], beforeDownload })).catch(
      () => undefined,
    );
    expect(beforeDownload).toHaveBeenCalledWith({
      rung: 'webgpu',
      model: 'm.descriptor',
      bytes: target.size,
    });
  });

  it('a stored file of the right size is present: nothing to ask', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => true);
    await loadWithFallback(base(w, { adapters: [fake('webgpu')], beforeDownload }));
    expect(beforeDownload).not.toHaveBeenCalled();
  });

  it('an approval alone does not stop the message from saying Nothing was downloaded: no asset.download.start was observed', async () => {
    const w = await makeWorld();
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => true);
    const e = await refusal(
      loadWithFallback(
        base(w, {
          adapters: [
            fake('webgpu', { load: async () => Promise.reject(new AdapterError('backend', 'x')) }),
            fake('wasm', { available: false }),
          ],
          beforeDownload,
        }),
      ),
    );
    expect(beforeDownload).toHaveBeenCalled();
    expect(eventsNamed(w.events, 'asset.download.start')).toHaveLength(0);
    expect(e.userMessage).toContain('Nothing was downloaded');
  });

  it('a download that started (asset.download.start) makes the message drop the claim, even if the approval came earlier', async () => {
    const w = await makeWorld();
    const e = await refusal(
      loadWithFallback(
        base(w, {
          adapters: [
            fake('webgpu', {
              load: async () => {
                (await w.mgr.ensure('m.descriptor')).release();
                throw new AdapterError('backend', 'x');
              },
            }),
            fake('wasm', { available: false }),
          ],
          beforeDownload: async () => true,
        }),
      ),
    );
    expect(eventsNamed(w.events, 'asset.download.start').length).toBeGreaterThan(0);
    expect(e.userMessage).not.toContain('Nothing was downloaded');
  });

  it('when the chain cannot observe downloads (no event bus on the source or the sink), an approval keeps the old conservative behaviour', async () => {
    const w = await makeWorld();
    const assets: ChainAssets = {
      getBlob: (id, o) => w.mgr.getBlob(id, o),
      getEntry: (id) => w.mgr.getEntry(id),
      acquire: (id, o) => w.mgr.acquire(id, o),
      has: (id) => w.mgr.has(id),
      storedSize: (id) => w.mgr.storedSize(id),
      manifest: w.mgr.manifest,
    };
    const e = await refusal(
      loadWithFallback(
        base(w, {
          assets,
          events: { emit() {} },
          adapters: [
            fake('webgpu', { load: async () => Promise.reject(new AdapterError('backend', 'x')) }),
            fake('wasm', { available: false }),
          ],
          beforeDownload: async () => true,
        }),
      ),
    );
    expect(e.userMessage).not.toContain('Nothing was downloaded');
  });

  it('a source that cannot report stored sizes counts every file as missing (fail closed): consent is asked', async () => {
    const w = await makeWorld();
    await cacheAll(w);
    const assets: ChainAssets = {
      getBlob: (id, o) => w.mgr.getBlob(id, o),
      getEntry: (id) => w.mgr.getEntry(id),
      acquire: (id, o) => w.mgr.acquire(id, o),
      has: (id) => w.mgr.has(id),
      manifest: w.mgr.manifest,
    };
    const beforeDownload = vi.fn(async (_i: BeforeInfo) => false);
    await loadWithFallback(base(w, { assets, adapters: [fake('webgpu')], beforeDownload })).catch(
      () => undefined,
    );
    expect(beforeDownload).toHaveBeenCalled();
  });
});
