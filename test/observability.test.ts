// D1-06: model-load phases, memory samples and first-token timing on the main-thread Transformers path
// (host 'main'). Written before the implementation: red-D1-06.log precedes green-D1-06.log.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetSource } from '../spec/backend-adapter';
import { MODEL_LOAD_PHASES, type Event } from '../spec/event';
import { createTransformersAdapter, type TransformersAdapter } from '../src/backends/transformers';
import { EventBus } from '../src/events';
import { PhaseTimer, emitMemorySample, newLoadId, sampleMemory } from '../src/observability';
import { SCHEMAS, validateSchema } from '../src/schema';
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
  type World,
} from './backends-helpers';
import { repoDir } from './helpers';

const PROMPT = 'SENTINEL-PROMPT-7f3a';
const OUTPUT = 'SENTINEL-OUTPUT-9c1d';
const LOAD_ID = /^[0-9a-f]{16}$/;

let restore: () => void;
const created: TransformersAdapter[] = [];
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  for (const a of created.splice(0)) await a.unload();
  restore();
  vi.unstubAllGlobals();
});

function setPerformanceMemory(mem: unknown): void {
  const real = globalThis.performance;
  const proxy = new Proxy(real, {
    get(t, p) {
      if (p === 'memory') return mem;
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    has: (t, p) => (p === 'memory' && mem !== undefined ? true : Reflect.has(t, p)),
  });
  vi.stubGlobal('performance', proxy);
}

describe('newLoadId', () => {
  it('is 16 lowercase hex characters from crypto.getRandomValues, different each time', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const ids = new Set(Array.from({ length: 50 }, () => newLoadId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(LOAD_ID);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sampleMemory: figures are read, never estimated', () => {
  it('with performance.memory stubbed, the figures are exactly those integers and api is performance.memory', () => {
    setPerformanceMemory({
      usedJSHeapSize: 12_345_678,
      totalJSHeapSize: 23_456_789,
      jsHeapSizeLimit: 4_294_967_296,
    });
    expect(sampleMemory('page', 'after_session')).toEqual({
      scope: 'page',
      at: 'after_session',
      api: 'performance.memory',
      usedJsHeap: 12_345_678,
      totalJsHeap: 23_456_789,
      jsHeapLimit: 4_294_967_296,
      wasmMemory: null,
    });
  });

  it('with performance.memory removed, api is none and every figure is null', () => {
    setPerformanceMemory(undefined);
    expect(sampleMemory('worker', 'on_demand')).toEqual({
      scope: 'worker',
      at: 'on_demand',
      api: 'none',
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
    });
  });

  it('a value that is not a non-negative safe integer is null, not rounded or clamped', () => {
    setPerformanceMemory({ usedJSHeapSize: 1.5, totalJSHeapSize: -4, jsHeapSizeLimit: Number.NaN });
    const s = sampleMemory('page', 'before_load');
    expect(s.api).toBe('performance.memory');
    expect([s.usedJsHeap, s.totalJsHeap, s.jsHeapLimit]).toEqual([null, null, null]);
    setPerformanceMemory({
      usedJSHeapSize: '12',
      totalJSHeapSize: Infinity,
      jsHeapSizeLimit: 2 ** 60,
    });
    const t = sampleMemory('page', 'before_load');
    expect([t.usedJsHeap, t.totalJsHeap, t.jsHeapLimit]).toEqual([null, null, null]);
  });

  it('wasmMemory comes only from a real WebAssembly.Memory, otherwise null', () => {
    setPerformanceMemory(undefined);
    const mem = new WebAssembly.Memory({ initial: 2 });
    expect(sampleMemory('page', 'on_demand', mem).wasmMemory).toBe(2 * 65536);
    expect(sampleMemory('page', 'on_demand', { buffer: { byteLength: 99 } }).wasmMemory).toBeNull();
    expect(sampleMemory('page', 'on_demand', 123).wasmMemory).toBeNull();
    expect(sampleMemory('page', 'on_demand').wasmMemory).toBeNull();
  });

  it('src/observability.ts has no arithmetic that produces a memory figure', () => {
    const src = readFileSync(resolve(repoDir, 'src/observability.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const memory =
      /(usedJSHeapSize|totalJSHeapSize|jsHeapSizeLimit|usedJsHeap|totalJsHeap|jsHeapLimit|wasmMemory|byteLength)/;
    for (const line of src.split('\n')) {
      if (!memory.test(line)) continue;
      expect(line, line).not.toMatch(/[A-Za-z_\])]\s*[-+*/%]\s*[A-Za-z_(0-9]/);
      expect(line, line).not.toMatch(/Math\.(round|floor|ceil|trunc|min|max)\s*\(/);
      expect(line, line).not.toMatch(/\*\*|<<|>>/);
    }
    expect(src).not.toMatch(/\bnavigator\.deviceMemory\b/);
  });
});

describe('emitMemorySample', () => {
  it('emits kind memory name memory.sample with bytes = usedJsHeap when known, and validates against the schema', () => {
    setPerformanceMemory({ usedJSHeapSize: 1000, totalJSHeapSize: 2000, jsHeapSizeLimit: 4000 });
    const bus = new EventBus();
    emitMemorySample(bus, '0123456789abcdef', 'page', 'before_load');
    const [e] = bus.snapshot();
    expect(e!.kind).toBe('memory');
    expect(e!.name).toBe('memory.sample');
    expect(e!.level).toBe('info');
    expect(e!.bytes).toBe(1000);
    expect(e!.attrs).toEqual({
      loadId: '0123456789abcdef',
      scope: 'page',
      at: 'before_load',
      api: 'performance.memory',
      usedJsHeap: 1000,
      totalJsHeap: 2000,
      jsHeapLimit: 4000,
      wasmMemory: null,
    });
    expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
  });

  it('without performance.memory the event has no bytes and every figure is null; an absent sink or a throwing sink is harmless', () => {
    setPerformanceMemory(undefined);
    const bus = new EventBus();
    emitMemorySample(bus, '', 'worker', 'on_demand');
    expect(bus.snapshot()[0]!.bytes).toBeUndefined();
    expect(bus.snapshot()[0]!.attrs['loadId']).toBe('');
    expect(() => emitMemorySample(undefined, 'x', 'page', 'on_demand')).not.toThrow();
    expect(() =>
      emitMemorySample(
        {
          emit: () => {
            throw new Error('boom');
          },
        },
        '',
        'page',
        'on_demand',
      ),
    ).not.toThrow();
  });
});

describe('PhaseTimer', () => {
  const mk = (bus: EventBus, now = () => 0) =>
    new PhaseTimer({
      sink: bus,
      loadId: '0123456789abcdef',
      adapter: 'transformers-js',
      device: 'wasm',
      model: 'm.descriptor',
      host: 'main',
      now,
    });

  it('accumulates measured time and bytes per phase and emits one model.load.phase per phase', () => {
    const bus = new EventBus();
    const t = mk(bus);
    t.add('acquire', 10, 100);
    t.add('acquire', 5, 50);
    expect(bus.snapshot()).toHaveLength(0);
    expect(t.emit('acquire')).toBe(true);
    expect(t.emit('acquire')).toBe(false); // once per phase per load
    const [e] = bus.snapshot();
    expect(e!.name).toBe('model.load.phase');
    expect(e!.kind).toBe('timing');
    expect(e!.level).toBe('info');
    expect(e!.durationMs).toBe(15);
    expect(e!.bytes).toBe(150);
    expect(e!.attrs).toEqual({
      loadId: '0123456789abcdef',
      adapter: 'transformers-js',
      device: 'wasm',
      model: 'm.descriptor',
      phase: 'acquire',
      host: 'main',
    });
    expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
    t.add('acquire', 99);
    expect(bus.snapshot()).toHaveLength(1);
  });

  it('session and first_token carry no bytes; durationMs is required and never negative', () => {
    const bus = new EventBus();
    const t = mk(bus);
    t.add('session', 7);
    t.add('first_token', -3); // a clock that went backwards is clamped to 0
    t.emit('session');
    t.emit('first_token');
    const [s, f] = bus.snapshot();
    expect(s!.bytes).toBeUndefined();
    expect(f!.bytes).toBeUndefined();
    expect(s!.durationMs).toBe(7);
    expect(f!.durationMs).toBe(0);
    expect(t.emitted()).toEqual(['session', 'first_token']);
  });

  it('measure() times an async step with the injected clock and still adds the time when the step throws', async () => {
    const bus = new EventBus();
    let clock = 0;
    const t = mk(bus, () => clock);
    const r = await t.measure(
      'verify',
      async () => {
        clock += 40;
        return 5;
      },
      () => 77,
    );
    expect(r).toBe(5);
    await expect(
      t.measure('verify', async () => {
        clock += 2;
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    t.emit('verify');
    expect(bus.snapshot()[0]!.durationMs).toBe(42);
    expect(bus.snapshot()[0]!.bytes).toBe(77);
  });

  it('record() takes a duration the worker measured and refuses a phase twice', () => {
    const bus = new EventBus();
    const t = mk(bus);
    expect(t.record('handoff', 12.5, 1024)).toBe(true);
    expect(t.record('handoff', 1, 1)).toBe(false);
    expect(bus.snapshot()).toHaveLength(1);
  });

  it('a throwing sink never changes the outcome', () => {
    const t = new PhaseTimer({
      sink: {
        emit: () => {
          throw new Error('boom');
        },
      },
      loadId: '0123456789abcdef',
      adapter: 'a',
      device: 'wasm',
      model: 'm',
      host: 'main',
    });
    t.add('acquire', 1);
    expect(() => t.emit('acquire')).not.toThrow();
  });
});

// ---- the main-thread adapter ----------------------------------------------------------------------

async function rig(o: { engine?: MockEngineOptions; warm?: boolean } = {}) {
  const w = await makeWorld();
  if (o.warm) {
    for (const id of [...w.fileIds, 'm.descriptor']) (await w.mgr.ensure(id)).release();
    w.server.reset();
  }
  const engine = mockEngine(o.engine);
  const adapter = createTransformersAdapter({
    device: 'wasm',
    ortFactoryUrl: ORT_FACTORY_URL,
    verifiedPrefix: PREFIX,
    pins: pinsFor(),
    engine: async () => engine.module as never,
  });
  created.push(adapter);
  const events = new EventBus();
  return {
    w,
    engine,
    adapter,
    events,
    load: () =>
      adapter.load(w.descriptorEntry, {
        assets: w.mgr as AssetSource,
        profile: profileOf('wasm-simd'),
        events,
      }),
  };
}

const phases = (events: EventBus): Event[] => eventsNamed(events, 'model.load.phase');
const phaseNames = (events: EventBus) => phases(events).map((e) => e.attrs['phase']);

describe('the main-thread adapter emits model.load.phase (host main)', () => {
  it('exactly one event per phase, first_token after the first generate, one shared loadId, host main', async () => {
    setPerformanceMemory({ usedJSHeapSize: 5, totalJSHeapSize: 6, jsHeapSizeLimit: 7 });
    const r = await rig();
    await r.load();
    expect(phaseNames(r.events)).toEqual(['acquire', 'verify', 'handoff', 'session']);
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(phaseNames(r.events)).toEqual([
      'acquire',
      'verify',
      'handoff',
      'session',
      'first_token',
    ]);
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(phases(r.events)).toHaveLength(5); // a second generate adds nothing
    const ids = new Set(phases(r.events).map((e) => e.attrs['loadId']));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(LOAD_ID);
    for (const e of phases(r.events)) {
      expect(e.attrs['host']).toBe('main');
      expect(e.attrs['adapter']).toBe('transformers-js');
      expect(e.attrs['device']).toBe('wasm');
      expect(e.attrs['model']).toBe('m.descriptor');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(e.durationMs)).toBe(true);
      expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
    }
    expect([...MODEL_LOAD_PHASES]).toEqual(phaseNames(r.events));
    const load = eventsNamed(r.events, 'model.load')[0]!;
    expect(load.attrs['loadId']).toBe([...ids][0]);
    expect(load.attrs['host']).toBe('main');
    expect(r.adapter.host).toBe('main');
  });

  it('acquire bytes equal the bytes downloaded; a cached load has acquire bytes 0; verify and handoff count the bytes', async () => {
    const cold = await rig();
    await cold.load();
    const coldAcquire = phases(cold.events).find((e) => e.attrs['phase'] === 'acquire')!;
    expect(coldAcquire.bytes).toBe(cold.w.totalBytes);
    expect(coldAcquire.bytes).toBe(
      eventsNamed(cold.w.events, 'asset.download.complete').reduce((n, e) => n + (e.bytes ?? 0), 0),
    );
    const warm = await rig({ warm: true });
    await warm.load();
    const byPhase = Object.fromEntries(phases(warm.events).map((e) => [e.attrs['phase'], e]));
    expect(byPhase['acquire']!.bytes).toBe(0);
    expect(warm.w.server.calls).toBe(0);
    const modelBytes = warm.w.totalBytes - warm.w.descriptorEntry.size;
    expect(byPhase['verify']!.bytes).toBe(warm.w.totalBytes); // descriptor and every file are re-hashed
    expect(byPhase['handoff']!.bytes).toBe(modelBytes); // the files given to the engine
    expect(byPhase['session']!.bytes).toBeUndefined();
  });

  it('memory.sample is emitted at before_load, after_session and after_first_token with the same loadId (page scope)', async () => {
    setPerformanceMemory({ usedJSHeapSize: 11, totalJSHeapSize: 22, jsHeapSizeLimit: 33 });
    const r = await rig();
    await r.load();
    expect(eventsNamed(r.events, 'memory.sample').map((e) => e.attrs['at'])).toEqual([
      'before_load',
      'after_session',
    ]);
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    const samples = eventsNamed(r.events, 'memory.sample');
    expect(samples.map((e) => e.attrs['at'])).toEqual([
      'before_load',
      'after_session',
      'after_first_token',
    ]);
    const loadId = phases(r.events)[0]!.attrs['loadId'];
    for (const s of samples) {
      expect(s.attrs['loadId']).toBe(loadId);
      expect(s.attrs['scope']).toBe('page');
      expect(s.attrs['api']).toBe('performance.memory');
      expect(s.attrs['usedJsHeap']).toBe(11);
      expect(s.bytes).toBe(11);
      expect(validateSchema(SCHEMAS.event, s).errors).toEqual([]);
    }
    // order: before_load first (before the acquire phase), after_session after the session phase
    const names = r.events
      .snapshot()
      .map((e) => `${e.name}:${e.attrs['phase'] ?? e.attrs['at'] ?? ''}`);
    expect(names.indexOf('memory.sample:before_load')).toBeLessThan(
      names.indexOf('model.load.phase:acquire'),
    );
    expect(names.indexOf('memory.sample:after_session')).toBeGreaterThan(
      names.indexOf('model.load.phase:session'),
    );
  });

  it('without performance.memory every memory figure is null and api is none', async () => {
    setPerformanceMemory(undefined);
    const r = await rig();
    await r.load();
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    for (const s of eventsNamed(r.events, 'memory.sample')) {
      expect(s.attrs['api']).toBe('none');
      for (const k of ['usedJsHeap', 'totalJsHeap', 'jsHeapLimit', 'wasmMemory'])
        expect(s.attrs[k], k).toBeNull();
      expect(s.bytes).toBeUndefined();
    }
  });

  it('a failed load emits the phases that completed, then model.load.failed with the same loadId and host', async () => {
    const r = await rig({ engine: { pipelineError: new Error(`load failed near ${PROMPT}`) } });
    await expect(r.load()).rejects.toMatchObject({ code: 'backend' });
    expect(phaseNames(r.events)).toEqual(['acquire', 'verify', 'handoff']); // session never completed
    const failed = eventsNamed(r.events, 'model.load.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attrs['loadId']).toBe(phases(r.events)[0]!.attrs['loadId']);
    expect(failed[0]!.attrs['host']).toBe('main');
    const all = r.events.snapshot();
    expect(all.indexOf(failed[0]!)).toBeGreaterThan(all.indexOf(phases(r.events)[2]!));
    expect(eventsNamed(r.events, 'model.load')).toHaveLength(0);
    // memory.sample before_load was taken; there is no after_session
    expect(eventsNamed(r.events, 'memory.sample').map((e) => e.attrs['at'])).toEqual([
      'before_load',
    ]);
  });

  it('an integrity failure at acquire emits no phase after it, and model.load.failed carries code integrity', async () => {
    const r = await rig();
    const bad = new Uint8Array(r.w.entries['m.onnx-q4']!.size).fill(1);
    r.w.server.addAsset('m.onnx-q4', bad);
    await expect(r.load()).rejects.toMatchObject({ code: 'integrity' });
    expect(phaseNames(r.events)).toEqual([]); // acquire never completed
    expect(eventsNamed(r.events, 'model.load.failed')[0]!.attrs['code']).toBe('integrity');
  });

  it('a new load() gets a new loadId and its own phases (one event per phase per load)', async () => {
    const r = await rig({ warm: true });
    await r.load();
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    await r.load();
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    const ids = [...new Set(phases(r.events).map((e) => e.attrs['loadId']))];
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(phases(r.events).filter((e) => e.attrs['loadId'] === id)).toHaveLength(5);
  });

  it('firstTokenMs is reported in the result timings and on model.generate with host main', async () => {
    const r = await rig();
    await r.load();
    const res = await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(typeof res.timings.firstTokenMs).toBe('number');
    expect(res.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
    const g = eventsNamed(r.events, 'model.generate')[0]!;
    expect(g.attrs['host']).toBe('main');
    expect(g.attrs['firstTokenMs']).toBe(res.timings.firstTokenMs);
    const ft = phases(r.events).find((e) => e.attrs['phase'] === 'first_token')!;
    expect(ft.durationMs).toBe(res.timings.firstTokenMs);
  });

  it('a generate that produces no token reports firstTokenMs null and does not emit first_token', async () => {
    const r = await rig({ engine: { tokens: 0 } });
    await r.load();
    const res = await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(res.timings.firstTokenMs).toBeUndefined();
    expect(eventsNamed(r.events, 'model.generate')[0]!.attrs['firstTokenMs']).toBeNull();
    expect(phaseNames(r.events)).not.toContain('first_token');
  });

  it('no event, prompt or output sentinel crosses: the whole bus is free of them', async () => {
    const r = await rig({ engine: { reply: OUTPUT } });
    await r.load();
    const res = await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    expect(res.text).toBe(OUTPUT);
    const wire = JSON.stringify([...r.events.snapshot(), ...r.w.events.snapshot()]);
    expect(wire).not.toContain(PROMPT);
    expect(wire).not.toContain(OUTPUT);
  });

  it('every event of a full run validates against event.schema.json 0.1.2', async () => {
    const r = await rig();
    await r.load();
    await r.adapter.generate(PROMPT, { maxTokens: 8, temperature: 0 });
    for (const e of r.events.snapshot())
      expect(validateSchema(SCHEMAS.event, e).errors, e.name).toEqual([]);
  });
});

void (null as unknown as World);
