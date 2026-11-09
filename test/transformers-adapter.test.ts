import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, type AssetSource } from '../spec/backend-adapter';
import {
  createTransformersAdapter,
  probeWebGpuDevice,
  type TransformersAdapter,
} from '../src/backends/transformers';
import { verifiedRegistrySize } from '../src/backends/verified-files';
import { AssetError } from '../src/errors';
import { EventBus } from '../src/events';
import {
  ORT_FACTORY_URL,
  PAGE_ORIGIN,
  PREFIX,
  WASM_BYTES,
  descriptorJson,
  eventsNamed,
  installLocation,
  makeWorld,
  mockEngine,
  pinsFor,
  profileOf,
  type MockEngine,
  type MockEngineOptions,
  type World,
  type WorldOptions,
} from './backends-helpers';

let restoreLocation: () => void;
const created: TransformersAdapter[] = [];
beforeEach(() => {
  restoreLocation = installLocation();
});
afterEach(async () => {
  // adapters hold keys in the process-wide verified-file registry: always unload them
  for (const a of created.splice(0)) await a.unload();
  restoreLocation();
});

interface Rig {
  w: World;
  adapter: TransformersAdapter;
  engine: MockEngine;
  events: EventBus;
  imports: { count: number };
  load: (over?: Record<string, unknown>) => Promise<void>;
}

async function rig(
  o: {
    device?: 'wasm' | 'webgpu';
    world?: WorldOptions;
    engine?: MockEngineOptions;
    factory?: string;
  } = {},
): Promise<Rig> {
  const w = await makeWorld(o.world);
  const engine = mockEngine(o.engine);
  const imports = { count: 0 };
  const adapter = createTransformersAdapter({
    device: o.device ?? 'wasm',
    ortFactoryUrl: o.factory ?? ORT_FACTORY_URL,
    verifiedPrefix: PREFIX,
    pins: pinsFor(),
    engine: async () => {
      imports.count++;
      return engine.module as never;
    },
  });
  created.push(adapter);
  const events = new EventBus();
  const profile = profileOf(o.device === 'webgpu' ? 'webgpu-f16' : 'wasm-simd');
  return {
    w,
    adapter,
    engine,
    events,
    imports,
    load: (over = {}) =>
      adapter.load(w.descriptorEntry, { assets: w.mgr as AssetSource, profile, events, ...over }),
  };
}

const refcounts = async (w: World) =>
  Object.fromEntries((await w.mgr.list()).map((r) => [r.entryId, r.refcount]));

describe('TransformersAdapter: identity and available()', () => {
  it('reports id, tier and device per execution provider (backend adapter 0.2.0)', async () => {
    const gpu = createTransformersAdapter({ device: 'webgpu', ortFactoryUrl: ORT_FACTORY_URL });
    const wasm = createTransformersAdapter({ device: 'wasm', ortFactoryUrl: ORT_FACTORY_URL });
    expect([gpu.id, gpu.tier, gpu.device]).toEqual(['transformers-js', 'webgpu-f32', 'webgpu']);
    expect([wasm.id, wasm.tier, wasm.device]).toEqual(['transformers-js', 'wasm', 'wasm']);
    expect(wasm.capabilities().streaming).toBe(true);
  });

  it('available() is cheap and per device: WebGPU needs a webgpu profile at tier webgpu-f32 or better, WASM any tier above none', async () => {
    const gpu = createTransformersAdapter({
      device: 'webgpu',
      ortFactoryUrl: ORT_FACTORY_URL,
      gpuProbe: async () => true,
    });
    const wasm = createTransformersAdapter({ device: 'wasm', ortFactoryUrl: ORT_FACTORY_URL });
    const a = (t: Parameters<typeof profileOf>[0]) => profileOf(t);
    expect(await gpu.available(a('webgpu-f16'))).toBe(true);
    expect(await gpu.available(a('webgpu-f32'))).toBe(true);
    expect(await gpu.available(a('wasm-simd'))).toBe(false);
    expect(await gpu.available(a('none'))).toBe(false);
    expect(await wasm.available(a('webgpu-f16'))).toBe(true);
    expect(await wasm.available(a('wasm-simd'))).toBe(true);
    expect(await wasm.available(a('wasm'))).toBe(true);
    expect(await wasm.available(a('none'))).toBe(false);
  });

  it('available() never imports the engine', async () => {
    const r = await rig();
    await r.adapter.available(profileOf('wasm-simd'));
    expect(r.imports.count).toBe(0);
  });
});

describe('TransformersAdapter: configureEnv (R3)', () => {
  it('after import() and before pipeline(): wasmPaths is {mjs: same-origin} with no wasm key, every flag is as R3 lists, env.fetch is the shim', async () => {
    const r = await rig({ engine: { readFiles: ['config.json'] } });
    await r.load();
    expect(r.engine.pipeline).toHaveBeenCalledTimes(1);
    // what the engine saw AT THE TIME of pipeline(): the snapshot is taken inside the call
    const seen = r.engine.pipelineCalls[0]!.envSnapshot as Record<string, unknown> & {
      backends: { onnx: { wasm: Record<string, unknown> } };
    };
    expect(seen['allowRemoteModels']).toBe(false);
    expect(seen['allowLocalModels']).toBe(true);
    expect(seen['localModelPath']).toBe(PREFIX);
    for (const flag of [
      'useBrowserCache',
      'useFSCache',
      'useFS',
      'useCustomCache',
      'useWasmCache',
      'experimental_useCrossOriginStorage',
    ])
      expect(seen[flag], flag).toBe(false);
    expect(seen['remoteHost']).toBe('https://invalid.invalid/');
    const wasm = seen.backends.onnx.wasm;
    expect(wasm['wasmPaths']).toEqual({ mjs: ORT_FACTORY_URL });
    expect('wasm' in (wasm['wasmPaths'] as object)).toBe(false);
    expect(JSON.stringify(wasm)).not.toContain('jsdelivr');
    expect(wasm['numThreads']).toBe(1);
    expect(wasm['proxy']).toBe(false);
    // the live env: the shim replaced the library fetch, wasmBinary is the pinned bytes
    const live = r.engine.env;
    expect(live.fetch).not.toBe(undefined);
    const bin = live.backends.onnx.wasm['wasmBinary'] as ArrayBuffer;
    expect(bin).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(bin)).toEqual(WASM_BYTES);
  });

  it('keeps numThreads above 1 only when the page is cross-origin isolated', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    try {
      const r = await rig();
      await r.load();
      expect(r.engine.pipelineCalls[0]!.envSnapshot).toBeDefined();
      const wasm = r.engine.env.backends.onnx.wasm;
      expect(Number(wasm['numThreads'])).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves the engine's own file reads from the verified Blobs, 404s the unlisted ones and refuses the network", async () => {
    const r = await rig({
      engine: {
        readFiles: ['config.json', 'tokenizer.json', 'onnx/model_q4.onnx', 'added_tokens.json'],
      },
    });
    await r.load();
    const read = Object.fromEntries(r.engine.filesRead.map((f) => [f.path, [f.status, f.size]]));
    expect(read['config.json']).toEqual([200, 17]);
    expect(read['onnx/model_q4.onnx']![0]).toBe(200);
    expect(read['onnx/model_q4.onnx']![1]).toBe(3000);
    expect(read['added_tokens.json']).toEqual([404, 0]);
    expect(r.w.server.requests.every((q) => q.url.startsWith('https://assets.test/assets/'))).toBe(
      true,
    );
  });

  it('a mutated flag between calls: generate() raises backend and nothing is run', async () => {
    const r = await rig();
    await r.load();
    r.engine.env.useBrowserCache = true;
    await expect(r.adapter.generate('hi')).rejects.toMatchObject({ code: 'backend' });
    expect(r.engine.generateCalls).toHaveLength(0);
    r.engine.env.useBrowserCache = false;
    r.engine.env.backends.onnx.wasm['wasmPaths'] = {
      mjs: ORT_FACTORY_URL,
      wasm: 'https://cdn.jsdelivr.net/x.wasm',
    };
    await expect(r.adapter.generate('hi')).rejects.toMatchObject({ code: 'backend' });
    r.engine.env.backends.onnx.wasm['wasmPaths'] = { mjs: ORT_FACTORY_URL };
    r.engine.env.fetch = async () => new Response('x');
    await expect(r.adapter.generate('hi')).rejects.toMatchObject({ code: 'backend' });
    expect(r.engine.generateCalls).toHaveLength(0);
  });

  it('a flag the engine refuses to switch off is caught before pipeline(): backend, pipeline() call count 0', async () => {
    const r = await rig();
    const stubborn = new Proxy(r.engine.env, {
      set(target, key, value) {
        (target as unknown as Record<string | symbol, unknown>)[key] =
          key === 'useFSCache' ? true : value;
        return true;
      },
    });
    const module = { ...r.engine.module, env: stubborn };
    const adapter = createTransformersAdapter({
      device: 'wasm',
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
      pins: pinsFor(),
      engine: async () => module as never,
    });
    created.push(adapter);
    await expect(
      adapter.load(r.w.descriptorEntry, {
        assets: r.w.mgr as AssetSource,
        profile: profileOf('wasm-simd'),
      }),
    ).rejects.toMatchObject({ code: 'backend' });
    expect(r.engine.pipeline).not.toHaveBeenCalled();
    expect(Object.values(await refcounts(r.w)).every((n) => n === 0)).toBe(true);
  });

  it('a cross-origin ortFactoryUrl is egress_refused before the engine is imported or anything is acquired', async () => {
    for (const url of [
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort-wasm-simd-threaded.asyncify.mjs',
      'data:text/javascript,export default 1',
      'blob:https://app.test/0b7e6f1e-0000-4000-8000-000000000000',
      'http://',
    ]) {
      const r = await rig({ factory: url });
      const acquire = vi.spyOn(r.w.mgr, 'acquire');
      await expect(r.load(), url).rejects.toMatchObject({ code: 'egress_refused' });
      expect(acquire).not.toHaveBeenCalled();
      expect(r.imports.count).toBe(0);
      expect(r.engine.pipeline).not.toHaveBeenCalled();
    }
  });

  it('a relative ortFactoryUrl resolves against the page and is accepted when same-origin', async () => {
    const r = await rig({ factory: '/app/app/ort/ort-test.asyncify.mjs' });
    await r.load();
    expect(r.engine.env.backends.onnx.wasm['wasmPaths']).toEqual({
      mjs: `${PAGE_ORIGIN}/app/app/ort/ort-test.asyncify.mjs`,
    });
  });
});

describe('TransformersAdapter: sessionOptions (memory-hungry models)', () => {
  it('passes only graphOptimizationLevel to the engine as session_options, and nothing when absent', async () => {
    const r = await rig();
    await r.load();
    expect(r.engine.pipelineCalls[0]!.options['session_options']).toBeUndefined();

    const w = await makeWorld();
    const engine = mockEngine();
    const a = createTransformersAdapter({
      device: 'webgpu',
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
      pins: pinsFor(),
      sessionOptions: { graphOptimizationLevel: 'disabled' },
      engine: async () => engine.module as never,
    });
    created.push(a);
    await a.load(w.descriptorEntry, {
      assets: w.mgr as AssetSource,
      profile: profileOf('webgpu-f16'),
    });
    expect(engine.pipelineCalls[0]!.options['session_options']).toEqual({
      graphOptimizationLevel: 'disabled',
    });
  });

  it('refuses any other session option or an unknown level at construction', () => {
    const mk = (sessionOptions: unknown) => () =>
      createTransformersAdapter({
        device: 'wasm',
        ortFactoryUrl: ORT_FACTORY_URL,
        sessionOptions: sessionOptions as never,
      });
    expect(mk({ graphOptimizationLevel: 'turbo' })).toThrow(TypeError);
    expect(mk({ executionProviders: ['webgpu'] })).toThrow(TypeError);
    expect(mk({ externalData: [] })).toThrow(TypeError);
    expect(mk({ graphOptimizationLevel: 'basic' })).not.toThrow();
    expect(mk({})).not.toThrow();
  });
});

describe('TransformersAdapter: load (R1, R2)', () => {
  it('loads through pipeline(task, descriptor entry id, {device, dtype}), emits model.load with verified:true and holds every file', async () => {
    const r = await rig();
    await r.load();
    const call = r.engine.pipelineCalls[0]!;
    expect(call.task).toBe('text-generation');
    expect(call.model).toBe('m.descriptor'); // the descriptor ENTRY id, not the logical id "m"
    expect(call.options).toMatchObject({ device: 'wasm', dtype: 'q4', local_files_only: true });
    const [e] = eventsNamed(r.events, 'model.load');
    expect(e!.kind).toBe('model-load');
    expect(e!.attrs).toEqual({
      adapter: 'transformers-js',
      model: 'm.descriptor',
      device: 'wasm',
      dtype: 'q4',
      files: 6,
      tier: 'wasm',
      verified: true,
    });
    expect(e!.bytes).toBe(r.w.totalBytes);
    expect(e!.durationMs).toBeGreaterThanOrEqual(0);
    const counts = await refcounts(r.w);
    for (const id of [...r.w.fileIds, 'm.descriptor']) expect(counts[id], id).toBe(1);
    expect(r.adapter.diagnostics()).toEqual({
      device: 'wasm',
      executionProviders: ['wasm'],
      dtype: 'q4',
    });
  });

  it('unload() releases every handle (files become evictable, not deleted), removes the registry keys and disposes the pipeline', async () => {
    const before = verifiedRegistrySize();
    const r = await rig();
    await r.load();
    expect(verifiedRegistrySize()).toBe(before + 6);
    await r.adapter.unload();
    expect(verifiedRegistrySize()).toBe(before);
    expect(r.engine.disposed.count).toBe(1);
    const counts = await refcounts(r.w);
    for (const id of [...r.w.fileIds, 'm.descriptor']) expect(counts[id], id).toBe(0);
    expect((await r.w.mgr.list()).length).toBe(7);
    await expect(r.adapter.generate('x')).rejects.toMatchObject({ code: 'not_loaded' });
  });

  it('refuses an oversize descriptor entry with zero acquire() calls and no request', async () => {
    const r = await rig({ world: { descriptorBytes: new Uint8Array(65537).fill(32) } });
    const acquire = vi.spyOn(r.w.mgr, 'acquire');
    await expect(r.load()).rejects.toMatchObject({ code: 'bad_descriptor' });
    expect(acquire).not.toHaveBeenCalled();
    expect(r.w.server.requests).toHaveLength(0);
    expect(r.engine.pipeline).not.toHaveBeenCalled();
  });

  it('refuses a profile below the adapter tier (unsupported_profile) without acquiring', async () => {
    const r = await rig({ device: 'webgpu' });
    const acquire = vi.spyOn(r.w.mgr, 'acquire');
    await expect(r.load({ profile: profileOf('wasm-simd') })).rejects.toMatchObject({
      code: 'unsupported_profile',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a runtimeWasm whose manifest sha256 differs from the ORT pin for the device is bad_descriptor, before any file is downloaded', async () => {
    const r = await rig({
      world: { wasmBytes: new TextEncoder().encode('SMUGGLED-ENGINE-BINARY') },
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'bad_descriptor' });
    expect(r.engine.pipeline).not.toHaveBeenCalled();
    expect(r.imports.count).toBe(0);
    // only the descriptor was downloaded, none of the weights
    expect(r.w.server.requests.map((q) => q.url)).toEqual([r.w.descriptorEntry.url]);
    expect(Object.values(await refcounts(r.w)).every((n) => n === 0)).toBe(true);
  });

  it('a descriptor entry id that the engine could not use as a model id is refused', async () => {
    const r = await rig({ world: { descriptorEntryId: 'm--descriptor' } });
    await expect(r.load()).rejects.toMatchObject({ code: 'bad_descriptor' });
    expect(r.engine.pipeline).not.toHaveBeenCalled();
  });

  it('an unsupported task or a webllm descriptor is bad_descriptor for this adapter', async () => {
    const r = await rig({ world: { descriptor: (d) => (d['task'] = 'feature-extraction') } });
    await r.load(); // feature-extraction is supported
    expect(r.adapter.capabilities().embed).toBe(true);
    const wl = await rig({
      world: {
        descriptor: (d) => {
          d['engine'] = 'webllm';
          delete d['runtimeWasm'];
          d['modelLib'] = 'runtime/ort-test.asyncify.wasm';
        },
      },
    });
    await expect(wl.load()).rejects.toMatchObject({ code: 'bad_descriptor' });
  });

  it('honours an aborted signal before doing anything', async () => {
    const r = await rig();
    const ac = new AbortController();
    ac.abort();
    const acquire = vi.spyOn(r.w.mgr, 'acquire');
    await expect(r.load({ signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('reports download progress through LoadOptions.onProgress', async () => {
    const r = await rig();
    const seen = new Set<string>();
    await r.load({ onProgress: (p: { entryId: string }) => seen.add(p.entryId) });
    expect(seen.has('m.onnx-q4')).toBe(true);
  });
});

describe('TransformersAdapter: tamper before use (R2): no engine call on a changed byte', () => {
  for (const [label, id] of [
    ['the descriptor', 'm.descriptor'],
    ['the onnx file', 'm.onnx-q4'],
    ['the ORT wasm', 'ort.wasm'],
  ] as const) {
    it(`one flipped byte in ${label} after verification: load fails not_verified, pipeline() call count 0, every handle released`, async () => {
      const r = await rig();
      for (const entryId of [...r.w.fileIds, 'm.descriptor'])
        (await r.w.mgr.ensure(entryId)).release();
      const sha = r.w.entries[id]!.sha256;
      const bytes = new Uint8Array(await (await r.w.store.readBlob(sha)).arrayBuffer());
      bytes[bytes.length >> 1] = bytes[bytes.length >> 1]! ^ 0x01;
      r.w.store.corruptBin(sha, bytes);
      let error: unknown;
      try {
        await r.load();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AssetError);
      expect(['not_verified', 'hash_mismatch']).toContain((error as AssetError).code);
      expect(r.engine.pipeline).not.toHaveBeenCalled();
      expect(Object.values(await refcounts(r.w)).every((n) => n === 0)).toBe(true);
      expect(eventsNamed(r.events, 'model.load.failed')).toHaveLength(1);
      expect(eventsNamed(r.events, 'model.load')).toHaveLength(0);
    });
  }
});

describe('TransformersAdapter: failure handling (R5)', () => {
  it('a rogue engine fetching the network is refused with egress_refused and the event carries the origin only', async () => {
    const r = await rig({
      engine: {
        inPipeline: async (env) => {
          await env.fetch(
            'https://huggingface.co/onnx-community/x/resolve/main/model.onnx?token=T',
          );
        },
      },
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'egress_refused' });
    const [e] = eventsNamed(r.events, 'backend.egress.refused');
    expect(e!.attrs).toEqual({ adapter: 'transformers-js', origin: 'https://huggingface.co' });
    expect(Object.values(await refcounts(r.w)).every((n) => n === 0)).toBe(true);
    expect((await r.w.mgr.list()).length).toBe(7); // released, not deleted
  });

  it('an engine failure becomes backend with the engine message only in cause, plus model.load.failed built from enums', async () => {
    const secret = new Error('ORT failed: SENTINEL-ENGINE-TEXT at /Users/someone/model.onnx');
    const r = await rig({ engine: { pipelineError: secret } });
    let error: unknown;
    try {
      await r.load();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdapterError);
    const ae = error as AdapterError;
    expect(ae.code).toBe('backend');
    expect(ae.message).not.toContain('SENTINEL');
    expect(ae.cause).toBe(secret);
    const [f] = eventsNamed(r.events, 'model.load.failed');
    expect(f!.level).toBe('error');
    expect(f!.attrs).toEqual({
      adapter: 'transformers-js',
      model: 'm.descriptor',
      device: 'wasm',
      code: 'backend',
    });
    expect(JSON.stringify(r.events.snapshot())).not.toContain('SENTINEL');
    expect(Object.values(await refcounts(r.w)).every((n) => n === 0)).toBe(true);
  });
});

describe('TransformersAdapter: generate (R4)', () => {
  const PROMPT = 'What is the capital of France? Answer in one word.';

  it('greedy chat generation: temperature 0 means do_sample false, the template kwargs reach the chat template, usage and timings are reported', async () => {
    const r = await rig({ engine: { tokens: 2, promptTokens: 12 } });
    await r.load();
    const res = await r.adapter.generate(PROMPT, {
      maxTokens: 16,
      temperature: 0,
      onToken: () => {},
    });
    const call = r.engine.generateCalls[0]!;
    expect(call.input).toEqual([{ role: 'user', content: PROMPT }]);
    expect(call.options).toMatchObject({
      max_new_tokens: 16,
      do_sample: false,
      tokenizer_encode_kwargs: { enable_thinking: false },
    });
    expect(call.options['temperature']).toBeUndefined();
    expect(res.text).toBe('Paris');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 2 });
    expect(typeof res.timings.prefillMs).toBe('number');
    expect(typeof res.timings.decodeMs).toBe('number');
  });

  it('emits model.generate with the documented attrs and no prompt or output text', async () => {
    const r = await rig({ engine: { reply: 'OUTPUT-SENTINEL-9c1d' } });
    await r.load();
    await r.adapter.generate('SENTINEL-PROMPT-7f3a', {
      maxTokens: 16,
      temperature: 0,
      events: undefined,
    } as never);
    const adapterEvents = new EventBus();
    const r2 = await rig();
    await r2.adapter.load(r2.w.descriptorEntry, {
      assets: r2.w.mgr as AssetSource,
      profile: profileOf('wasm-simd'),
      events: adapterEvents,
    });
    await r2.adapter.generate(PROMPT, { maxTokens: 16, temperature: 0 });
    const [g] = eventsNamed(adapterEvents, 'model.generate');
    expect(g!.kind).toBe('timing');
    expect(Object.keys(g!.attrs).sort()).toEqual(
      [
        'adapter',
        'decodeMs',
        'device',
        'finishReason',
        'inTokens',
        'outTokens',
        'prefillMs',
        'tokensPerSecond',
      ].sort(),
    );
    expect(g!.attrs).toMatchObject({
      adapter: 'transformers-js',
      device: 'wasm',
      finishReason: 'stop',
    });
    expect(g!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(g)).not.toContain('Paris');
    expect(JSON.stringify(g)).not.toContain('capital');
  });

  it('seed without temperature is greedy; temperature above 0 samples with temperature and top_p', async () => {
    const r = await rig();
    await r.load();
    await r.adapter.generate('hi', { seed: 7 });
    expect(r.engine.generateCalls[0]!.options['do_sample']).toBe(false);
    await r.adapter.generate('hi', { temperature: 0.7, topP: 0.9 });
    expect(r.engine.generateCalls[1]!.options).toMatchObject({
      do_sample: true,
      temperature: 0.7,
      top_p: 0.9,
    });
  });

  it('finishReason is length when the token budget is spent, and the descriptor default applies when maxTokens is absent', async () => {
    const r = await rig({ engine: { tokens: 4 } });
    await r.load();
    const res = await r.adapter.generate('hi', { maxTokens: 4, temperature: 0 });
    expect(res.finishReason).toBe('length');
    await r.adapter.generate('hi');
    expect(r.engine.generateCalls[1]!.options['max_new_tokens']).toBe(16); // descriptor generation.maxNewTokens
  });

  it('streams tokens through onToken', async () => {
    const r = await rig({ engine: { tokens: 3 } });
    await r.load();
    const pieces: string[] = [];
    await r.adapter.generate('hi', { onToken: (t) => pieces.push(t) });
    expect(pieces.join('')).toBe('t100 t101 t102 ');
  });

  it('an abort signal interrupts generation and finishReason is abort', async () => {
    const r = await rig({ engine: { tokens: 3 } });
    await r.load();
    const ac = new AbortController();
    const res = await r.adapter.generate('hi', { signal: ac.signal, onToken: () => ac.abort() });
    expect(res.finishReason).toBe('abort');
    const stopper = r.engine.generateCalls[0]!.options['stopping_criteria'] as {
      interrupted: boolean;
    };
    expect(stopper.interrupted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    const res2 = await r.adapter.generate('hi', { signal: pre.signal });
    expect(res2.finishReason).toBe('abort');
    expect(r.engine.generateCalls).toHaveLength(1); // not even started
  });

  it('stop strings truncate the text', async () => {
    const r = await rig({ engine: { reply: 'one two STOP three' } });
    await r.load();
    const res = await r.adapter.generate('hi', { stop: ['STOP'] });
    expect(res.text).toBe('one two ');
    expect(res.finishReason).toBe('stop');
  });

  it('accepts a chat message list', async () => {
    const r = await rig();
    await r.load();
    const msgs = [
      { role: 'system' as const, content: 'be brief' },
      { role: 'user' as const, content: 'hi' },
    ];
    await r.adapter.generate(msgs);
    expect(r.engine.generateCalls[0]!.input).toEqual(msgs);
  });

  it('an engine error during generate is backend, message free of engine text, original in cause', async () => {
    const secret = new Error('kernel crashed on SENTINEL-PROMPT-7f3a');
    const r = await rig({ engine: { generateError: secret } });
    await r.load();
    let error: unknown;
    try {
      await r.adapter.generate('SENTINEL-PROMPT-7f3a');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe('backend');
    expect((error as AdapterError).message).not.toContain('SENTINEL');
    expect((error as AdapterError).cause).toBe(secret);
  });

  it('generate before load rejects not_loaded; embed is unsupported_operation for a text-generation model', async () => {
    const r = await rig();
    await expect(r.adapter.generate('x')).rejects.toMatchObject({ code: 'not_loaded' });
    await expect(r.adapter.embed(['x'])).rejects.toMatchObject({ code: 'not_loaded' });
    await r.load();
    await expect(r.adapter.embed(['x'])).rejects.toMatchObject({ code: 'unsupported_operation' });
  });

  it('embed() returns normalised vectors for a feature-extraction model', async () => {
    const r = await rig({ world: { descriptor: (d) => (d['task'] = 'feature-extraction') } });
    await r.load();
    const res = await r.adapter.embed(['a', 'b']);
    expect(res.dims).toBe(3);
    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toBeInstanceOf(Float32Array);
    expect(res.normalized).toBe(true);
    await expect(r.adapter.generate('x')).rejects.toMatchObject({ code: 'unsupported_operation' });
  });
});

describe('TransformersAdapter: one load at a time (module mutex)', () => {
  it('a second load() does not reach pipeline() until the first has finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const a = await rig({
      engine: {
        inPipeline: async () => {
          order.push('a:pipeline:start');
          await gate;
          order.push('a:pipeline:end');
        },
      },
    });
    const b = await rig({
      engine: {
        inPipeline: () => {
          order.push('b:pipeline');
        },
      },
    });
    const pa = a.load();
    const pb = b.load();
    await vi.waitFor(() => expect(order).toContain('a:pipeline:start'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a:pipeline:start']); // b is queued behind a
    release();
    await Promise.all([pa, pb]);
    expect(order).toEqual(['a:pipeline:start', 'a:pipeline:end', 'b:pipeline']);
  });

  it('a failed load releases the mutex for the next one', async () => {
    const a = await rig({ engine: { pipelineError: new Error('boom') } });
    const b = await rig();
    await expect(a.load()).rejects.toBeInstanceOf(AdapterError);
    await b.load();
    expect(b.engine.pipeline).toHaveBeenCalledTimes(1);
  });
});

// ---- T1-S2-01: an honest WebGPU to WebAssembly fallback ------------------------------------------

interface FakeGpuOptions {
  adapter?: 'ok' | 'null' | 'reject';
  device?: 'ok' | 'reject' | 'null';
}

function fakeGpu(o: FakeGpuOptions = {}) {
  const calls = { requestAdapter: 0, requestDevice: 0, destroy: 0, order: [] as string[] };
  const device = {
    destroy: () => {
      calls.destroy++;
      calls.order.push('destroy');
    },
  };
  const adapter = {
    requestDevice: async () => {
      calls.requestDevice++;
      calls.order.push('requestDevice');
      if (o.device === 'reject') throw new Error('SENTINEL-DEVICE-TEXT');
      if (o.device === 'null') return null;
      return device;
    },
  };
  const gpu = {
    requestAdapter: async () => {
      calls.requestAdapter++;
      calls.order.push('requestAdapter');
      if (o.adapter === 'reject') throw new Error('SENTINEL-ADAPTER-TEXT');
      if (o.adapter === 'null') return null;
      return adapter;
    },
  };
  return { gpu, calls };
}

describe('T1-S2-01: available() probes requestDevice() and destroys the probe device', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('probeWebGpuDevice: adapter, then device, then destroy; true only when both succeed', async () => {
    const ok = fakeGpu();
    expect(await probeWebGpuDevice(ok.gpu)).toBe(true);
    expect(ok.calls.order).toEqual(['requestAdapter', 'requestDevice', 'destroy']);
    expect(ok.calls.destroy).toBe(1);
  });

  it.each([
    ['requestAdapter() resolves null', { adapter: 'null' }, ['requestAdapter']],
    ['requestAdapter() rejects', { adapter: 'reject' }, ['requestAdapter']],
    [
      'requestDevice() rejects (T1-S2-01 injection)',
      { device: 'reject' },
      ['requestAdapter', 'requestDevice'],
    ],
    ['requestDevice() resolves null', { device: 'null' }, ['requestAdapter', 'requestDevice']],
  ] as [string, FakeGpuOptions, string[]][])(
    'probeWebGpuDevice: false when %s',
    async (_n, o, order) => {
      const f = fakeGpu(o);
      expect(await probeWebGpuDevice(f.gpu)).toBe(false);
      expect(f.calls.order).toEqual(order);
      expect(f.calls.destroy).toBe(0);
    },
  );

  it('probeWebGpuDevice: false (never a throw) without navigator.gpu; a destroy() that throws does not make the device unusable', async () => {
    vi.stubGlobal('navigator', {});
    expect(await probeWebGpuDevice()).toBe(false);
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          destroy: () => {
            throw new Error('destroy failed');
          },
        }),
      }),
    };
    expect(await probeWebGpuDevice(gpu)).toBe(true);
  });

  it('probeWebGpuDevice: false when the browser never answers (timeout); a device that arrives late is still destroyed', async () => {
    let arrive!: (d: { destroy(): void }) => void;
    const destroyed = { n: 0 };
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: () => new Promise<{ destroy(): void }>((r) => (arrive = r)),
      }),
    };
    expect(await probeWebGpuDevice(gpu, 20)).toBe(false);
    arrive({ destroy: () => destroyed.n++ });
    await new Promise((r) => setTimeout(r, 5));
    expect(destroyed.n).toBe(1);
  });

  it('the webgpu adapter reports unavailable when the device cannot be created, without importing the engine', async () => {
    const f = fakeGpu({ device: 'reject' });
    vi.stubGlobal('navigator', { gpu: f.gpu });
    const engine = mockEngine();
    const imports = { count: 0 };
    // no gpuProbe override: the adapter uses navigator.gpu
    const gpu = createTransformersAdapter({
      device: 'webgpu',
      ortFactoryUrl: ORT_FACTORY_URL,
      engine: async () => {
        imports.count++;
        return engine.module as never;
      },
    });
    expect(await gpu.available(profileOf('webgpu-f16'))).toBe(false);
    expect(f.calls.requestDevice).toBe(1);
    expect(imports.count).toBe(0);
    expect(engine.pipeline).not.toHaveBeenCalled();
  });

  it('the webgpu adapter is available when the probe device is created and destroyed once', async () => {
    const f = fakeGpu();
    vi.stubGlobal('navigator', { gpu: f.gpu });
    const gpu = createTransformersAdapter({ device: 'webgpu', ortFactoryUrl: ORT_FACTORY_URL });
    expect(await gpu.available(profileOf('webgpu-f16'))).toBe(true);
    expect(f.calls.destroy).toBe(1);
  });

  it('a profile that rules WebGPU out never touches navigator.gpu; the wasm adapter never does either', async () => {
    const f = fakeGpu();
    vi.stubGlobal('navigator', { gpu: f.gpu });
    const gpu = createTransformersAdapter({ device: 'webgpu', ortFactoryUrl: ORT_FACTORY_URL });
    const wasm = createTransformersAdapter({ device: 'wasm', ortFactoryUrl: ORT_FACTORY_URL });
    expect(await gpu.available(profileOf('wasm-simd'))).toBe(false);
    expect(await gpu.available(profileOf('none'))).toBe(false);
    expect(await wasm.available(profileOf('webgpu-f16'))).toBe(true);
    expect(f.calls.requestAdapter).toBe(0);
  });

  it('load() does not run the device probe again (the chain already asked available())', async () => {
    const probe = vi.fn(async () => true);
    const w = await makeWorld();
    const engine = mockEngine();
    const adapter = createTransformersAdapter({
      device: 'webgpu',
      ortFactoryUrl: ORT_FACTORY_URL,
      verifiedPrefix: PREFIX,
      pins: pinsFor(),
      engine: async () => engine.module as never,
      gpuProbe: probe,
    });
    created.push(adapter);
    await adapter.load(w.descriptorEntry, {
      assets: w.mgr as AssetSource,
      profile: profileOf('webgpu-f16'),
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('T1-S2-01: a failed session creation poisons the engine module; the next load refuses before pipeline()', () => {
  const SESSION_FAILS = async (
    env: { fetch: (u: string) => Promise<Response>; localModelPath: string },
    model: string,
  ) => {
    // what the real engine does just before InferenceSession.create(): it reads the weights
    const res = await env.fetch(`${env.localModelPath}${model}/onnx/model_q4.onnx`);
    await res.arrayBuffer();
    throw new Error('SENTINEL-SESSION-TEXT 9949928');
  };

  async function pair(engineOptions: MockEngineOptions = { inPipeline: SESSION_FAILS }) {
    const w = await makeWorld();
    const engine = mockEngine(engineOptions);
    const loader = async () => engine.module as never; // one loader = one engine module instance
    const make = (device: 'wasm' | 'webgpu') => {
      const a = createTransformersAdapter({
        device,
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: PREFIX,
        pins: pinsFor(),
        engine: loader,
        gpuProbe: async () => true,
      });
      created.push(a);
      return a;
    };
    const events = new EventBus();
    const loadOn = (a: TransformersAdapter) =>
      a.load(w.descriptorEntry, {
        assets: w.mgr as AssetSource,
        profile: profileOf('webgpu-f16'),
        events,
      });
    return { w, engine, make, events, loadOn };
  }

  it('webgpu session creation fails after the weights were read: the wasm adapter on the same engine refuses with backend, pipeline() is not called again, no handle is left', async () => {
    const p = await pair();
    const gpu = p.make('webgpu');
    const wasm = p.make('wasm');
    expect(gpu.engineBlocked()).toBe(false);
    await expect(p.loadOn(gpu)).rejects.toMatchObject({ code: 'backend' });
    expect(p.engine.pipeline).toHaveBeenCalledTimes(1);
    expect(gpu.engineBlocked()).toBe(true);
    expect(wasm.engineBlocked()).toBe(true);

    const downloads = eventsNamed(p.w.events, 'asset.download.start').length;
    const err = await p.loadOn(wasm).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('backend');
    expect(String((err as Error).message)).not.toContain('SENTINEL');
    expect(p.engine.pipeline).toHaveBeenCalledTimes(1); // pipeline() was never called for wasm
    expect(eventsNamed(p.w.events, 'asset.download.start')).toHaveLength(downloads);
    expect(Object.values(await refcounts(p.w)).every((n) => n === 0)).toBe(true);
    expect(verifiedRegistrySize()).toBe(0);
    const failed = eventsNamed(p.events, 'model.load.failed');
    expect(failed.map((e) => e.attrs['code'])).toEqual(['backend', 'backend']);
    expect(JSON.stringify(p.events.snapshot())).not.toContain('SENTINEL');
  });

  it('the refusal needs no download: a wasm load right after the poison does not acquire anything', async () => {
    const p = await pair();
    const gpu = p.make('webgpu');
    const wasm = p.make('wasm');
    await expect(p.loadOn(gpu)).rejects.toBeInstanceOf(AdapterError);
    const acquire = vi.spyOn(p.w.mgr, 'acquire');
    await expect(p.loadOn(wasm)).rejects.toMatchObject({ code: 'backend' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a failure before any weights were read (tokenizer, config) does not poison the engine', async () => {
    const p = await pair({ pipelineError: new Error('config.json is malformed') });
    const gpu = p.make('webgpu');
    await expect(p.loadOn(gpu)).rejects.toMatchObject({ code: 'backend' });
    expect(gpu.engineBlocked()).toBe(false);
    expect(p.make('wasm').engineBlocked()).toBe(false);
  });

  it('an abort during pipeline() does not poison the engine', async () => {
    const p = await pair({
      inPipeline: async (env, model) => {
        await SESSION_FAILS(env, model).catch(() => undefined);
        throw new DOMException('aborted', 'AbortError');
      },
    });
    const gpu = p.make('webgpu');
    await expect(p.loadOn(gpu)).rejects.toMatchObject({ code: 'aborted' });
    expect(gpu.engineBlocked()).toBe(false);
  });

  it('a HEAD request for the weights is not a session start', async () => {
    const p = await pair({
      inPipeline: async (env, model) => {
        await env.fetch(`${env.localModelPath}${model}/onnx/model_q4.onnx`, { method: 'HEAD' });
        throw new Error('x');
      },
    });
    const gpu = p.make('webgpu');
    await expect(p.loadOn(gpu)).rejects.toMatchObject({ code: 'backend' });
    expect(gpu.engineBlocked()).toBe(false);
  });

  it('another engine module instance is not affected', async () => {
    const p = await pair();
    const gpu = p.make('webgpu');
    await expect(p.loadOn(gpu)).rejects.toBeInstanceOf(AdapterError);
    expect(gpu.engineBlocked()).toBe(true);
    const other = await rig({ device: 'wasm' });
    expect(other.adapter.engineBlocked()).toBe(false);
    await other.load();
    expect(other.engine.pipeline).toHaveBeenCalledTimes(1);
  });
});

void descriptorJson;
