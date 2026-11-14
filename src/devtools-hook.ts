/**
 * The opt-in DevTools hook. `exposeDevtoolsHook(bus)` defines ONE global, `__airplanemodeDevtools`,
 * for the Airplane Mode DevTools panel (runtime/devtools) to read:
 *
 *   globalThis.__airplanemodeDevtools = { version: 1, snapshot(): string }
 *
 * The property is enumerable:false, writable:false, configurable:true; the object is frozen;
 * dispose() deletes it. Nothing in this library calls exposeDevtoolsHook(): a page opts in, and
 * without the call the global does not exist.
 *
 * snapshot() returns a freshly serialised JSON string (never a live object), airplanemode.devtools/0.1:
 *
 *   { spec, session, capturedAt (epoch ms), events, dropped }
 *
 * `events` holds at most `max` (default 1000) events of the bus, oldest first, of kind timing, memory
 * or model-load, or named backend.*, asset.verify.*, model.*, memory.* or storage.*. `dropped` counts
 * the matching events that were left out because of the cap or the 2 MiB size limit (the oldest go
 * first). The string is at most 2 MiB. Events carry the descriptor entry id (attr 'model') and the
 * storage namespace (attr 'ns'): applications must not encode personal data in either. The page's
 * prompts, outputs and documents are never in an event, so never in a snapshot.
 */

import type { Event } from '../spec/event';
import { sessionId } from './events';

export const DEVTOOLS_SNAPSHOT_SPEC = 'airplanemode.devtools/0.1' as const;
export const DEVTOOLS_DEFAULT_GLOBAL = '__airplanemodeDevtools';
export const DEVTOOLS_MAX_EVENTS = 1000;
export const DEVTOOLS_MAX_BYTES = 2 * 1024 * 1024;

/** The slice of EventBus the hook reads. */
export interface DevtoolsEventSource {
  snapshot(): Event[];
}

export interface DevtoolsHookOptions {
  /** Name of the global property. Default '__airplanemodeDevtools'. Must be a plain identifier. */
  globalName?: string;
  /** Most events one snapshot carries, 1..1000. Default 1000. */
  max?: number;
}

const KINDS: ReadonlySet<string> = new Set(['timing', 'memory', 'model-load']);
const NAME_PREFIXES = ['backend.', 'asset.verify.', 'model.', 'memory.', 'storage.'] as const;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function wanted(e: Event): boolean {
  return KINDS.has(e.kind) || NAME_PREFIXES.some((p) => e.name.startsWith(p));
}

/** Installs the hook and returns dispose(), which removes it again (only while it is still this hook). */
export function exposeDevtoolsHook(
  source: DevtoolsEventSource,
  options: DevtoolsHookOptions = {},
): () => void {
  const name = options.globalName ?? DEVTOOLS_DEFAULT_GLOBAL;
  if (typeof name !== 'string' || !IDENTIFIER.test(name))
    throw new TypeError('the DevTools hook global name must be a plain identifier');
  const max = Math.min(
    DEVTOOLS_MAX_EVENTS,
    Math.max(1, Number.isInteger(options.max) ? (options.max as number) : DEVTOOLS_MAX_EVENTS),
  );

  const snapshot = (): string => {
    const matching = source.snapshot().filter(wanted);
    let kept = matching.length > max ? matching.slice(matching.length - max) : matching;
    let dropped = matching.length - kept.length;
    const capturedAt = Date.now();
    const render = (events: Event[]): string =>
      JSON.stringify({
        spec: DEVTOOLS_SNAPSHOT_SPEC,
        session: sessionId(),
        capturedAt,
        events,
        dropped,
      });
    let text = render(kept);
    // over the size limit: drop the oldest events, in halves first, until it fits
    while (text.length > DEVTOOLS_MAX_BYTES && kept.length > 0) {
      const cut = Math.max(1, Math.floor(kept.length / 8));
      kept = kept.slice(cut);
      dropped += cut;
      text = render(kept);
    }
    return text;
  };

  const hook = Object.freeze({ version: 1 as const, snapshot });
  Object.defineProperty(globalThis, name, {
    value: hook,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (d && d.value === hook) delete (globalThis as Record<string, unknown>)[name];
  };
}
