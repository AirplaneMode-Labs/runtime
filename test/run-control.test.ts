// D1-04: the Stop control of models.html (demo/run-control.ts). Written before the module existed (red
// run: evidence/sprint-4/D1/red-D1-04.log). The control drives two buttons and the read-out around one
// generate() call: Stop is enabled only while generate() runs, it fires the existing AbortController,
// and the read-out says 'Stopped' with the time to stop. Here it runs over the real worker adapter with a
// scripted worker that streams tokens and answers an abort promptly (the worker host of R8); the browser
// proof with a real model is test/browser/stop.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunControl, type RunControlUi } from '../demo/run-control';
import { installLocation } from './backends-helpers';
import { SilentWorker, unloadAllRigs, workerRig } from './worker-rig';

let restore: () => void;
beforeEach(() => {
  restore = installLocation();
});
afterEach(async () => {
  await unloadAllRigs();
  restore();
});

function fakeUi() {
  const log: string[] = [];
  const state = { run: true, stop: false, timing: '', answer: '', stopped: 0 };
  const ui: RunControlUi = {
    setRunEnabled(on) {
      state.run = on;
      log.push(`run:${on ? 'enabled' : 'disabled'}`);
    },
    setStopEnabled(on) {
      state.stop = on;
      log.push(`stop:${on ? 'enabled' : 'disabled'}`);
    },
    setAnswer(text) {
      state.answer = text;
    },
    appendAnswer(text) {
      state.answer += text;
    },
    setTiming(text) {
      state.timing = text;
    },
    onStopped() {
      state.stopped++;
    },
  };
  return { ui, state, log };
}

/** A worker host that streams a token every 15 ms until aborted, then answers 'abort' after 20 ms. */
function streamingWorker(u: string, n: string): SilentWorker {
  const w = new SilentWorker(u, n);
  const timers = new Map<number, ReturnType<typeof setInterval>>();
  w.script = (m, self) => {
    if (m.type === 'init') {
      self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 10 });
      self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 2 });
      self.deliver({ v: 1, type: 'ready' });
    } else if (m.type === 'generate') {
      const id = m['id'] as number;
      timers.set(
        id,
        setInterval(() => self.deliver({ v: 1, type: 'token', id, text: 'tok ' }), 15),
      );
    } else if (m.type === 'abort') {
      const id = m['id'] as number;
      clearInterval(timers.get(id));
      setTimeout(
        () =>
          self.deliver({
            v: 1,
            type: 'done',
            id,
            result: {
              text: 'tok tok',
              finishReason: 'abort',
              usage: { promptTokens: 3, completionTokens: 2 },
              timings: { prefillMs: 1, decodeMs: 2 },
            },
          }),
        20,
      );
    }
  };
  return w;
}

describe('createRunControl (the Stop button logic)', () => {
  it('the buttons go run disabled and stop enabled while generate() runs, then stop disabled and run enabled', async () => {
    const { ui, state, log } = fakeUi();
    const c = createRunControl(ui);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = c.run(async () => {
      await gate;
      return { finishReason: 'stop' as const };
    });
    expect(c.running).toBe(true);
    expect(state).toMatchObject({ run: false, stop: true });
    release();
    await p;
    expect(c.running).toBe(false);
    expect(state).toMatchObject({ run: true, stop: false });
    expect(log).toEqual(['run:disabled', 'stop:enabled', 'stop:disabled', 'run:enabled']);
  });

  it('stop() aborts the signal handed to generate(), disables Stop at once, and the read-out says Stopped with the time to stop', async () => {
    const { ui, state } = fakeUi();
    let t = 1000;
    const c = createRunControl(ui, () => t);
    let seen: AbortSignal | undefined;
    const p = c.run(
      (signal) =>
        new Promise<{ finishReason: 'abort' }>((resolve) => {
          seen = signal;
          signal.addEventListener('abort', () => {
            t += 37; // the engine needs 37 ms to land the abort
            resolve({ finishReason: 'abort' as const });
          });
        }),
    );
    expect(seen?.aborted).toBe(false);
    c.stop();
    expect(seen?.aborted).toBe(true);
    expect(state.stop).toBe(false);
    const out = await p;
    expect(out).toEqual({ stopped: true, timeToStopMs: 37 });
    expect(state.timing).toMatch(/^Stopped\b/);
    expect(state.timing).toContain('37 ms');
    expect(state).toMatchObject({ run: true, stop: false });
  });

  it('T1-S4-02: tells the page once, after the buttons are restored, that a Stop ended the run (so it can offer the reload)', async () => {
    const { ui, state } = fakeUi();
    const c = createRunControl(ui);
    const seen: { run: boolean; stop: boolean }[] = [];
    const wrapped: RunControlUi = {
      ...ui,
      onStopped() {
        seen.push({ run: state.run, stop: state.stop });
        ui.onStopped?.();
      },
    };
    const c2 = createRunControl(wrapped);
    const p = c2.run(
      (signal) =>
        new Promise<{ finishReason: 'abort' }>((resolve) =>
          signal.addEventListener('abort', () => resolve({ finishReason: 'abort' as const })),
        ),
    );
    c2.stop();
    expect(await p).toMatchObject({ stopped: true });
    expect(state.stopped).toBe(1);
    expect(seen).toEqual([{ run: true, stop: false }]); // the buttons are already restored when the page hears of it
    // a normal run and a failing run never call it
    await c.run(async () => ({ finishReason: 'stop' as const }));
    await c.run(
      async () => {
        throw new Error('boom');
      },
      () => undefined,
    );
    expect(state.stopped).toBe(1);
  });

  it('stop() with nothing running does nothing; a second stop() does not abort twice; run() while running is ignored', async () => {
    const { ui, log } = fakeUi();
    const c = createRunControl(ui);
    c.stop();
    expect(log).toEqual([]);
    let aborts = 0;
    let finish!: () => void;
    const p = c.run(
      (signal) =>
        new Promise<{ finishReason: 'abort' }>((resolve) => {
          signal.addEventListener('abort', () => aborts++);
          finish = () => resolve({ finishReason: 'abort' as const });
        }),
    );
    const second = c.run(async () => ({ finishReason: 'stop' as const }));
    c.stop();
    c.stop();
    expect(aborts).toBe(1);
    finish();
    await p;
    expect(await second).toEqual({ stopped: false });
  });

  it('a generate() that fails restores the buttons and reports through onError, never leaving Stop enabled', async () => {
    const { ui, state } = fakeUi();
    const c = createRunControl(ui);
    const errors: unknown[] = [];
    const out = await c.run(
      async () => {
        throw new Error('boom');
      },
      (e) => errors.push(e),
    );
    expect(out).toEqual({ stopped: false });
    expect(errors).toHaveLength(1);
    expect(state).toMatchObject({ run: true, stop: false });
  });

  it('over the real worker adapter: Stop lands within 1000 ms, the buttons read disabled, enabled, disabled, and the answer so far stays', async () => {
    const r = await workerRig({ spawn: (u, n) => streamingWorker(u, n) });
    await r.load();
    const { ui, state, log } = fakeUi();
    const c = createRunControl(ui);
    const p = c.run((signal) =>
      r.adapter.generate('say something long', {
        maxTokens: 512,
        signal,
        onToken: (t) => ui.appendAnswer(t),
      }),
    );
    await new Promise((res) => setTimeout(res, 120)); // a few tokens stream
    expect(state.stop).toBe(true);
    expect(state.answer.length).toBeGreaterThan(0);
    const before = state.answer;
    const t0 = performance.now();
    c.stop();
    const out = await p;
    const elapsed = performance.now() - t0;
    expect(out.stopped).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    expect(out.timeToStopMs).toBeLessThan(1000);
    expect(state.answer.startsWith(before)).toBe(true);
    expect(state.timing).toMatch(/^Stopped\b/);
    expect(log).toEqual(['run:disabled', 'stop:enabled', 'stop:disabled', 'run:enabled']);
  });
});

// ---- Sprint 6, D1-05 (S1-119): a Stop after the first token is a model.generate event ---------------------
// Written before the host emitted it; the red run is evidence/sprint-6/D1/red/D1-05.log. At 4f5b011 the
// grace-timeout path (the worker did not answer the abort within 250 ms, so it is terminated and the partial
// answer is returned) resolved finishReason 'abort' and emitted no model.generate at all.

import { eventsNamed } from './backends-helpers';
import { SilentWorker as Silent } from './worker-rig';

/** A worker that streams `tokens` tokens, one per 5 ms, and then ignores everything (a slow engine). */
function deafWorker(tokens: number) {
  return (u: string, n: string): Silent => {
    const w = new Silent(u, n);
    w.script = (m, self) => {
      if (m.type === 'init') {
        self.deliver({ v: 1, type: 'phase', phase: 'handoff', durationMs: 1, bytes: 10 });
        self.deliver({ v: 1, type: 'phase', phase: 'session', durationMs: 2 });
        self.deliver({ v: 1, type: 'ready' });
      } else if (m.type === 'generate') {
        const id = m['id'] as number;
        for (let i = 0; i < tokens; i++)
          setTimeout(() => self.deliver({ v: 1, type: 'token', id, text: `t${i} ` }), 5 * (i + 1));
        // no done and no answer to 'abort': the host's 250 ms backstop (here 40 ms) must act
      }
    };
    return w;
  };
}

describe('S1-119: Stop after the first token emits model.generate with finishReason abort', () => {
  it('the grace path returns the partial answer, emits exactly one model.generate (abort, outTokens, numeric firstTokenMs) and then model.unload reason abort', async () => {
    const r = await workerRig({ spawn: deafWorker(3), abortGraceMs: 40 });
    await r.load();
    const ctl = new AbortController();
    const seen: string[] = [];
    const p = r.adapter.generate('say something', {
      maxTokens: 64,
      signal: ctl.signal,
      onToken: (t) => seen.push(t),
    });
    await new Promise((res) => setTimeout(res, 60)); // all three tokens are delivered
    expect(seen).toHaveLength(3);
    ctl.abort();
    const res = await p;
    expect(res.finishReason).toBe('abort');
    expect(res.text).toBe('t0 t1 t2 ');
    const gen = eventsNamed(r.events, 'model.generate');
    expect(gen).toHaveLength(1);
    expect(gen[0]!.attrs['finishReason']).toBe('abort');
    expect(gen[0]!.attrs['outTokens']).toBe(3);
    expect(gen[0]!.attrs['host']).toBe('worker');
    expect(typeof gen[0]!.attrs['firstTokenMs']).toBe('number');
    expect(gen[0]!.attrs['firstTokenMs'] as number).toBeGreaterThanOrEqual(0);
    expect(typeof gen[0]!.durationMs).toBe('number');
    // no text in the event
    expect(JSON.stringify(gen[0])).not.toContain('t0 t1');
    // the worker was terminated (R8) and model.unload follows model.generate
    expect((r.workers[0] as Silent).terminated).toBe(true);
    const names = r.events.snapshot().map((e) => e.name);
    expect(names.indexOf('model.generate')).toBeLessThan(names.indexOf('model.unload'));
    expect(eventsNamed(r.events, 'model.unload').map((e) => e.attrs['reason'])).toEqual(['abort']);
  });

  it('a Stop before the first token still rejects aborted and emits no model.generate', async () => {
    const r = await workerRig({ spawn: deafWorker(0), abortGraceMs: 40 });
    await r.load();
    const ctl = new AbortController();
    const p = r.adapter.generate('say something', { maxTokens: 64, signal: ctl.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: 'aborted' });
    ctl.abort();
    await assertion;
    expect(eventsNamed(r.events, 'model.generate')).toHaveLength(0);
  });

  it('when the worker answers the abort in time (done with abort) there is still exactly one model.generate, and it is the worker result', async () => {
    const r = await workerRig({ spawn: (u, n) => streamingWorker(u, n) });
    await r.load();
    const ctl = new AbortController();
    const p = r.adapter.generate('say something long', { maxTokens: 512, signal: ctl.signal });
    await new Promise((res) => setTimeout(res, 80));
    ctl.abort();
    const res = await p;
    expect(res.finishReason).toBe('abort');
    const gen = eventsNamed(r.events, 'model.generate');
    expect(gen).toHaveLength(1);
    expect(gen[0]!.attrs['finishReason']).toBe('abort');
  });

  it('a normal completion is unchanged: one model.generate with finishReason stop or length', async () => {
    const r = await workerRig();
    await r.load();
    await r.adapter.generate('hi', { maxTokens: 8, temperature: 0 });
    const gen = eventsNamed(r.events, 'model.generate');
    expect(gen).toHaveLength(1);
    expect(['stop', 'length']).toContain(gen[0]!.attrs['finishReason']);
  });
});
