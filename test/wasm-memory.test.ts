// D1-05 (event 0.1.4, model.memory): the worker reads the peak byteLength of the real WebAssembly.Memory
// objects the engine creates, sampled on a timer, and says 'unavailable' when it cannot reach one. Nothing is
// estimated. The probe wraps WebAssembly.instantiate and the Memory constructor of a namespace object (the
// worker's own WebAssembly in production, a copy here). Written before src/worker/wasm-memory.ts existed
// (red run: evidence/sprint-5/D1/red/D1-05.log).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installWasmMemoryProbe, type WebAssemblyLike } from '../src/worker/wasm-memory';
import { eventsNamed, installLocation } from './backends-helpers';
import { unloadAllRigs, workerRig } from './worker-rig';

const PAGE = 65536;
// (module (memory (export "memory") 1))
const TINY = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x0a, 0x01,
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

function fakeWebAssembly(): WebAssemblyLike & { Memory: typeof WebAssembly.Memory } {
  return {
    Memory: WebAssembly.Memory,
    instantiate: WebAssembly.instantiate.bind(WebAssembly) as WebAssemblyLike['instantiate'],
  } as never;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the wasm memory probe', () => {
  it('says unavailable, with no byte figure, while no memory has been created', async () => {
    const probe = installWasmMemoryProbe(fakeWebAssembly(), { intervalMs: 5 });
    expect(probe.sample()).toBeUndefined();
    const r = await probe.measure('load', async () => 7);
    expect(r.result).toBe(7);
    expect(r.peak).toEqual({ measure: 'unavailable' });
    expect(Object.keys(r.peak)).toEqual(['measure']);
  });

  it('captures the memory an instantiated module exports and reports its peak byteLength', async () => {
    const wa = fakeWebAssembly();
    const probe = installWasmMemoryProbe(wa, { intervalMs: 5 });
    const { instance } = (await wa.instantiate(TINY, {})) as unknown as {
      instance: { exports: { memory: WebAssembly.Memory } };
    };
    expect(probe.memories).toBe(1);
    expect(probe.sample()).toBe(PAGE);
    const r = await probe.measure('generate', async () => {
      instance.exports.memory.grow(3); // 4 pages
      await sleep(30);
      return 'done';
    });
    expect(r.peak).toEqual({ measure: 'wasm-memory', bytes: 4 * PAGE });
    // the peak is a high-water mark: it is not lowered by anything after the call
    expect((await probe.measure('embed', async () => undefined)).peak).toEqual({
      measure: 'wasm-memory',
      bytes: 4 * PAGE,
    });
  });

  it('captures a memory made with new WebAssembly.Memory and sums every captured memory', async () => {
    const wa = fakeWebAssembly();
    const probe = installWasmMemoryProbe(wa, { intervalMs: 5 });
    const imported = new wa.Memory({ initial: 2 });
    expect(imported).toBeInstanceOf(WebAssembly.Memory);
    const { instance } = (await wa.instantiate(TINY, {})) as unknown as { instance: unknown };
    void instance;
    expect(probe.memories).toBe(2);
    expect(probe.sample()).toBe(2 * PAGE + PAGE);
  });

  it('samples on the timer while the call runs, and at the end', async () => {
    const wa = fakeWebAssembly();
    const probe = installWasmMemoryProbe(wa, { intervalMs: 5 });
    const { instance } = (await wa.instantiate(TINY, {})) as unknown as {
      instance: { exports: { memory: WebAssembly.Memory } };
    };
    const before = probe.samples;
    await probe.measure('load', async () => {
      await sleep(8);
      instance.exports.memory.grow(1);
      await sleep(40);
    });
    expect(probe.samples - before).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent on one namespace object: a second install returns the same probe', () => {
    const wa = fakeWebAssembly();
    expect(installWasmMemoryProbe(wa)).toBe(installWasmMemoryProbe(wa));
  });

  it('never throws out of a failing sample: a memory that cannot be read is unavailable', async () => {
    const wa = fakeWebAssembly();
    const probe = installWasmMemoryProbe(wa, { intervalMs: 5 });
    const m = new wa.Memory({ initial: 1 });
    Object.defineProperty(m, 'buffer', {
      get() {
        throw new Error('detached');
      },
    });
    expect(probe.sample()).toBeUndefined();
    expect((await probe.measure('load', async () => 1)).peak).toEqual({ measure: 'unavailable' });
  });
});

describe('model.memory events (the page builds them from the worker peak message)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installLocation();
  });
  afterEach(async () => {
    await unloadAllRigs();
    restore();
  });

  it('with no reachable memory the load, generate and embed phases report measure unavailable and no bytes', async () => {
    const r = await workerRig();
    await r.load();
    await r.adapter.generate('hi', { maxTokens: 4 });
    const ev = eventsNamed(r.events, 'model.memory');
    expect(ev.map((e) => e.attrs['phase'])).toEqual(['load', 'generate']);
    for (const e of ev) {
      expect(e.kind).toBe('memory');
      expect(e.bytes).toBeUndefined();
      expect(e.attrs).toEqual({
        adapter: 'transformers-js',
        host: 'worker',
        loadId: expect.stringMatching(/^[0-9a-f]{16}$/),
        phase: e.attrs['phase'],
        measure: 'unavailable',
      });
    }
  });

  it('with a probe that reads a real figure the event carries it as top-level bytes', async () => {
    const { TjsEngine } = await import('../src/worker/tjs-engine');
    void TjsEngine;
    const r = await workerRig({ engine: {}, wasmPeakBytes: 123_456_789 });
    await r.load();
    await r.adapter.generate('hi', { maxTokens: 4 });
    const ev = eventsNamed(r.events, 'model.memory');
    expect(ev.map((e) => [e.attrs['phase'], e.attrs['measure'], e.bytes])).toEqual([
      ['load', 'wasm-memory', 123_456_789],
      ['generate', 'wasm-memory', 123_456_789],
    ]);
  });
});
