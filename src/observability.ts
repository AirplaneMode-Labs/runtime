/**
 * Observability for model loads (Event 0.1.2): a per-load id, the five model.load.phase timings and
 * the memory.sample reads. Used by the main-thread Transformers adapter (host 'main') and, with
 * payloads a worker measured and posted, by the worker host (host 'worker').
 *
 * Memory figures are READ from the browser and never estimated or computed: performance.memory is
 * Chrome's non-standard, coarse (quantised) and Chrome-only heap counter and is absent in workers, so
 * every figure is null where the browser does not expose it. wasmMemory is read only from a real
 * WebAssembly.Memory handed in by the caller. Nothing here derives one figure from another.
 *
 * No prompt, output, document text, key, value or engine message is ever an argument of anything in
 * this file: events carry enums, ids from the signed manifest, durations and byte counts.
 */

import {
  MODEL_LOAD_PHASES,
  type EventSink,
  type MemorySamplePoint,
  type ModelLoadPhase,
} from '../spec/event';
import { newEvent } from './events';

/** 16 lowercase hex characters from crypto.getRandomValues: random per load(), never user-derived. */
export function newLoadId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += (b < 16 ? '0' : '') + b.toString(16);
  return id;
}

const monotonic = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function emitSafely(sink: EventSink | undefined, build: () => ReturnType<typeof newEvent>): void {
  if (!sink) return;
  try {
    sink.emit(build());
  } catch {
    // telemetry must never change the outcome of a load or a generation
  }
}

// ---- phases ---------------------------------------------------------------------------------------

export type LoadHost = 'main' | 'worker';

export interface PhaseTimerOptions {
  sink?: EventSink | undefined;
  loadId: string;
  adapter: string;
  device: string;
  /** The descriptor entry id (appears in events: applications must not put personal data in entry ids). */
  model: string;
  host: LoadHost;
  /** Monotonic clock in milliseconds. Default performance.now(). */
  now?: (() => number) | undefined;
}

interface Pending {
  ms: number;
  bytes: number | undefined;
}

const PHASES: ReadonlySet<string> = new Set(MODEL_LOAD_PHASES);
/** Phases whose event carries top-level bytes. */
const BYTE_PHASES: ReadonlySet<string> = new Set(['acquire', 'verify', 'handoff']);

/**
 * Collects the time of each load phase and emits one model.load.phase per phase per load. Time can
 * be added in several pieces (the descriptor and each file are acquired one after the other) and is
 * emitted once, when the phase is complete. A phase that never completes is never emitted, so a
 * failed load shows exactly the phases that finished.
 */
export class PhaseTimer {
  private readonly o: PhaseTimerOptions;
  private readonly now: () => number;
  private readonly pending = new Map<ModelLoadPhase, Pending>();
  private readonly done: ModelLoadPhase[] = [];

  constructor(options: PhaseTimerOptions) {
    this.o = options;
    this.now = options.now ?? monotonic;
  }

  get loadId(): string {
    return this.o.loadId;
  }

  /** Adds measured milliseconds (and, for acquire, verify and handoff, bytes) to a phase not yet emitted. */
  add(phase: ModelLoadPhase, ms: number, bytes?: number): void {
    if (this.done.includes(phase) || !PHASES.has(phase)) return;
    const p = this.pending.get(phase) ?? { ms: 0, bytes: undefined };
    p.ms += Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 0)
      p.bytes = (p.bytes ?? 0) + bytes;
    this.pending.set(phase, p);
  }

  /** Runs `fn`, adds its wall time (also when it throws) and the bytes `bytesOf` reports for its result. */
  async measure<T>(
    phase: ModelLoadPhase,
    fn: () => Promise<T>,
    bytesOf?: (result: T) => number | undefined,
  ): Promise<T> {
    const t0 = this.now();
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      this.add(phase, this.now() - t0);
      throw e;
    }
    this.add(phase, this.now() - t0, bytesOf?.(result));
    return result;
  }

  /** Emits the phase once; false when it was emitted before (one event per phase per load). */
  emit(phase: ModelLoadPhase): boolean {
    if (this.done.includes(phase) || !PHASES.has(phase)) return false;
    const p = this.pending.get(phase) ?? { ms: 0, bytes: undefined };
    this.pending.delete(phase);
    this.done.push(phase);
    const o = this.o;
    emitSafely(o.sink, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.load.phase',
        level: 'info',
        durationMs: p.ms,
        ...(BYTE_PHASES.has(phase) ? { bytes: p.bytes ?? 0 } : {}),
        attrs: {
          loadId: o.loadId,
          adapter: o.adapter,
          device: o.device,
          model: o.model,
          phase,
          host: o.host,
        },
      }),
    );
    return true;
  }

  /** Emits a phase a worker measured: the duration and bytes are taken as given (already validated). */
  record(phase: ModelLoadPhase, ms: number, bytes?: number): boolean {
    if (this.done.includes(phase)) return false;
    this.add(phase, ms, bytes);
    return this.emit(phase);
  }

  /** The phases emitted so far, in order. */
  emitted(): ModelLoadPhase[] {
    return [...this.done];
  }

  has(phase: ModelLoadPhase): boolean {
    return this.done.includes(phase);
  }
}

// ---- memory ---------------------------------------------------------------------------------------

export type MemoryScope = 'page' | 'worker';
export type MemoryApi = 'performance.memory' | 'measureUserAgentSpecificMemory' | 'none';

export interface MemorySample {
  scope: MemoryScope;
  at: MemorySamplePoint;
  api: MemoryApi;
  usedJsHeap: number | null;
  totalJsHeap: number | null;
  jsHeapLimit: number | null;
  wasmMemory: number | null;
}

/** A browser figure, or null: only a non-negative safe integer is a figure; nothing is rounded or clamped. */
function figure(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Reads the memory counters the browser exposes right now. `performance.memory` (Chrome) supplies the
 * three JS heap figures; where it is absent the api is 'none' and every figure is null. `wasmMemory`
 * is the byte length of the buffer of a real WebAssembly.Memory the caller passes in, otherwise null.
 */
export function sampleMemory(
  scope: MemoryScope,
  at: MemorySamplePoint,
  wasmMemory?: unknown,
): MemorySample {
  const mem: unknown =
    typeof performance !== 'undefined' ? (performance as { memory?: unknown }).memory : undefined;
  const heap =
    mem !== null && typeof mem === 'object' ? (mem as Record<string, unknown>) : undefined;
  const wasm =
    typeof WebAssembly !== 'undefined' && wasmMemory instanceof WebAssembly.Memory
      ? figure(wasmMemory.buffer.byteLength)
      : null;
  return {
    scope,
    at,
    api: heap ? 'performance.memory' : 'none',
    usedJsHeap: heap ? figure(heap['usedJSHeapSize']) : null,
    totalJsHeap: heap ? figure(heap['totalJSHeapSize']) : null,
    jsHeapLimit: heap ? figure(heap['jsHeapSizeLimit']) : null,
    wasmMemory: wasm,
  };
}

/** Emits memory.sample for `loadId` ('' when the sample belongs to no load). Never throws. */
export function emitMemorySample(
  sink: EventSink | undefined,
  loadId: string,
  scope: MemoryScope,
  at: MemorySamplePoint,
  wasmMemory?: unknown,
): void {
  emitSafely(sink, () => {
    const s = sampleMemory(scope, at, wasmMemory);
    return newEvent({
      source: 'runtime',
      kind: 'memory',
      name: 'memory.sample',
      level: 'info',
      ...(s.usedJsHeap !== null ? { bytes: s.usedJsHeap } : {}),
      attrs: {
        loadId,
        scope: s.scope,
        at: s.at,
        api: s.api,
        usedJsHeap: s.usedJsHeap,
        totalJsHeap: s.totalJsHeap,
        jsHeapLimit: s.jsHeapLimit,
        wasmMemory: s.wasmMemory,
      },
    });
  });
}

/** Counts the bytes downloaded while a load runs, from the asset source's own events when it has them. */
export interface DownloadMeter {
  /** Bytes fetched since the meter was created. */
  bytes(): number;
  /** Feeds a progress report; used only when the asset source has no observable event bus. */
  progress(p: { entryId: string; received: number; total: number }): void;
  stop(): void;
}

/**
 * Bytes downloaded by this load: the sum of `total - resumedFrom` of every asset.download.complete the
 * asset source's bus reports while the meter runs (a resumed download counts only the bytes after the
 * resume point; a file served from the store reports nothing). A source without an observable bus
 * falls back to the largest `received` it reported per entry, which counts a resumed prefix too.
 */
export function meterDownloads(assets: unknown): DownloadMeter {
  let total = 0;
  const received = new Map<string, number>();
  let observed = false;
  let unsubscribe: (() => void) | undefined;
  const bus = (assets as { events?: { subscribe?: (l: (e: unknown) => void) => () => void } })
    .events;
  if (bus && typeof bus.subscribe === 'function') {
    try {
      unsubscribe = bus.subscribe((e) => {
        const ev = e as { name?: unknown; attrs?: Record<string, unknown> };
        if (ev.name !== 'asset.download.complete') return;
        const t = ev.attrs?.['total'];
        const from = ev.attrs?.['resumedFrom'];
        if (typeof t === 'number' && Number.isSafeInteger(t) && t >= 0) {
          const skipped =
            typeof from === 'number' && Number.isSafeInteger(from) && from >= 0 ? from : 0;
          total += t > skipped ? t - skipped : 0;
        }
      });
      observed = true;
    } catch {
      observed = false;
    }
  }
  return {
    bytes: () => {
      if (observed) return total;
      let n = 0;
      for (const v of received.values()) n += v;
      return n;
    },
    progress: (p) => {
      if (observed || !Number.isSafeInteger(p.received) || p.received < 0) return;
      received.set(p.entryId, Math.max(received.get(p.entryId) ?? 0, p.received));
    },
    stop: () => {
      try {
        unsubscribe?.();
      } catch {
        // best effort
      }
      unsubscribe = undefined;
    },
  };
}
