// D1-05 (backend adapter 0.4.0, R14): embeddings through the worker host. A loopback worker drives the real
// TjsEngine over a mocked Transformers.js module (the real model is test:model, local-only). Written before
// embed() existed on the worker adapter (red run: evidence/sprint-5/D1/red/D1-05.log).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_MAX_TEXTS, EMBED_TEXT_MAX } from '../spec/backend-adapter';
import { eventsNamed, installLocation } from './backends-helpers';
import { SilentWorker, unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
});

const embedderWorld = {
  descriptor: (d: Record<string, unknown>) => {
    d['task'] = 'feature-extraction';
    d['devices'] = ['wasm'];
    d['contextLength'] = 512;
  },
};
const SECRET = 'SENTINEL-EMBED-TEXT-31c7';

describe('R14: embed() through the worker host', () => {
  it('capabilities say embed and not generate; embed returns one unit vector per text', async () => {
    const r = await workerRig({ world: embedderWorld, engine: { embedDims: 8 } });
    await r.load();
    expect(r.adapter.capabilities()).toEqual({ generate: false, embed: true, streaming: true });
    const res = await r.adapter.embed(['query: hello', 'passage: world']);
    expect(res.dims).toBe(8);
    expect(res.normalized).toBe(true);
    expect(res.vectors).toHaveLength(2);
    for (const v of res.vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(8);
      expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-6);
    }
    expect(res.truncated).toBe(false);
    expect(res.timings!.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('two runs over the same input are bit-identical', async () => {
    const r = await workerRig({ world: embedderWorld });
    await r.load();
    const a = await r.adapter.embed(['one', 'two', 'three']);
    const b = await r.adapter.embed(['one', 'two', 'three']);
    for (let i = 0; i < 3; i++)
      expect(Buffer.from(a.vectors[i]!.buffer).equals(Buffer.from(b.vectors[i]!.buffer))).toBe(
        true,
      );
  });

  it('pooling and normalize options reach the engine; the defaults are mean and true', async () => {
    const r = await workerRig({ world: embedderWorld });
    await r.load();
    await r.adapter.embed(['a']);
    await r.adapter.embed(['a'], { pooling: 'cls', normalize: false });
    const mock = (r.workers[0] as unknown as { mock: { generateCalls: { options: unknown }[] } })
      .mock;
    expect(mock.generateCalls.map((c) => c.options)).toEqual([
      { pooling: 'mean', normalize: true },
      { pooling: 'cls', normalize: false },
    ]);
  });

  it('EMBED limits are TypeErrors before any message reaches the worker', async () => {
    const r = await workerRig({ world: embedderWorld });
    await r.load();
    const before = r.workers[0]!.received?.length ?? 0;
    const bad: unknown[] = [
      [],
      Array.from({ length: EMBED_MAX_TEXTS + 1 }, () => 'x'),
      [''],
      ['x'.repeat(EMBED_TEXT_MAX + 1)],
      ['ok', '\ud800'],
      [5],
      'not an array',
      [null],
    ];
    for (const texts of bad)
      await expect(r.adapter.embed(texts as string[])).rejects.toBeInstanceOf(TypeError);
    // the limits themselves are fine
    await expect(
      r.adapter.embed(Array.from({ length: EMBED_MAX_TEXTS }, () => 'x'.repeat(EMBED_TEXT_MAX))),
    ).resolves.toMatchObject({ vectors: expect.any(Array) });
    expect((r.workers[0] as unknown as { received: unknown[] }).received.length - before).toBe(1);
  });

  it('embed before load is not_loaded; generate on an embedder and embed on a generator are unsupported_operation', async () => {
    const r = await workerRig({ world: embedderWorld });
    await expect(r.adapter.embed(['x'])).rejects.toMatchObject({ code: 'not_loaded' });
    await r.load();
    await expect(r.adapter.generate('x')).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
    const g = await workerRig();
    await g.load();
    await expect(g.adapter.embed(['x'])).rejects.toMatchObject({ code: 'unsupported_operation' });
    expect(g.adapter.capabilities().embed).toBe(false);
  });

  it('an abort mid-embed rejects aborted and the worker stays usable; a pre-aborted signal posts nothing', async () => {
    const r = await workerRig({ world: embedderWorld, engine: { embedDelayMs: 60 } });
    await r.load();
    const worker = r.workers[0] as unknown as {
      terminated: boolean;
      received: { type?: string }[];
    };
    const ctl = new AbortController();
    const p = r.adapter.embed(['slow'], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(worker.terminated).toBe(false);
    const after = await r.adapter.embed(['again']);
    expect(after.vectors).toHaveLength(1);
    const pre = new AbortController();
    pre.abort();
    const n = worker.received.length;
    await expect(r.adapter.embed(['x'], { signal: pre.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(worker.received.length).toBe(n);
  });

  it('model.embed carries exact attrs and never an input text or a vector', async () => {
    const r = await workerRig({
      world: embedderWorld,
      engine: { tokenCount: (t) => t.length },
    });
    await r.load();
    await r.adapter.embed([SECRET, 'x'.repeat(600)]);
    const [e] = eventsNamed(r.events, 'model.embed');
    expect(e).toBeDefined();
    expect(e!.kind).toBe('timing');
    expect(e!.level).toBe('info');
    expect(e!.durationMs).toBeGreaterThanOrEqual(0);
    expect(e!.attrs).toEqual({
      adapter: 'transformers-js',
      model: 'm.descriptor',
      device: 'wasm',
      host: 'worker',
      loadId: expect.stringMatching(/^[0-9a-f]{16}$/),
      inputs: 2,
      truncated: 1, // the 600-token text is cut to the 512 context
      dims: 3,
      outcome: 'ok',
    });
    const wire = JSON.stringify(r.events.snapshot());
    expect(wire).not.toContain(SECRET);
    const res = await r.adapter.embed([SECRET, 'x'.repeat(600)]);
    expect(res.truncated).toBe(true);
  });

  it('a failed embed records outcome with the error code and still no text', async () => {
    const r = await workerRig({ world: embedderWorld });
    await r.load();
    await expect(r.adapter.embed([SECRET], { signal: AbortSignal.abort() })).rejects.toBeTruthy();
    const failing = await workerRig({ world: embedderWorld, engine: {} });
    await failing.load();
    // a worker that lies about the vector count (see the fuzz below) records outcome 'backend'
    expect(JSON.stringify(failing.events.snapshot())).not.toContain(SECRET);
  });
});

describe('R14: the host does not trust the worker embed response (fuzz)', () => {
  async function silentEmbedder(reply: (id: unknown, self: SilentWorker) => void) {
    const r = await workerRig({
      world: embedderWorld,
      spawn: (u, n) => {
        const w = new SilentWorker(u, n);
        w.script = (m, self) => {
          if (m.type === 'init') self.deliver({ v: 1, type: 'ready' });
          if (m.type === 'embed') reply(m['id'], self);
        };
        return w;
      },
    });
    await r.load();
    return r;
  }
  const good = () => [new Float32Array([0.6, 0.8, 0])];

  it('a correct response is accepted', async () => {
    const r = await silentEmbedder((id, w) =>
      w.deliver({
        v: 1,
        type: 'embedded',
        id,
        dims: 3,
        vectors: good(),
        normalized: true,
        truncated: 0,
        totalMs: 1,
      }),
    );
    await expect(r.adapter.embed(['a'])).resolves.toMatchObject({ dims: 3 });
  });

  const lies: [string, (id: unknown) => Record<string, unknown>][] = [
    ['too few vectors', (id) => ({ id, dims: 3, vectors: [] })],
    ['too many vectors', (id) => ({ id, dims: 3, vectors: [...good(), ...good()] })],
    ['a vector of the wrong length', (id) => ({ id, dims: 4, vectors: good() })],
    [
      'a plain array instead of a Float32Array',
      (id) => ({ id, dims: 3, vectors: [[0.6, 0.8, 0]] }),
    ],
    ['a Float64Array', (id) => ({ id, dims: 3, vectors: [new Float64Array([0.6, 0.8, 0])] })],
    ['a NaN component', (id) => ({ id, dims: 3, vectors: [new Float32Array([NaN, 0.8, 0])] })],
    [
      'an Infinity component',
      (id) => ({ id, dims: 3, vectors: [new Float32Array([Infinity, 0.8, 0])] }),
    ],
  ];
  for (const [name, build] of lies) {
    it(`rejects backend for ${name}`, async () => {
      const r = await silentEmbedder((id, w) =>
        w.deliver({
          v: 1,
          type: 'embedded',
          normalized: true,
          truncated: 0,
          totalMs: 1,
          ...build(id),
        }),
      );
      await expect(r.adapter.embed(['a'])).rejects.toMatchObject({ code: 'backend' });
      expect(JSON.stringify(r.events.snapshot())).not.toContain('NaN');
    });
  }

  // BUG-T2-S5-06 (fix round 1): the host resolves with fresh, non-shared copies, so a view the worker still
  // holds (shared memory, a bigger buffer, a subclass) cannot change after the finiteness check.
  const aliasing: [string, () => Float32Array][] = [
    [
      'a SharedArrayBuffer-backed view',
      () => new Float32Array(new SharedArrayBuffer(12)).fill(0.5),
    ],
    [
      'a non-zero byteOffset view of a bigger buffer',
      () => new Float32Array(new Float32Array([9, 9, 0.5, 0.5, 0.5, 9]).buffer, 8, 3),
    ],
    [
      'a Float32Array subclass',
      () => {
        class Sub extends Float32Array {}
        return new Sub([0.5, 0.5, 0.5]);
      },
    ],
  ];
  for (const [name, make] of aliasing) {
    it(`resolves with a fresh plain non-shared copy for ${name}`, async () => {
      const theirs = make();
      const r = await silentEmbedder((id, w) =>
        w.deliver({
          v: 1,
          type: 'embedded',
          id,
          dims: 3,
          vectors: [theirs],
          normalized: true,
          truncated: 0,
          totalMs: 1,
        }),
      );
      const res = await r.adapter.embed(['a']);
      const got = res.vectors[0]!;
      expect(Object.getPrototypeOf(got)).toBe(Float32Array.prototype);
      expect(got.byteOffset).toBe(0);
      expect(got.buffer).not.toBe(theirs.buffer);
      expect(got.buffer instanceof ArrayBuffer).toBe(true);
      expect(got.buffer.byteLength).toBe(12);
      expect(Array.from(got)).toEqual([0.5, 0.5, 0.5]);
      theirs[0] = NaN; // the worker flips a component after validation: the result is unaffected
      expect(Array.from(got)).toEqual([0.5, 0.5, 0.5]);
    });
  }

  it('a malformed embedded message (bad shape) is a crash: the worker is terminated and the call rejects backend', async () => {
    const r = await silentEmbedder((id, w) =>
      w.deliver({ v: 1, type: 'embedded', id, dims: '3', vectors: good() }),
    );
    await expect(r.adapter.embed(['a'])).rejects.toMatchObject({ code: 'backend' });
    expect((r.workers[0] as unknown as { terminated: boolean }).terminated).toBe(true);
  });

  it('a late response for an aborted call is ignored', async () => {
    let held: { id: unknown; w: SilentWorker } | undefined;
    const r = await silentEmbedder((id, w) => (held = { id, w }));
    const ctl = new AbortController();
    const p = r.adapter.embed(['a'], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    held!.w.deliver({
      v: 1,
      type: 'embedded',
      id: held!.id,
      dims: 3,
      vectors: good(),
      normalized: true,
      truncated: 0,
      totalMs: 1,
    });
    expect((r.workers[0] as unknown as { terminated: boolean }).terminated).toBe(false);
  });
});
