// The Unload read-out of models.html (Sprint 6, B1). Two pure functions over the page's own event stream:
// how many engine workers are alive (backend.worker started minus terminated minus crashed) and the sentence
// the page prints after an unload. It shows the model.unload event the library emitted and the worker counts
// before and after. It shows NO operating-system memory figure: a web page cannot read one (the measured drop
// of the whole Chrome process tree is test/browser/model.spec.ts, run on a build, not in a visitor's tab).

import type { Event } from '../spec/event.ts';

/** Engine workers that have been started and not yet ended, from the host's own backend.worker events. */
export function liveWorkers(events: readonly Event[]): number {
  let live = 0;
  for (const e of events) {
    if (e.name !== 'backend.worker') continue;
    const state = e.attrs['state'];
    if (state === 'started') live++;
    else if (state === 'terminated' || state === 'crashed') live = Math.max(0, live - 1);
  }
  return live;
}

export function unloadLine(o: {
  before: number;
  after: number;
  event?: Event | undefined;
}): string {
  const counts = `Engine workers: ${o.before} before, ${o.after} after.`;
  const lower = counts.replace('Engine workers', 'engine workers');
  if (!o.event)
    return `Unloaded, but no model.unload event was recorded; ${lower} This page shows no operating-system memory figure.`;
  const reason = String(o.event.attrs['reason'] ?? '?');
  const ms = Math.round(o.event.durationMs ?? 0);
  return (
    `Unloaded: the library emitted model.unload (reason ${reason}) ${ms} ms after the call; ${lower} ` +
    "Ending the worker is what returns the model's WebAssembly memory to the browser. " +
    'This page shows no operating-system memory figure (a page cannot read one); ' +
    'the next load verifies every file again before the engine sees a byte.'
  );
}
