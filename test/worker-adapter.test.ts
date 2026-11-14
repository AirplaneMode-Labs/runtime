// D1-04: the worker adapter (host 'worker'): R1 and R2 on the main thread, the engine in a fresh module
// worker per load (R7), abort and crash (R8), observability (R12). A loopback worker drives the real
// TjsEngine in this process; test/browser/worker.spec.ts is the same thing in Chrome. Written before
// src/backends/worker-adapter.ts and src/worker/tjs-engine.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, type AssetSource } from '../spec/backend-adapter';
import type { Event } from '../spec/event';
import { BackendRefusedError, loadWithFallback } from '../src/backends/chain';
import { createTransformersAdapter } from '../src/backends/transformers';
import { verifiedRegistrySize } from '../src/backends/verified-files';
import { EventBus } from '../src/events';
import { SCHEMAS, validateSchema } from '../src/schema';
import {
  ONNX_BYTES,
  installLocation,
  eventsNamed,
  profileOf,
  ORT_FACTORY_URL,
  PAGE_ORIGIN,
  PREFIX,
  pinsFor,
  makeWorld,
} from './backends-helpers';
import { LoopbackWorker, SilentWorker, WORKER_URL, unloadAllRigs, workerRig } from './worker-rig';

const PROMPT = 'SENTINEL-PROMPT-7f3a';
const OUTPUT = 'SENTINEL-OUTPUT-9c1d';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
  vi.useRealTimers();
});

const phases = (events: EventBus): Event[] => eventsNamed(events, 'model.load.phase');
const attr = (e: Event, k: string) => e.attrs[k];
const refcounts = async (r: Awaited<ReturnType<typeof workerRig>>) =>
  (await r.w.mgr.list()).map((x) => x.refcount);

describe('identity', () => {
  it('reports transformers-js, host worker and the device tier; engineBlocked is false', () => {
    const a = createTransformersAdapter({
      device: 'webgpu',
      ortFactoryUrl: ORT_FACTORY_URL,
      workerUrl: WORKER_URL,
    });
    expect([a.id, a.device, a.tier, a.host]).toEqual([
      'transformers-js',
      'webgpu',
      'webgpu-f32',
      'worker',
    ]);
    expect((a as unknown as { engineBlocked(): boolean }).engineBlocked()).toBe(false);
    const main = createTransformersAdapter({ device: 'wasm', ortFactoryUrl: ORT_FACTORY_URL });
    expect(main.host).toBe('main');
  });
});

describe('load: R1 and R2 on the main thread, the engine in a worker', () => {
  it('loads in one fresh worker named airplanemode-engine-transformers-js-wasm, through a bootstrap blob, and posts the Blobs the asset manager re-hashed', async () => {
    const r = await workerRig();
    const getBlob = vi.spyOn(r.w.mgr, 'getBlob');
    await r.load();
    expect(r.workers).toHaveLength(1);
    const worker = r.workers[0] as LoopbackWorker;
    expect(worker.name).toBe('airplanemode-engine-transformers-js-wasm');
    expect(worker.url).toBe(r.created[0]);
    const init = worker.received.find((m) => m.type === 'init') as unknown as {
      files: { path: string; entryId: string; sha256: string; size: number; blob: Blob }[];
      verifiedPrefix: string;
      ortFactoryUrl: string;
      loadId: string;
      runtimeWasm: string;
    };
    expect(init.verifiedPrefix).toBe(`${PAGE_ORIGIN}${PREFIX}`);
    expect(init.ortFactoryUrl).toBe(ORT_FACTORY_URL);
    expect(init.loadId).toMatch(/^[0-9a-f]{16}$/);
    expect(init.files.map((f) => f.path)).toEqual([...init.files.map((f) => f.path)].sort());
    const returned = await Promise.all(getBlob.mock.results.map((x) => x.value as Promise<Blob>));
    for (const f of init.files) {
      expect(f.blob).toBeInstanceOf(Blob);
      expect(returned).toContain(f.blob); // the very Blob that getBlob(id, {rehash:true}) returned
      expect(f.blob.size).toBe(f.size);
      expect(f.blob.size).toBe(r.w.entries[f.entryId]!.size);
    }
    for (const c of getBlob.mock.calls) expect(c[1]).toEqual({ rehash: true });
    // every file of the descriptor is held until unload
    expect((await refcounts(r)).every((n) => n === 1)).toBe(true);
    expect(verifiedRegistrySize()).toBeGreaterThan(0); // the loopback engine registered them
    await r.adapter.unload();
    expect(verifiedRegistrySize()).toBe(0);
  });

  it('emits model.load.phase for all five phases with one loadId and host worker, handoff and session from the worker, first_token after the first generate', async () => {
    const r = await workerRig();
    await r.load();
    expect(phases(r.events).map((e) => attr(e, 'phase'))).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
    ]);
    const res = await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(phases(r.events).map((e) => attr(e, 'phase'))).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
      'first_token',
    ]);
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(phases(r.events)).toHaveLength(5);
    const ids = new Set(phases(r.events).map((e) => attr(e, 'loadId')));
    expect(ids.size).toBe(1);
    for (const e of phases(r.events)) {
      expect(attr(e, 'host')).toBe('worker');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
      expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
    }
    const byPhase = Object.fromEntries(phases(r.events).map((e) => [attr(e, 'phase'), e]));
    expect(byPhase['acquire']!.bytes).toBe(r.w.totalBytes);
    expect(byPhase['handoff']!.bytes).toBe(r.w.totalBytes - r.w.descriptorEntry.size);
    expect(byPhase['session']!.bytes).toBeUndefined();
    expect(res.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(byPhase['first_token']!.durationMs).toBe(res.timings.firstTokenMs);
    const load = eventsNamed(r.events, 'model.load')[0]!;
    expect(attr(load, 'host')).toBe('worker');
    expect(attr(load, 'loadId')).toBe([...ids][0]);
    expect(attr(eventsNamed(r.events, 'model.generate')[0]!, 'host')).toBe('worker');
  });

  it('takes memory samples: page scope before_load, and worker scope after_session and after_first_token (api none in a worker without performance.memory)', async () => {
    const r = await workerRig();
    await r.load();
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    const m = eventsNamed(r.events, 'memory.sample').map(
      (e) => `${attr(e, 'scope')}:${attr(e, 'at')}`,
    );
    expect(m).toContain('page:before_load');
    expect(m).toContain('worker:after_session');
    expect(m).toContain('worker:after_first_token');
    for (const e of eventsNamed(r.events, 'memory.sample')) {
      expect(attr(e, 'loadId')).toMatch(/^[0-9a-f]{16}$/);
      expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
    }
  });

  it('records backend.worker started, ready (with spawn-to-ready time) and terminated on unload', async () => {
    const r = await workerRig();
    await r.load();
    await r.adapter.unload();
    const w = eventsNamed(r.events, 'backend.worker');
    expect(w.map((e) => attr(e, 'state'))).toEqual(['started', 'ready', 'terminated']);
    expect(w[1]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(w[2]!.attrs['reason']).toBe('unload');
    for (const e of w)
      expect(Object.keys(e.attrs).sort()).toEqual(['adapter', 'device', 'reason', 'state']);
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect(r.revoked).toEqual(r.created);
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
  });

  it('streams tokens through onToken and returns the engine text, usage and timings', async () => {
    const r = await workerRig({ engine: { reply: OUTPUT, tokens: 3 } });
    await r.load();
    const seen: string[] = [];
    const res = await r.adapter.generate(PROMPT, {
      maxTokens: 8,
      temperature: 0,
      onToken: (t: string) => seen.push(t),
    });
    expect(res.text).toBe(OUTPUT);
    expect(res.finishReason).toBe('stop');
    expect(seen.length).toBe(3);
    expect(res.usage.completionTokens).toBe(3);
    expect(typeof res.timings.tokensPerSecond).toBe('number');
  });

  it('refuses before spawning anything: a profile below the tier, a bad descriptor, an integrity failure', async () => {
    const low = await workerRig({ device: 'webgpu' });
    await expect(
      low.adapter.load(low.w.descriptorEntry, {
        assets: low.w.mgr as AssetSource,
        profile: profileOf('wasm'),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_profile' });
    expect(low.workers).toHaveLength(0);
    const bad = await workerRig({ world: { descriptor: (d) => (d['engine'] = 'webllm') } });
    await expect(bad.load()).rejects.toMatchObject({ code: 'bad_descriptor' });
    expect(bad.workers).toHaveLength(0);
    const flip = await workerRig();
    flip.w.server.addAsset('m.onnx-q4', new Uint8Array(ONNX_BYTES.length).fill(1));
    await expect(flip.load()).rejects.toMatchObject({ code: 'integrity', entryId: 'm.onnx-q4' });
    expect(flip.workers).toHaveLength(0);
    expect(flip.created).toHaveLength(0);
    expect((await refcounts(flip)).every((n) => n === 0)).toBe(true);
  });

  it('passes cacheOnly to every acquire() and rejects not_cached on a cold store without spawning', async () => {
    const r = await workerRig();
    const acquire = vi.spyOn(r.w.mgr, 'acquire');
    await expect(r.load({ cacheOnly: true })).rejects.toMatchObject({ code: 'not_cached' });
    expect(r.w.server.calls).toBe(0);
    expect(r.workers).toHaveLength(0);
    for (const c of acquire.mock.calls)
      expect((c[1] as { cacheOnly?: boolean }).cacheOnly).toBe(true);
  });

  it('hands descriptor sessionOptions to the engine in the worker', async () => {
    const r = await workerRig({
      world: {
        descriptor: (d) => {
          d['spec'] = 'airplanemode.model/0.2';
          d['sessionOptions'] = { graphOptimizationLevel: 'disabled' };
        },
      },
    });
    await r.load();
    const mock = (r.workers[0] as LoopbackWorker).mock;
    expect(mock.pipelineCalls[0]!.options['session_options']).toEqual({
      graphOptimizationLevel: 'disabled',
    });
    expect(Object.getPrototypeOf(mock.pipelineCalls[0]!.options['session_options'])).toBe(
      Object.prototype,
    );
  });

  it('S1-073: an unreadable posted Blob in the worker posts integrity, not backend', async () => {
    class BadBlobWorker extends LoopbackWorker {
      override postMessage(msg: unknown): void {
        const m = msg as { type?: string; files?: { blob: Blob }[] };
        if (m.type === 'init' && m.files)
          for (const f of m.files)
            f.blob = Object.assign(Object.create(f.blob) as Blob, {
              arrayBuffer: () => Promise.reject(new DOMException('changed', 'NotReadableError')),
            });
        super.postMessage(msg);
      }
    }
    const r = await workerRig({ spawn: (url, name) => new BadBlobWorker(url, name, {}) });
    const e = (await r.load().then(
      () => undefined,
      (x: unknown) => x,
    )) as AdapterError;
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.code).toBe('integrity');
    expect(e.message).not.toContain('could not be started');
  });

  it('a missing egress guard sentinel makes the worker refuse with backend, and the load rejects backend', async () => {
    const r = await workerRig({ guard: false });
    await expect(r.load()).rejects.toMatchObject({ code: 'backend' });
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
  });

  it('a verifiedPrefix whose origin is not the worker origin makes the worker refuse with backend', async () => {
    const r = await workerRig({
      spawn: (url, name) =>
        new LoopbackWorker(url, name, {}, { selfOrigin: 'https://elsewhere.test' }),
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'backend' });
  });

  it('a verifiedPrefix on another origin than the page is refused on the main thread before a worker exists', async () => {
    const r = await workerRig({
      verifiedPrefix: 'https://elsewhere.test/app/__airplanemode/verified/',
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'egress_refused' });
    expect(r.workers).toHaveLength(0);
    const bad = await workerRig({ verifiedPrefix: 'https://app.test/app/verified/' });
    await expect(bad.load()).rejects.toBeInstanceOf(AdapterError);
    expect(bad.workers).toHaveLength(0);
  });

  it('a bad workerUrl is refused before URL.createObjectURL', async () => {
    for (const workerUrl of [
      'javascript:alert(1)',
      'https://evil.test/w.js',
      './w.js?x=1',
      'https://app.test/w".js',
    ]) {
      const r = await workerRig({ workerUrl });
      await expect(r.load(), workerUrl).rejects.toBeInstanceOf(AdapterError);
      expect(r.created).toEqual([]);
      expect(r.workers).toHaveLength(0);
    }
  });
});

describe('a failed load', () => {
  it('terminates the worker, releases holds and the blob URL, emits the completed phases then model.load.failed (host worker, same loadId)', async () => {
    const r = await workerRig({
      engine: { pipelineError: new Error(`engine fail near ${PROMPT}`) },
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'backend' });
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect(r.revoked).toEqual(r.created);
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
    expect(phases(r.events).map((e) => attr(e, 'phase'))).toEqual(['acquire', 'verify', 'handoff']);
    const failed = eventsNamed(r.events, 'model.load.failed');
    expect(failed).toHaveLength(1);
    expect(attr(failed[0]!, 'host')).toBe('worker');
    expect(attr(failed[0]!, 'loadId')).toBe(attr(phases(r.events)[0]!, 'loadId'));
    expect(attr(failed[0]!, 'code')).toBe('backend');
    const states = eventsNamed(r.events, 'backend.worker').map(
      (e) => `${attr(e, 'state')}:${attr(e, 'reason')}`,
    );
    expect(states).toContain('terminated:load_failed');
    expect(JSON.stringify(r.events.snapshot())).not.toContain(PROMPT);
    expect(verifiedRegistrySize()).toBe(0);
  });

  it('an abort during the load rejects aborted and cleans up', async () => {
    const ctl = new AbortController();
    const r = await workerRig({
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m) => {
          if (m.type === 'init') ctl.abort();
        };
        return w;
      },
    });
    await expect(r.load({ signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect((r.workers[0] as SilentWorker).terminated).toBe(true);
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
  });
});

describe('abort and crash (R8)', () => {
  async function loadedSilent(grace?: number) {
    const r = await workerRig({
      ...(grace !== undefined ? { abortGraceMs: grace } : {}),
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') {
            self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 10 });
            self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 2 });
            self.deliver({ v: 1, type: 'ready' });
          }
        };
        return w;
      },
    });
    await r.load();
    return { r, worker: r.workers[0] as SilentWorker };
  }

  it('an abort the worker does not answer within 250 ms terminates it: generate resolves abort, the adapter is not loaded, holds are released', async () => {
    const { r, worker } = await loadedSilent();
    const ctl = new AbortController();
    const t0 = performance.now();
    const p = r.adapter.generate(PROMPT, { maxTokens: 8, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    const res = await p;
    const took = performance.now() - t0;
    expect(res.finishReason).toBe('abort');
    expect(took).toBeLessThan(500);
    expect(worker.received.map((m) => m.type)).toContain('abort');
    expect(worker.terminated).toBe(true);
    await expect(r.adapter.generate('again')).rejects.toMatchObject({ code: 'not_loaded' });
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
    expect(r.revoked).toEqual(r.created);
    const reasons = eventsNamed(r.events, 'backend.worker').map(
      (e) => `${attr(e, 'state')}:${attr(e, 'reason')}`,
    );
    expect(reasons).toContain('terminated:abort');
  });

  it('an abort the worker answers in time ends with done abort and keeps the adapter loaded', async () => {
    const r = await workerRig({
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') {
            self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 10 });
            self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 2 });
            self.deliver({ v: 1, type: 'ready' });
          }
          if (m.type === 'abort')
            self.deliver({
              v: 1,
              type: 'done',
              id: m['id'],
              result: { text: '', finishReason: 'abort', usage: {}, timings: {} },
            });
        };
        return w;
      },
    });
    await r.load();
    const ctl = new AbortController();
    const p = r.adapter.generate(PROMPT, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    expect((await p).finishReason).toBe('abort');
    expect((r.workers[0] as SilentWorker).terminated).toBe(false);
  });

  it('an already aborted signal resolves abort at once without posting generate', async () => {
    const { r, worker } = await loadedSilent();
    const ctl = new AbortController();
    ctl.abort();
    const res = await r.adapter.generate(PROMPT, { signal: ctl.signal });
    expect(res.finishReason).toBe('abort');
    expect(worker.received.map((m) => m.type)).not.toContain('generate');
  });

  it('a worker error event rejects the pending generate with backend, emits backend.worker crashed (warn) and unloads', async () => {
    const { r, worker } = await loadedSilent();
    const p = r.adapter.generate(PROMPT, { maxTokens: 4 });
    setTimeout(() => worker.onerror?.({ message: `boom ${PROMPT}` }), 5);
    await expect(p).rejects.toMatchObject({ code: 'backend' });
    const crashed = eventsNamed(r.events, 'backend.worker').filter(
      (e) => attr(e, 'state') === 'crashed',
    );
    expect(crashed).toHaveLength(1);
    expect(crashed[0]!.level).toBe('warn');
    expect(worker.terminated).toBe(true);
    await expect(r.adapter.generate('x')).rejects.toMatchObject({ code: 'not_loaded' });
    expect((await refcounts(r)).every((n) => n === 0)).toBe(true);
    expect(JSON.stringify(r.events.snapshot())).not.toContain(PROMPT);
  });

  it('messageerror is a crash too', async () => {
    const { r, worker } = await loadedSilent();
    const p = r.adapter.generate(PROMPT);
    setTimeout(() => worker.onmessageerror?.({}), 5);
    await expect(p).rejects.toMatchObject({ code: 'backend' });
  });

  it('a malformed message from the worker is handled as a crash', async () => {
    const { r, worker } = await loadedSilent();
    const p = r.adapter.generate(PROMPT);
    setTimeout(() => worker.deliver({ v: 1, type: 'token', id: 'x', text: 5 }), 5);
    await expect(p).rejects.toMatchObject({ code: 'backend' });
    expect(worker.terminated).toBe(true);
  });

  it('a worker error message rejects the pending generate with its code (an unknown code becomes backend) and keeps the adapter loaded', async () => {
    const { r, worker } = await loadedSilent();
    worker.script = (m, self) => {
      if (m.type === 'generate')
        self.deliver({ v: 1, type: 'error', code: 'exploded', cause: PROMPT });
    };
    await expect(r.adapter.generate(PROMPT)).rejects.toMatchObject({ code: 'backend' });
    expect(JSON.stringify(r.events.snapshot())).not.toContain(PROMPT);
  });

  it('a refused request inside the worker is recorded as backend.egress.refused with exactly adapter and origin', async () => {
    const { r, worker } = await loadedSilent();
    worker.deliver({ v: 1, type: 'egress', origin: 'https://evil.test' });
    worker.deliver({ v: 1, type: 'egress', origin: `https://evil.test/x?q=${PROMPT}` });
    const refused = eventsNamed(r.events, 'backend.egress.refused');
    expect(refused.map((e) => e.attrs)).toEqual([
      { adapter: 'transformers-js', origin: 'https://evil.test' },
      { adapter: 'transformers-js', origin: 'invalid' },
    ]);
    expect(JSON.stringify(r.events.snapshot())).not.toContain(PROMPT);
  });
});

describe('isolation (R7): a failure in one worker does not touch the next rung', () => {
  it('a WebGPU rung whose session creation fails is followed by a WASM answer in the same page, with two worker lifecycles', async () => {
    const w = await makeWorld();
    const events = new EventBus();
    let spawned = 0;
    const mk = (device: 'webgpu' | 'wasm') =>
      createTransformersAdapter({
        device,
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: `${PAGE_ORIGIN}${PREFIX}`,
        pins: pinsFor(),
        gpuProbe: async () => true,
        workerUrl: WORKER_URL,
        spawnWorker: (url: string, name: string) => {
          spawned++;
          return new LoopbackWorker(
            url,
            name,
            device === 'webgpu' ? { pipelineError: new Error('session failed') } : {},
          );
        },
        urlApi: {
          createObjectURL: () => `blob:https://app.test/${spawned}`,
          revokeObjectURL: () => {},
        },
      } as never);
    const r = await loadWithFallback({
      profile: profileOf('webgpu-f16'),
      assets: w.mgr,
      models: ['m.descriptor'],
      adapters: [mk('webgpu'), mk('wasm')],
      beforeDownload: async () => true,
      events,
    });
    expect(r.rung).toBe('wasm');
    expect(r.attempts.map((a) => `${a.rung}:${a.outcome}:${a.reason}`)).toEqual([
      'webgpu:failed:load_failed',
      'wasm:selected:ok',
    ]);
    const text = (await r.adapter.generate('hi', { maxTokens: 4, temperature: 0 })).text;
    expect(text.length).toBeGreaterThan(0);
    const lifecycle = eventsNamed(events, 'backend.worker').map(
      (e) => `${attr(e, 'device')}:${attr(e, 'state')}`,
    );
    expect(lifecycle).toEqual([
      'webgpu:started',
      'webgpu:terminated',
      'wasm:started',
      'wasm:ready',
    ]);
    await r.adapter.unload();
    expect(
      eventsNamed(events, 'backend.worker').filter((e) => attr(e, 'state') === 'started'),
    ).toHaveLength(2);
    expect(
      eventsNamed(events, 'backend.worker').filter((e) => attr(e, 'state') === 'terminated'),
    ).toHaveLength(2);
    expect(eventsNamed(events, 'backend.refused')).toHaveLength(0);
    expect((await w.mgr.list()).every((x) => x.refcount === 0)).toBe(true);
    void BackendRefusedError;
  });

  it('the chain never reports an engine as blocked for the worker adapter (no reload sentence)', async () => {
    const w = await makeWorld();
    const mk = (device: 'webgpu' | 'wasm', fail: boolean) =>
      createTransformersAdapter({
        device,
        ortFactoryUrl: ORT_FACTORY_URL,
        verifiedPrefix: `${PAGE_ORIGIN}${PREFIX}`,
        pins: pinsFor(),
        gpuProbe: async () => true,
        workerUrl: WORKER_URL,
        spawnWorker: (url: string, name: string) =>
          new LoopbackWorker(url, name, fail ? { pipelineError: new Error('x') } : {}),
        urlApi: { createObjectURL: () => 'blob:https://app.test/1', revokeObjectURL: () => {} },
      } as never);
    try {
      await loadWithFallback({
        profile: profileOf('webgpu-f16'),
        assets: w.mgr,
        models: ['m.descriptor'],
        adapters: [mk('webgpu', true), mk('wasm', true)],
        beforeDownload: async () => true,
      });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(BackendRefusedError);
      expect((e as BackendRefusedError).userMessage).not.toContain('Reload the page');
    }
  });
});
