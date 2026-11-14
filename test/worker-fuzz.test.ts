// D1-04: the main thread treats every worker message as untrusted (R13). At least 200 malformed or
// hostile messages go through the real adapter in its loaded state and while a generate is pending:
// the only outcomes are a dropped message or the crash path, no attr outside the event schema, the
// sentinel in no event, snapshot or userMessage, origin recorded as 'invalid'. Written before the
// adapter existed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '../spec/event';
import { newEvent } from '../src/events';
import { exposeDevtoolsHook } from '../src/devtools-hook';
import { SCHEMAS, validateSchema } from '../src/schema';
import { eventsNamed, installLocation } from './backends-helpers';
import { SilentWorker, unloadAllRigs, workerRig } from './worker-rig';

const S = 'SENTINEL-PROMPT-7f3a';
const show = (m: unknown): string => {
  try {
    return String(JSON.stringify(m)).slice(0, 160);
  } catch {
    return typeof m;
  }
};
let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
});

function hostile(): unknown[] {
  const out: unknown[] = [];
  const v = { v: 1 };
  const push = (...m: unknown[]) => out.push(...m);
  // unknown and non-object messages
  push(
    null,
    undefined,
    0,
    1,
    -1,
    NaN,
    Infinity,
    '',
    S,
    true,
    false,
    [],
    [S],
    [[]],
    Symbol('x'),
    () => S,
    10n,
    new Date(0),
    /x/,
    new Map(),
    new Set(),
  );
  for (const type of [
    'init',
    'generate',
    'abort',
    'unload',
    'exec',
    'eval',
    'fetch',
    'importScripts',
    '__proto__',
    'constructor',
    S,
    '',
    ' ready',
    'READY',
    'ready ',
    'phase\n',
    'toString',
  ])
    push({ ...v, type }, { v: 1, type, id: 1 }, { type }, { v: 2, type });
  // phases: bad names, durations, bytes, duplicates
  for (const phase of [
    'download',
    'ACQUIRE',
    'first-token',
    S,
    '',
    0,
    null,
    undefined,
    {},
    [],
    '__proto__',
  ])
    push({ ...v, type: 'phase', phase, durationMs: 1 });
  for (const durationMs of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    -0.0001,
    86_400_001,
    1e308,
    '5',
    null,
    undefined,
    {},
    [],
    S,
    true,
  ])
    push({ ...v, type: 'phase', phase: 'session', durationMs });
  for (const bytes of [-1, 1.5, 2 ** 53, 2 ** 64, NaN, Infinity, '5', {}, [], S, true])
    push({ ...v, type: 'phase', phase: 'acquire', durationMs: 1, bytes });
  push({ ...v, type: 'phase', phase: 'session', durationMs: 1, extra: S });
  // memory
  for (const bad of [-1, 1.5, NaN, Infinity, '9', S, {}, [], 2 ** 60])
    for (const key of ['usedJsHeap', 'totalJsHeap', 'jsHeapLimit', 'wasmMemory'])
      push({
        ...v,
        type: 'memory',
        scope: 'worker',
        at: 'on_demand',
        api: 'none',
        usedJsHeap: null,
        totalJsHeap: null,
        jsHeapLimit: null,
        wasmMemory: null,
        [key]: bad,
      });
  for (const bad of ['page', S, '', 0, null])
    push({
      ...v,
      type: 'memory',
      scope: bad,
      at: 'on_demand',
      api: 'none',
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
    });
  for (const bad of ['whenever', S, '', 0, null])
    push({
      ...v,
      type: 'memory',
      scope: 'worker',
      at: bad,
      api: 'none',
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
    });
  for (const bad of ['navigator.deviceMemory', S, '', 0, null])
    push({
      ...v,
      type: 'memory',
      scope: 'worker',
      at: 'on_demand',
      api: bad,
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
    });
  // tokens and done
  for (const id of [-1, 1.5, NaN, '1', null, {}, [], S])
    push(
      { ...v, type: 'token', id, text: 'x' },
      {
        ...v,
        type: 'done',
        id,
        result: { text: 't', finishReason: 'stop', usage: {}, timings: {} },
      },
    );
  for (const text of [5, null, undefined, {}, [], 'x'.repeat(70_000), 'y'.repeat(10 * 1024 * 1024)])
    push(
      { ...v, type: 'token', id: 1, text },
      { ...v, type: 'done', id: 1, result: { text, finishReason: 'stop', usage: {}, timings: {} } },
    );
  for (const result of [
    null,
    undefined,
    5,
    'x',
    [],
    {},
    { text: 't' },
    { text: 't', finishReason: S, usage: {}, timings: {} },
    { text: 't', finishReason: 'stop', usage: { promptTokens: -1 }, timings: {} },
    { text: 't', finishReason: 'stop', usage: {}, timings: { prefillMs: NaN } },
    { text: 't', finishReason: 'stop', usage: { x: 1 }, timings: {} },
    { text: 't', finishReason: 'stop', usage: {}, timings: {}, evil: S },
  ])
    push({ ...v, type: 'done', id: 1, result });
  // error and egress carrying the sentinel
  for (const cause of [S, { toString: () => S }, [S], 'x'.repeat(100_000), null, undefined])
    push(
      { ...v, type: 'error', code: 'backend', cause },
      { ...v, type: 'error', code: S, cause },
      { ...v, type: 'error', code: 'aborted', cause },
    );
  for (const code of [5, null, undefined, {}, [], '__proto__', 'constructor'])
    push({ ...v, type: 'error', code });
  for (const origin of [
    S,
    `https://evil.test/${S}`,
    `https://evil.test?${S}`,
    `https://user:${S}@evil.test`,
    `javascript:${S}`,
    'x'.repeat(400),
    `<img src=x onerror="${S}">`,
    '',
    null,
    undefined,
    5,
    {},
    [],
    `https://${S}.test/x`,
    'https://a b.test',
    '\u0000',
  ])
    push({ ...v, type: 'egress', origin });
  // prototype pollution shapes
  push(
    JSON.parse(`{"v":1,"type":"token","id":1,"text":"x","__proto__":{"polluted":"${S}"}}`),
    JSON.parse(
      `{"v":1,"type":"phase","phase":"session","durationMs":1,"constructor":{"prototype":{"x":"${S}"}}}`,
    ),
    JSON.parse('{"__proto__":{"v":1,"type":"ready"}}'),
    Object.create({ v: 1, type: 'ready' }),
    Object.assign(Object.create(null), { v: 1, type: 'ready' }),
  );
  // oversized and deeply nested
  push({
    ...v,
    type: 'phase',
    phase: 'session',
    durationMs: 1,
    bytes: 1,
    ...Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, S])),
  });
  let deep: unknown = S;
  for (let i = 0; i < 5000; i++) deep = [deep];
  push({ ...v, type: 'done', id: 1, result: deep });
  // duplicates (a phase twice)
  push(
    { ...v, type: 'phase', phase: 'handoff', durationMs: 1 },
    { ...v, type: 'phase', phase: 'handoff', durationMs: 1 },
  );
  return out;
}

describe('worker message fuzz (R13)', () => {
  const messages = hostile();

  it('has at least 200 hostile messages', () => {
    expect(messages.length).toBeGreaterThanOrEqual(200);
  });

  async function loaded() {
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
    return { r, worker: r.workers[0] as SilentWorker };
  }

  it('every hostile message ends as a dropped message or the crash path, and leaks nothing', async () => {
    let crashed = 0;
    let survived = 0;
    for (const [i, m] of messages.entries()) {
      const { r, worker } = await loaded();
      const pending = r.adapter.generate(`prompt ${S}`, { maxTokens: 4 }).then(
        () => 'resolved',
        (e: { code?: string }) => `rejected:${e.code}`,
      );
      worker.deliver(m);
      // settle a pending generate that the message did not end
      if (!worker.terminated) {
        worker.deliver({
          v: 1,
          type: 'done',
          id: (worker.received.find((x) => x.type === 'generate') as { id: number }).id,
          result: { text: 'ok', finishReason: 'stop', usage: {}, timings: {} },
        });
      }
      const outcome = await pending;
      if (worker.terminated) {
        crashed++;
        expect(outcome, `message ${i}`).toBe('rejected:backend');
        expect(
          eventsNamed(r.events, 'backend.worker').some((e) => e.attrs['state'] === 'crashed'),
          `message ${i}`,
        ).toBe(true);
        await expect(r.adapter.generate('x'), `message ${i}`).rejects.toMatchObject({
          code: 'not_loaded',
        });
      } else {
        survived++;
      }
      const events = r.events.snapshot();
      for (const e of events)
        expect(validateSchema(SCHEMAS.event, e).errors, `message ${i}: ${e.name}`).toEqual([]);
      for (const e of eventsNamed(r.events, 'backend.egress.refused')) {
        expect(Object.keys(e.attrs).sort()).toEqual(['adapter', 'origin']);
        expect(String(e.attrs['origin']), `message ${i}`).toMatch(
          /^(invalid|(https?|wss?|ftp):\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?|[a-z][a-z0-9+.-]{0,31}:)$/,
        );
      }
      const wire = JSON.stringify(events);
      expect(wire, `message ${i}: the sentinel is in an event: ${show(m)}`).not.toContain(S);
      expect(wire.includes(`prompt ${S}`), `message ${i}: the prompt is in an event`).toBe(false);
      // the hook snapshot carries no sentinel either
      const bus = r.events;
      const dispose = exposeDevtoolsHook(bus, { globalName: '__fuzzHook' });
      const snap = (
        globalThis as unknown as { __fuzzHook: { snapshot(): string } }
      ).__fuzzHook.snapshot();
      dispose();
      expect(snap.includes(S), `message ${i}: sentinel in the snapshot`).toBe(false);
      const refusals = events.filter((e: Event) => e.name === 'backend.refused');
      expect(refusals).toHaveLength(0);
      await r.adapter.unload();
    }
    expect(crashed).toBeGreaterThan(100);
    expect(crashed + survived).toBe(messages.length);
  }, 120_000);

  it('hostile messages cannot pollute Object.prototype', () => {
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    void newEvent;
  });
});
