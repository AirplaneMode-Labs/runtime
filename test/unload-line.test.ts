// Sprint 6, D1-10: the Unload button of models.html shows the model.unload event and the engine worker count
// before and after, and NO operating-system memory figure (a page cannot read one; the measured drop is the
// browser test with the process tree). The two pure functions live in demo/unload-line.ts. Written before the
// module existed; the red run is evidence/sprint-6/D1/red/D1-10.log.

import { describe, expect, it } from 'vitest';
import type { Event } from '../spec/event';
import { newEvent } from '../src/events';
import { liveWorkers, unloadLine } from '../demo/unload-line';

const worker = (state: string, reason = 'load'): Event =>
  newEvent({
    source: 'runtime',
    kind: 'log',
    name: 'backend.worker',
    level: 'info',
    attrs: { adapter: 'transformers-js', device: 'wasm', state, reason },
  });
const unload = (reason: string, durationMs: number): Event =>
  newEvent({
    source: 'runtime',
    kind: 'model-load',
    name: 'model.unload',
    level: 'info',
    durationMs,
    attrs: {
      adapter: 'transformers-js',
      model: 'm.descriptor',
      device: 'wasm',
      host: 'worker',
      loadId: 'abcdef0123456789',
      reason,
    },
  });

describe("liveWorkers: started minus terminated minus crashed, from the host's own backend.worker events", () => {
  it('counts one engine worker between started and terminated', () => {
    expect(liveWorkers([])).toBe(0);
    expect(liveWorkers([worker('started')])).toBe(1);
    expect(liveWorkers([worker('started'), worker('ready')])).toBe(1);
    expect(liveWorkers([worker('started'), worker('ready'), worker('terminated', 'unload')])).toBe(
      0,
    );
  });

  it('a crash ends a worker too, and a second load that replaced the first leaves one', () => {
    expect(liveWorkers([worker('started'), worker('crashed', 'error')])).toBe(0);
    expect(
      liveWorkers([
        worker('started'),
        worker('terminated', 'unload'),
        worker('started'),
        worker('ready'),
      ]),
    ).toBe(1);
  });

  it('never goes below zero and ignores other events', () => {
    expect(liveWorkers([worker('terminated', 'unload')])).toBe(0);
    expect(liveWorkers([unload('unload', 3)])).toBe(0);
  });
});

describe('unloadLine', () => {
  it('names the event, the reason, the time and the worker counts before and after', () => {
    const text = unloadLine({ before: 1, after: 0, event: unload('unload', 3.4) });
    expect(text).toContain('model.unload');
    expect(text).toContain('reason unload');
    expect(text).toContain('3 ms');
    expect(text).toContain('engine workers: 1 before, 0 after');
  });

  it('shows no operating-system memory figure and never says free RAM', () => {
    const text = unloadLine({ before: 1, after: 0, event: unload('unload', 3.4) });
    expect(text).not.toMatch(/\b\d[\d,.]*\s?(B|KiB|MiB|GiB|KB|MB|GB)\b/);
    expect(text).not.toMatch(/free RAM/i);
    expect(text).toMatch(/no operating-system memory figure/);
  });

  it('says plainly when no model.unload event was seen', () => {
    const text = unloadLine({ before: 0, after: 0 });
    expect(text).toContain('no model.unload event');
  });

  it('puts the cost of unloading in plain words: the next load verifies everything again', () => {
    expect(unloadLine({ before: 1, after: 0, event: unload('unload', 2) })).toContain(
      'the next load verifies every file again',
    );
  });
});
