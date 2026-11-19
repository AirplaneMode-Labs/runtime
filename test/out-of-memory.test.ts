// Sprint 6, D1-04 (B1, backend adapter 0.5.0, R18): an allocation failure inside the engine is classified in the
// worker into the code enum only and reported as AdapterError('out_of_memory'); the worker is terminated, the
// holds are released, nothing is retried and no worker or engine string reaches an event or a message. Written
// before the code existed; the red run is evidence/sprint-6/D1/red/D1-04-out-of-memory.log.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import { SCHEMAS, validateSchema } from '../src/schema';
import { createWorkerMessageValidator } from '../src/worker/protocol';
import { eventsNamed, installLocation } from './backends-helpers';
import { LoopbackWorker, unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
});

const SENTINEL = 'SENTINEL-OOM-WORKER-STRING-8d4b';
/** What V8 and ONNX Runtime Web actually throw when memory runs out, each with a sentinel in the text. */
const MEMORY_ERRORS: [string, () => Error][] = [
  [
    'RangeError from WebAssembly.Memory.grow',
    () => new RangeError(`WebAssembly.Memory.grow(): Maximum memory size exceeded ${SENTINEL}`),
  ],
  [
    'RangeError, array buffer allocation',
    () => new RangeError(`Array buffer allocation failed ${SENTINEL}`),
  ],
  [
    'ONNX Runtime allocation error',
    () =>
      new Error(`Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc ${SENTINEL}`),
  ],
  ['Aborted(OOM)', () => new Error(`Aborted(OOM). Build with -sASSERTIONS ${SENTINEL}`)],
];
const NOT_MEMORY_ERRORS: [string, () => Error][] = [
  ['RangeError, invalid string length', () => new RangeError(`Invalid string length ${SENTINEL}`)],
  ['a plain engine failure', () => new Error(`kernel launch failed ${SENTINEL}`)],
  [
    'a TypeError that mentions memory',
    () => new TypeError(`cannot read memory of undefined ${SENTINEL}`),
  ],
];

const embedderWorld = {
  descriptor: (d: Record<string, unknown>) => {
    d['task'] = 'feature-extraction';
    d['devices'] = ['wasm'];
    d['contextLength'] = 512;
  },
};

const unloads = (events: Parameters<typeof eventsNamed>[0]) => eventsNamed(events, 'model.unload');
const refcounts = async (r: Awaited<ReturnType<typeof workerRig>>) =>
  (await r.w.mgr.list()).map((x) => x.refcount);
const everything = (r: Awaited<ReturnType<typeof workerRig>>) =>
  JSON.stringify(r.events.snapshot());

describe('R18 during load: the session cannot be created', () => {
  for (const [name, make] of MEMORY_ERRORS)
    it(`${name} rejects out_of_memory, terminates the worker, releases the holds and does not retry`, async () => {
      const r = await workerRig({ engine: { pipelineError: make() } });
      const err: unknown = await r.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe('out_of_memory');
      // the AdapterError never carries the worker's text, its cause or its stack
      expect((err as AdapterError).message).not.toContain(SENTINEL);
      expect((err as AdapterError).cause).toBeUndefined();
      expect(String((err as AdapterError).stack)).not.toContain(SENTINEL);
      // the worker is terminated and the holds are released
      expect(r.workers).toHaveLength(1); // no retry: one worker, one pipeline() call
      expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
      expect((r.workers[0] as LoopbackWorker).mock.pipeline).toHaveBeenCalledTimes(1);
      expect(await refcounts(r)).toEqual((await refcounts(r)).map(() => 0));
      expect(r.revoked).toEqual([r.created[0]]);
      // no part or cache entry changed: every file the load stored is still stored in full, none was evicted
      // or truncated, and no .part is left behind
      const rows = await r.w.mgr.list();
      expect(rows.map((x) => [x.entryId, x.size]).sort()).toEqual(
        Object.values(r.w.entries)
          .map((e) => [e.id, e.size])
          .sort(),
      );
      const listing = await r.w.store.list();
      expect(listing.parts).toEqual([]);
      expect(listing.partStates).toEqual([]);
      // events: model.load.failed code out_of_memory, then model.unload reason out_of_memory
      const failed = eventsNamed(r.events, 'model.load.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.attrs['code']).toBe('out_of_memory');
      expect(failed[0]!.attrs['host']).toBe('worker');
      const [u] = unloads(r.events);
      expect(unloads(r.events)).toHaveLength(1);
      expect(u!.attrs['reason']).toBe('out_of_memory');
      expect(u!.level).toBe('warn');
      expect(typeof u!.durationMs).toBe('number');
      // privacy: the sentinel is in no event
      expect(everything(r)).not.toContain(SENTINEL);
      for (const e of r.events.snapshot())
        expect(validateSchema(SCHEMAS.event, e).ok, e.name).toBe(true);
    });

  for (const [name, make] of NOT_MEMORY_ERRORS)
    it(`${name} stays code backend: only an allocation failure is out_of_memory`, async () => {
      const r = await workerRig({ engine: { pipelineError: make() } });
      const err: unknown = await r.load().catch((e: unknown) => e);
      expect((err as AdapterError).code).toBe('backend');
      expect(everything(r)).not.toContain(SENTINEL);
    });
});

describe('R18 during generate: model.generate with finishReason error and the code', () => {
  it('a memory error in the decode loop rejects out_of_memory, emits model.generate (error, code out_of_memory), then terminates the worker and emits model.unload', async () => {
    const r = await workerRig({
      engine: { generateError: new RangeError(`WebAssembly.Memory.grow(): failed ${SENTINEL}`) },
    });
    await r.load();
    const err: unknown = await r.adapter
      .generate('hello', { maxTokens: 8 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('out_of_memory');
    expect((err as AdapterError).message).not.toContain(SENTINEL);
    await new Promise((res) => setTimeout(res, 5));
    const gen = eventsNamed(r.events, 'model.generate');
    expect(gen).toHaveLength(1);
    expect(gen[0]!.attrs['finishReason']).toBe('error');
    expect(gen[0]!.attrs['code']).toBe('out_of_memory');
    expect(gen[0]!.attrs['host']).toBe('worker');
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect(await refcounts(r)).toEqual((await refcounts(r)).map(() => 0));
    expect(unloads(r.events).map((e) => e.attrs['reason'])).toEqual(['out_of_memory']);
    // the adapter is not loaded any more and nothing retries by itself
    await expect(r.adapter.generate('again')).rejects.toMatchObject({ code: 'not_loaded' });
    expect(r.workers).toHaveLength(1);
    expect(everything(r)).not.toContain(SENTINEL);
    for (const e of r.events.snapshot())
      expect(validateSchema(SCHEMAS.event, e).ok, e.name).toBe(true);
  });

  it('a non-memory engine error in generate is unchanged: backend, the worker stays usable, no model.unload', async () => {
    const r = await workerRig({ engine: { generateError: new Error(`boom ${SENTINEL}`) } });
    await r.load();
    await expect(r.adapter.generate('hello')).rejects.toMatchObject({ code: 'backend' });
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(false);
    expect(unloads(r.events)).toHaveLength(0);
    expect(everything(r)).not.toContain(SENTINEL);
  });
});

describe('R18 during embed: model.embed outcome out_of_memory', () => {
  it('a memory error in an embedding call rejects out_of_memory and ends the worker', async () => {
    const r = await workerRig({
      world: embedderWorld,
      engine: { embedError: new RangeError(`Array buffer allocation failed ${SENTINEL}`) },
    });
    await r.load();
    await expect(r.adapter.embed(['a', 'b'])).rejects.toMatchObject({ code: 'out_of_memory' });
    const em = eventsNamed(r.events, 'model.embed');
    expect(em).toHaveLength(1);
    expect(em[0]!.attrs['outcome']).toBe('out_of_memory');
    expect(em[0]!.attrs['inputs']).toBe(2);
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect(unloads(r.events).map((e) => e.attrs['reason'])).toEqual(['out_of_memory']);
    expect(everything(r)).not.toContain(SENTINEL);
  });
});

describe('the message validator takes the code and nothing else', () => {
  it("an error message with code 'out_of_memory' is valid and keeps its code; the cause is dropped", () => {
    const v = createWorkerMessageValidator();
    const r = v({ v: 1, type: 'error', code: 'out_of_memory', cause: SENTINEL });
    expect(r).toEqual({ ok: true, message: { type: 'error', code: 'out_of_memory' } });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it('an unknown code still becomes backend', () => {
    const v = createWorkerMessageValidator();
    expect(v({ v: 1, type: 'error', code: 'out_of_memory_please' })).toEqual({
      ok: true,
      message: { type: 'error', code: 'backend' },
    });
  });
});
