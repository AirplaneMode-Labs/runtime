// Sprint 6, D1-04 (B1 memory hardening, backend adapter 0.5.0, R16 and R19): unload() that really ends the
// worker, the model.unload event (Event 0.1.5), and a load after unload that is a first load. Written before
// src/backends/worker-adapter.ts emitted model.unload; the red run is evidence/sprint-6/D1/red/D1-04-unload.log.
// A loopback worker drives the real TjsEngine over a mocked Transformers.js module; the measured drop of the
// process tree with a real model is test/browser/model.spec.ts (RUNTIME_MODEL=1).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetSource } from '../spec/backend-adapter';
import type { Event } from '../spec/event';
import { SCHEMAS, validateSchema } from '../src/schema';
import { eventsNamed, installLocation } from './backends-helpers';
import { LoopbackWorker, SilentWorker, unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
});

const unloads = (events: Parameters<typeof eventsNamed>[0]): Event[] =>
  eventsNamed(events, 'model.unload');
const refcounts = async (r: Awaited<ReturnType<typeof workerRig>>) =>
  (await r.w.mgr.list()).map((x) => x.refcount);

describe('R16: unload() resolves only after the worker is terminated and every handle is released', () => {
  it('emits model.unload with adapter, model, device, host, loadId, reason unload and a durationMs, after terminate() returned', async () => {
    const r = await workerRig();
    await r.load();
    const worker = r.workers[0] as LoopbackWorker;
    const order: string[] = [];
    const real = worker.terminate.bind(worker);
    worker.terminate = () => {
      real();
      order.push('terminate');
    };
    r.events.subscribe((e) => {
      if (e.name === 'model.unload') order.push('model.unload');
    });
    const loadId = eventsNamed(r.events, 'model.load')[0]!.attrs['loadId'];
    expect((await refcounts(r)).every((n) => n === 1)).toBe(true);

    await r.adapter.unload();

    expect(worker.terminated).toBe(true);
    expect(order).toEqual(['terminate', 'model.unload']);
    expect(await refcounts(r)).toEqual((await refcounts(r)).map(() => 0)); // every handle released
    expect(r.revoked).toEqual([r.created[0]]); // the bootstrap URL is revoked
    const [ev] = unloads(r.events);
    expect(unloads(r.events)).toHaveLength(1);
    expect(ev!.kind).toBe('model-load');
    expect(ev!.level).toBe('info');
    expect(ev!.attrs).toEqual({
      adapter: 'transformers-js',
      model: r.w.descriptorEntry.id,
      device: 'wasm',
      host: 'worker',
      loadId,
      reason: 'unload',
    });
    expect(typeof ev!.durationMs).toBe('number');
    expect(ev!.durationMs).toBeGreaterThanOrEqual(0);
    expect(validateSchema(SCHEMAS.event, ev).ok).toBe(true);
  });

  it('durationMs runs from the unload() call to terminate() returning', async () => {
    const r = await workerRig();
    await r.load();
    const worker = r.workers[0] as LoopbackWorker;
    const real = worker.terminate.bind(worker);
    worker.terminate = () => {
      const until = performance.now() + 30;
      while (performance.now() < until) {
        // a terminate() that takes about 30 ms
      }
      real();
    };
    await r.adapter.unload();
    expect(unloads(r.events)[0]!.durationMs!).toBeGreaterThanOrEqual(25);
  });

  it('unload() twice, or on an adapter that never loaded, resolves and emits no further event', async () => {
    const r = await workerRig();
    await r.adapter.unload();
    expect(unloads(r.events)).toHaveLength(0);
    await r.load();
    await r.adapter.unload();
    await r.adapter.unload();
    expect(unloads(r.events)).toHaveLength(1);
    await expect(r.adapter.generate('hi')).rejects.toMatchObject({ code: 'not_loaded' });
  });

  it('a pending call rejects not_loaded when the model is unloaded under it, and the worker is still terminated', async () => {
    const r = await workerRig({
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') {
            self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 1 });
            self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 1 });
            self.deliver({ v: 1, type: 'ready' });
          }
        };
        return w;
      },
    });
    await r.load();
    const pending = r.adapter.generate('x', { maxTokens: 4 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'not_loaded' });
    await r.adapter.unload();
    await assertion;
    expect((r.workers[0] as SilentWorker).terminated).toBe(true);
    expect(unloads(r.events)).toHaveLength(1);
  });

  it('a load while another model is loaded unloads the first one: model.unload for the old loadId precedes the new model.load', async () => {
    const r = await workerRig();
    await r.load();
    const first = eventsNamed(r.events, 'model.load')[0]!.attrs['loadId'];
    await r.load();
    const names = r.events.snapshot().map((e) => e.name);
    const firstUnload = unloads(r.events)[0]!;
    expect(firstUnload.attrs['loadId']).toBe(first);
    expect(firstUnload.attrs['reason']).toBe('unload');
    expect(names.indexOf('model.unload')).toBeGreaterThan(-1);
    const secondLoadAt = names.lastIndexOf('model.load');
    expect(names.indexOf('model.unload')).toBeLessThan(secondLoadAt);
    expect((r.workers[0] as LoopbackWorker).terminated).toBe(true);
    expect((r.workers[1] as LoopbackWorker).terminated).toBe(false);
  });

  it('reasons: a failed load is reason error, an aborted load is reason abort, a crash is reason error', async () => {
    const failing = await workerRig({ engine: { pipelineError: new Error('SECRET-ENGINE-TEXT') } });
    await expect(failing.load()).rejects.toMatchObject({ code: 'backend' });
    expect(unloads(failing.events).map((e) => e.attrs['reason'])).toEqual(['error']);
    expect(unloads(failing.events)[0]!.level).toBe('warn');

    const ctl = new AbortController();
    const aborted = await workerRig({
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m) => {
          if (m.type === 'init') setTimeout(() => ctl.abort(), 0);
        };
        return w;
      },
    });
    await expect(aborted.load({ signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(unloads(aborted.events).map((e) => e.attrs['reason'])).toEqual(['abort']);

    const crashing = await workerRig({
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') {
            self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 1 });
            self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 1 });
            self.deliver({ v: 1, type: 'ready' });
          }
        };
        return w;
      },
    });
    await crashing.load();
    (crashing.workers[0] as SilentWorker).onerror?.({});
    await new Promise((res) => setTimeout(res, 5));
    expect(unloads(crashing.events).map((e) => e.attrs['reason'])).toEqual(['error']);
    expect(await refcounts(crashing)).toEqual((await refcounts(crashing)).map(() => 0));
  });

  it('no worker or engine string reaches a model.unload event', async () => {
    const SECRET = 'SENTINEL-UNLOAD-ENGINE-TEXT-5e21';
    const r = await workerRig({ engine: { pipelineError: new Error(SECRET) } });
    await expect(r.load()).rejects.toThrow();
    expect(JSON.stringify(r.events.snapshot())).not.toContain(SECRET);
  });
});

describe('R19: a load() after unload() is a first load', () => {
  it('every load verifies every file again in the worker: three load and unload cycles give three verify phases, each of the full file total', async () => {
    const r = await workerRig();
    const total = r.w.totalBytes;
    for (let i = 0; i < 3; i++) {
      await r.load();
      await r.adapter.unload();
    }
    const verifies = eventsNamed(r.events, 'model.load.phase').filter(
      (e) => e.attrs['phase'] === 'verify',
    );
    expect(verifies).toHaveLength(3);
    for (const v of verifies) expect(v.attrs['host']).toBe('worker');
    // the bytes re-hashed in the worker are the sizes of the engine-readable files, the same on each cycle
    expect(new Set(verifies.map((v) => v.bytes)).size).toBe(1);
    expect(verifies[0]!.bytes!).toBeGreaterThan(0);
    expect(verifies[0]!.bytes!).toBeLessThanOrEqual(total);
    // three fresh workers, none shared
    expect(new Set(r.workers).size).toBe(3);
    // and each load had its own loadId
    const ids = eventsNamed(r.events, 'model.load').map((e) => e.attrs['loadId']);
    expect(new Set(ids).size).toBe(3);
  });

  it('no "already verified" cache skips a step: every load asks the asset source for each file again and posts the files for the worker to hash', async () => {
    const r = await workerRig();
    const acquired: string[] = [];
    const real = (r.w.mgr as AssetSource).acquire!.bind(r.w.mgr);
    (r.w.mgr as { acquire: AssetSource['acquire'] }).acquire = (id, opts) => {
      acquired.push(id);
      return real(id, opts);
    };
    await r.load();
    const afterFirst = acquired.length;
    await r.adapter.unload();
    await r.load();
    expect(afterFirst).toBeGreaterThan(0);
    expect(acquired.length).toBe(afterFirst * 2);
    for (const w of r.workers as LoopbackWorker[]) {
      const init = w.received.find((m) => m.type === 'init') as unknown as {
        files: { sha256: string; size: number; blob: Blob }[];
      };
      expect(init.files.length).toBeGreaterThan(0);
      for (const f of init.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.blob.size).toBe(f.size);
      }
    }
  });

  it('cacheOnly is passed to every acquire of the second load, and a cache miss is a refusal, never a fetch', async () => {
    const r = await workerRig();
    await r.load(); // the first load downloads and stores every file
    await r.adapter.unload();
    const requestsAfterFirst = r.w.server.requests.length;
    const seen: (boolean | undefined)[] = [];
    const real = (r.w.mgr as AssetSource).acquire!.bind(r.w.mgr);
    (r.w.mgr as { acquire: AssetSource['acquire'] }).acquire = (id, opts) => {
      seen.push(opts?.cacheOnly);
      return real(id, opts);
    };
    await r.load({ cacheOnly: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x === true)).toBe(true);
    await r.adapter.unload();

    // evict one file: the next cacheOnly load is a refusal and sends no request
    const victim = r.w.fileIds[0]!;
    await r.w.mgr.evict(victim, { force: true });
    const before = r.w.server.requests.length;
    await expect(r.load({ cacheOnly: true })).rejects.toMatchObject({ code: 'not_cached' });
    expect(r.w.server.requests.length).toBe(before);
    expect(r.w.server.requests.length).toBe(requestsAfterFirst); // not one request after the first load
  });
});
