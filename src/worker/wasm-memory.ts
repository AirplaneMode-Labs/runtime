/**
 * The wasm memory probe of the engine worker (Event 0.1.4, `model.memory`).
 *
 * What it measures: the peak of the summed `buffer.byteLength` of the real WebAssembly.Memory objects the
 * engine creates inside this worker, sampled on a timer (50 ms by default) while a phase runs, and once at
 * its start, at its end and whenever the caller ticks between engine steps. A synchronous stretch of
 * WebAssembly cannot be interrupted by a timer, so the figure is a lower bound of the true peak that is
 * never lower than any value it actually read. Nothing is estimated: when no Memory has been reached, or a
 * read throws, the answer is `{ measure: 'unavailable' }` with no byte figure.
 *
 * How the Memory object is reached: ONNX Runtime Web (an Emscripten build) either exports its heap from the
 * instantiated module or imports one it made with `new WebAssembly.Memory(...)` (threaded builds). The probe
 * wraps `WebAssembly.instantiate` (and keeps the exported Memory of the result and any Memory in the imports)
 * and the `WebAssembly.Memory` constructor of the namespace object it is given, so it must be installed
 * BEFORE the engine module is imported. It holds each Memory by WeakRef and never touches `.buffer` of
 * anything except to read its length.
 */

export interface WebAssemblyLike {
  Memory: new (descriptor: { initial: number; maximum?: number; shared?: boolean }) => {
    readonly buffer: { readonly byteLength: number };
  };
  instantiate: (...args: unknown[]) => Promise<unknown>;
}

export type PeakPhaseName = 'load' | 'generate' | 'embed';
export type PeakReading = { measure: 'wasm-memory'; bytes: number } | { measure: 'unavailable' };

export interface WasmMemoryProbe {
  /** Memories reached so far (live ones only count when read). */
  readonly memories: number;
  /** Samples taken so far (timer, ticks, starts and ends). */
  readonly samples: number;
  /** The sum of byteLength over the reachable memories now, or undefined when none can be read. */
  sample(): number | undefined;
  /** Takes a sample now and folds it into the running phase peak (call between engine steps). */
  tick(): void;
  /** Runs `fn`, sampling while it runs; returns its result and the high-water mark. */
  measure<T>(phase: PeakPhaseName, fn: () => Promise<T>): Promise<{ result: T; peak: PeakReading }>;
}

export interface WasmMemoryProbeOptions {
  intervalMs?: number;
}

type MemoryLike = { readonly buffer: { readonly byteLength: number } };

const probes = new WeakMap<object, WasmMemoryProbe>();

/** Installs the probe on `wa` (default: this scope's WebAssembly). Idempotent per namespace object. */
export function installWasmMemoryProbe(
  wa: WebAssemblyLike = (globalThis as { WebAssembly?: WebAssemblyLike }).WebAssembly!,
  options: WasmMemoryProbeOptions = {},
): WasmMemoryProbe {
  const existing = probes.get(wa);
  if (existing) return existing;
  const intervalMs = options.intervalMs ?? 50;
  // instanceof is judged against the ORIGINAL constructor: a memory a module exports is not an instance of
  // the subclass installed below
  const OriginalMemory = wa.Memory;
  const refs: WeakRef<MemoryLike>[] = [];
  const seen = new WeakSet<object>();
  let samples = 0;
  let running: { peak: number | undefined } | undefined;

  const remember = (m: unknown): void => {
    if (m === null || typeof m !== 'object' || seen.has(m)) return;
    if (!(m instanceof OriginalMemory)) return;
    seen.add(m);
    refs.push(new WeakRef(m as MemoryLike));
  };
  const scan = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || depth > 2) return;
    remember(v);
    for (const key of Object.keys(v)) {
      let child: unknown;
      try {
        child = (v as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      remember(child);
      if (depth < 2 && child !== null && typeof child === 'object') scan(child, depth + 1);
    }
  };

  const sample = (): number | undefined => {
    let total = 0;
    let any = false;
    for (const ref of refs) {
      const m = ref.deref();
      if (!m) continue;
      try {
        total += m.buffer.byteLength;
        any = true;
      } catch {
        return undefined; // a memory that cannot be read makes the whole figure unavailable
      }
    }
    return any ? total : undefined;
  };
  const fold = (): void => {
    samples++;
    const v = sample();
    if (running && v !== undefined && (running.peak === undefined || v > running.peak))
      running.peak = v;
  };

  // WebAssembly.instantiate(source, imports): the result is { instance, module } or an Instance
  const originalInstantiate = wa.instantiate.bind(wa);
  wa.instantiate = async (...args: unknown[]): Promise<unknown> => {
    scan(args[1], 0); // imports: an imported memory
    const result = await originalInstantiate(...args);
    const instance = (result as { instance?: { exports?: unknown } } | null)?.instance ?? result;
    scan((instance as { exports?: unknown } | null)?.exports, 0);
    return result;
  };
  // new WebAssembly.Memory(...): a memory the engine makes itself
  wa.Memory = class extends OriginalMemory {
    constructor(descriptor: { initial: number; maximum?: number; shared?: boolean }) {
      super(descriptor);
      remember(this);
    }
  } as typeof wa.Memory;

  const probe: WasmMemoryProbe = {
    get memories(): number {
      return refs.filter((r) => r.deref() !== undefined).length;
    },
    get samples(): number {
      return samples;
    },
    sample,
    tick: fold,
    async measure<T>(phase: PeakPhaseName, fn: () => Promise<T>) {
      void phase;
      const mine = { peak: undefined as number | undefined };
      const outer = running;
      running = mine;
      fold();
      const timer = setInterval(fold, intervalMs);
      let result: T;
      try {
        result = await fn();
      } finally {
        clearInterval(timer);
        fold();
        running = outer;
        // a nested measure's peak is also a peak of the outer one
        if (
          outer &&
          mine.peak !== undefined &&
          (outer.peak === undefined || mine.peak > outer.peak)
        )
          outer.peak = mine.peak;
      }
      // the probe's own high-water mark over the whole worker lifetime: a later phase never reports lower
      if (mine.peak !== undefined && (highWater === undefined || mine.peak > highWater))
        highWater = mine.peak;
      return {
        result,
        peak:
          highWater === undefined
            ? { measure: 'unavailable' }
            : { measure: 'wasm-memory', bytes: highWater },
      };
    },
  };
  let highWater: number | undefined;
  probes.set(wa, probe);
  return probe;
}
