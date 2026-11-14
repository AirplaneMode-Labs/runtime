// D1-04: the worker RPC protocol (v1) and the strict validation of every message the main thread
// receives (R13). Written before src/worker/protocol.ts existed.

import { describe, expect, it } from 'vitest';
import {
  MAX_PHASE_MS,
  WORKER_PROTOCOL_VERSION,
  createWorkerMessageValidator,
  sanitiseEgressOrigin,
} from '../src/worker/protocol';

const ok = (m: unknown) => createWorkerMessageValidator()(m);
const base = { v: 1 } as const;

describe('worker protocol constants', () => {
  it('is protocol version 1 and caps durations at one day', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(1);
    expect(MAX_PHASE_MS).toBe(86_400_000);
  });
});

describe('validateWorkerMessage: valid messages', () => {
  it('phase: a known phase, a finite duration, bytes a safe integer or absent', () => {
    expect(ok({ ...base, type: 'phase', phase: 'handoff', durationMs: 12.5, bytes: 1024 })).toEqual(
      {
        ok: true,
        message: { type: 'phase', phase: 'handoff', durationMs: 12.5, bytes: 1024 },
      },
    );
    expect(ok({ ...base, type: 'phase', phase: 'session', durationMs: 0 })).toMatchObject({
      ok: true,
    });
    expect(
      ok({ ...base, type: 'phase', phase: 'session', durationMs: 5, bytes: null }),
    ).toMatchObject({
      ok: true,
      message: { type: 'phase', phase: 'session', durationMs: 5 },
    });
    expect(
      ok({ ...base, type: 'phase', phase: 'acquire', durationMs: MAX_PHASE_MS }),
    ).toMatchObject({ ok: true });
  });

  it('memory: scope worker, a known point and api, figures safe integers or null', () => {
    const m = {
      ...base,
      type: 'memory',
      scope: 'worker',
      at: 'after_session',
      api: 'none',
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
    };
    expect(ok(m)).toEqual({
      ok: true,
      message: {
        type: 'memory',
        scope: 'worker',
        at: 'after_session',
        api: 'none',
        usedJsHeap: null,
        totalJsHeap: null,
        jsHeapLimit: null,
        wasmMemory: null,
      },
    });
    expect(
      ok({
        ...m,
        api: 'performance.memory',
        usedJsHeap: 5,
        totalJsHeap: 6,
        jsHeapLimit: 7,
        wasmMemory: 65536,
      }),
    ).toMatchObject({ ok: true });
  });

  it('ready, token, done, error and egress', () => {
    expect(ok({ ...base, type: 'ready' })).toMatchObject({ ok: true });
    expect(ok({ ...base, type: 'token', id: 1, text: 'Par' })).toMatchObject({
      ok: true,
      message: { type: 'token', id: 1, text: 'Par' },
    });
    const done = {
      ...base,
      type: 'done',
      id: 1,
      result: {
        text: 'Paris',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 2 },
        timings: { prefillMs: 3, decodeMs: 4, tokensPerSecond: 5, firstTokenMs: 3 },
      },
    };
    expect(ok(done)).toMatchObject({ ok: true });
    expect(
      ok({ ...base, type: 'error', code: 'integrity', cause: 'whatever the engine said' }),
    ).toEqual({
      ok: true,
      message: { type: 'error', code: 'integrity' },
    });
    expect(ok({ ...base, type: 'egress', origin: 'https://huggingface.co' })).toEqual({
      ok: true,
      message: { type: 'egress', origin: 'https://huggingface.co' },
    });
  });
});

describe('validateWorkerMessage: everything else is a crash', () => {
  const bad = (m: unknown) => expect(ok(m)).toEqual({ ok: false });

  it('non-objects, arrays, the wrong version, unknown types and extra keys', () => {
    for (const m of [null, undefined, 0, 'x', true, [], [1], () => 0, Symbol('s')]) bad(m);
    bad({ type: 'ready' });
    bad({ v: 2, type: 'ready' });
    bad({ v: '1', type: 'ready' });
    bad({ ...base, type: 'init' }); // a main-to-worker type
    bad({ ...base, type: 'nope' });
    bad({ ...base, type: 123 });
    bad({ ...base, type: 'ready', extra: 1 });
    bad({ ...base, type: 'token', id: 1, text: 'x', extra: 1 });
    bad(Object.create({ type: 'ready', v: 1 })); // inherited, not own
  });

  it('phase: unknown phase, NaN, infinite, negative, over a day, bad bytes, a repeat', () => {
    const p = (o: object) => ({ ...base, type: 'phase', phase: 'session', durationMs: 1, ...o });
    bad(p({ phase: 'download' }));
    bad(p({ phase: 7 }));
    bad(p({ durationMs: Number.NaN }));
    bad(p({ durationMs: Infinity }));
    bad(p({ durationMs: -1 }));
    bad(p({ durationMs: MAX_PHASE_MS + 1 }));
    bad(p({ durationMs: '1' }));
    bad(p({ bytes: -1 }));
    bad(p({ bytes: 1.5 }));
    bad(p({ bytes: 2 ** 53 }));
    bad(p({ bytes: '5' }));
    const v = createWorkerMessageValidator();
    expect(v(p({}))).toMatchObject({ ok: true });
    expect(v(p({}))).toEqual({ ok: false }); // at most once per load
    expect(v(p({ phase: 'verify' }))).toMatchObject({ ok: true });
  });

  it('memory: wrong scope, point or api, figures that are not safe integers or null', () => {
    const m = (o: object) => ({
      ...base,
      type: 'memory',
      scope: 'worker',
      at: 'on_demand',
      api: 'none',
      usedJsHeap: null,
      totalJsHeap: null,
      jsHeapLimit: null,
      wasmMemory: null,
      ...o,
    });
    bad(m({ scope: 'page' }));
    bad(m({ at: 'whenever' }));
    bad(m({ api: 'navigator.deviceMemory' }));
    bad(m({ usedJsHeap: -5 }));
    bad(m({ usedJsHeap: 1.5 }));
    bad(m({ totalJsHeap: Number.NaN }));
    bad(m({ jsHeapLimit: '9' }));
    bad(m({ wasmMemory: 2 ** 60 }));
    bad(m({ usedJsHeap: undefined }));
  });

  it('token and done: ids, text types and sizes, result shape', () => {
    bad({ ...base, type: 'token', id: -1, text: 'x' });
    bad({ ...base, type: 'token', id: 1.5, text: 'x' });
    bad({ ...base, type: 'token', id: 1, text: 5 });
    bad({ ...base, type: 'token', id: 1, text: 'x'.repeat(70_000) });
    const done = (r: unknown) => ({ ...base, type: 'done', id: 1, result: r });
    const good = { text: 't', finishReason: 'stop', usage: {}, timings: {} };
    expect(ok(done(good))).toMatchObject({ ok: true });
    bad(done({ ...good, finishReason: 'exploded' }));
    bad(done({ ...good, text: 5 }));
    bad(done({ ...good, text: 'x'.repeat(9 * 1024 * 1024) }));
    bad(done({ ...good, usage: { promptTokens: -1 } }));
    bad(done({ ...good, timings: { prefillMs: Number.NaN } }));
    bad(done({ ...good, timings: { decodeMs: Infinity } }));
    bad(done({ ...good, extra: 1 }));
    bad(done({ ...good, usage: { promptTokens: 1, evil: 1 } }));
    bad(done(null));
    bad({ ...base, type: 'done', id: 1 });
  });

  it('error: the code becomes backend unless it is an AdapterErrorCode, and the cause never survives', () => {
    expect(ok({ ...base, type: 'error', code: 'exploded', cause: 'x' })).toEqual({
      ok: true,
      message: { type: 'error', code: 'backend' },
    });
    expect(ok({ ...base, type: 'error', code: 'aborted' })).toEqual({
      ok: true,
      message: { type: 'error', code: 'aborted' },
    });
    expect(ok({ ...base, type: 'error', code: 'egress_refused' })).toMatchObject({ ok: true });
    expect(ok({ ...base, type: 'error', code: 5 })).toEqual({
      ok: true,
      message: { type: 'error', code: 'backend' },
    });
    bad({ ...base, type: 'error', code: 'backend', cause: 'x'.repeat(100_000) });
    const sentinel = 'SENTINEL-PROMPT-7f3a';
    const r = ok({ ...base, type: 'error', code: 'backend', cause: sentinel });
    expect(JSON.stringify(r)).not.toContain(sentinel);
  });

  it('egress origin: a clean origin passes, anything else is recorded as invalid', () => {
    for (const o of [
      'https://example.invalid',
      'http://127.0.0.1:8790',
      'wss://a.b-c.d:443',
      'ftp://h',
      'data:',
      'blob:',
      'file:',
    ]) {
      expect(sanitiseEgressOrigin(o), o).toBe(o);
      expect(ok({ ...base, type: 'egress', origin: o })).toEqual({
        ok: true,
        message: { type: 'egress', origin: o },
      });
    }
    for (const o of [
      'https://evil.test/path?q=SENTINEL-PROMPT',
      'https://evil.test/path',
      'https://user:pw@evil.test',
      'javascript:alert(1)',
      'https://',
      'x'.repeat(400),
      'https://' + 'a'.repeat(300) + '.test',
      '<img src=x>',
      '',
      'https://exa mple.test',
      'HTTPS://EXAMPLE.TEST/\u0000',
    ]) {
      expect(sanitiseEgressOrigin(o), o).toBe('invalid');
      expect(ok({ ...base, type: 'egress', origin: o })).toEqual({
        ok: true,
        message: { type: 'egress', origin: 'invalid' },
      });
    }
    expect(sanitiseEgressOrigin(5)).toBe('invalid');
    expect(sanitiseEgressOrigin(null)).toBe('invalid');
    expect(sanitiseEgressOrigin(undefined)).toBe('invalid');
  });
});
