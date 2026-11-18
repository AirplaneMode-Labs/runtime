// Shared rig for the worker adapter tests: a loopback "worker" that drives the real TjsEngine in this
// process (messages cross a macrotask boundary like postMessage does), so the main-side adapter, the
// protocol and the engine host are exercised together without a browser.

import type { AssetSource } from '../spec/backend-adapter';
import { createTransformersAdapter } from '../src/backends/transformers';
import type { WorkerAdapterHandle } from '../src/backends/worker-adapter';
import { EventBus } from '../src/events';
import { EGRESS_GUARD_SENTINEL } from '../src/worker/egress-guard';
import { TjsEngine } from '../src/worker/tjs-engine';
import type { WasmMemoryProbe } from '../src/worker/wasm-memory';
import {
  ORT_FACTORY_URL,
  PAGE_ORIGIN,
  PREFIX,
  makeWorld,
  mockEngine,
  pinsFor,
  profileOf,
  type MockEngineOptions,
  type World,
  type WorldOptions,
} from './backends-helpers';

export const WORKER_URL = 'https://app.test/app/worker/engine-worker.js';

export interface FakeWorkerLike {
  /** Every message the page posted (the loopback and silent workers record them). */
  received?: { type?: string; [k: string]: unknown }[];
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
  postMessage(msg: unknown): void;
  terminate(): void;
}

export class LoopbackWorker implements FakeWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  readonly received: { type?: string }[] = [];
  engine: TjsEngine;

  constructor(
    readonly url: string,
    readonly name: string,
    engineOptions: MockEngineOptions,
    opts: { guard?: boolean; selfOrigin?: string; wasmPeakBytes?: number } = {},
  ) {
    const mock = mockEngine(engineOptions);
    this.mock = mock;
    const scope: Record<symbol, boolean> = {};
    if (opts.guard !== false) scope[EGRESS_GUARD_SENTINEL] = true;
    // a stub probe stands in for the engine's WebAssembly.Memory when a test wants a real figure
    const peak = opts.wasmPeakBytes;
    const wasmProbe: WasmMemoryProbe | undefined =
      peak === undefined
        ? undefined
        : {
            memories: 1,
            samples: 0,
            sample: () => peak,
            tick: () => undefined,
            measure: async (_phase, fn) => ({
              result: await fn(),
              peak: { measure: 'wasm-memory', bytes: peak },
            }),
          };
    this.engine = new TjsEngine({
      post: (m) => this.fromWorker(m),
      loadEngine: async () => mock.module as never,
      selfOrigin: opts.selfOrigin ?? PAGE_ORIGIN,
      scope,
      ...(wasmProbe ? { wasmProbe } : {}),
    });
  }
  readonly mock: ReturnType<typeof mockEngine>;

  /** What the worker posts to the page: delivered on a later macrotask, unless terminated. */
  fromWorker(m: unknown): void {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: m });
    }, 0);
  }

  postMessage(msg: unknown): void {
    this.received.push(msg as { type?: string });
    if (this.terminated) return;
    setTimeout(() => {
      if (!this.terminated) void this.engine.handle(msg);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
    // a terminated worker's memory is gone: its engine releases the registry keys it held
    void this.engine.unload();
  }
}

/** A worker that never answers anything: for crash, abort-backstop and hostile-message tests. */
export class SilentWorker implements FakeWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  readonly received: { type?: string; [k: string]: unknown }[] = [];
  /** Called with every message the page posts; the test decides what to answer. */
  script: ((msg: { type?: string; [k: string]: unknown }, w: SilentWorker) => void) | undefined;
  constructor(
    readonly url: string,
    readonly name: string,
  ) {}
  postMessage(msg: unknown): void {
    const m = msg as { type?: string };
    this.received.push(m);
    setTimeout(() => {
      if (!this.terminated) this.script?.(m, this);
    }, 0);
  }
  deliver(m: unknown): void {
    this.onmessage?.({ data: m });
  }
  terminate(): void {
    this.terminated = true;
  }
}

const rigs: WorkerAdapterHandle[] = [];

/** Unloads every adapter a test created, so the process-wide verified registry is empty for the next test. */
export async function unloadAllRigs(): Promise<void> {
  for (const a of rigs.splice(0)) await a.unload();
  for (const w of allWorkers.splice(0)) if (w instanceof LoopbackWorker) w.terminate();
}
const allWorkers: FakeWorkerLike[] = [];

export interface WorkerRig {
  w: World;
  events: EventBus;
  adapter: WorkerAdapterHandle;
  workers: FakeWorkerLike[];
  created: string[];
  revoked: string[];
  load: (over?: Record<string, unknown>) => Promise<void>;
}

export async function workerRig(
  o: {
    device?: 'wasm' | 'webgpu';
    world?: WorldOptions;
    engine?: MockEngineOptions;
    guard?: boolean;
    /** A stub wasm memory probe reading this many bytes (model.memory); absent: no probe, 'unavailable'. */
    wasmPeakBytes?: number;
    spawn?: (url: string, name: string) => FakeWorkerLike;
    workerUrl?: string;
    verifiedPrefix?: string;
    abortGraceMs?: number;
  } = {},
): Promise<WorkerRig> {
  const w = await makeWorld(o.world);
  const events = new EventBus();
  const workers: FakeWorkerLike[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const adapter = createTransformersAdapter({
    device: o.device ?? 'wasm',
    ortFactoryUrl: ORT_FACTORY_URL,
    verifiedPrefix: o.verifiedPrefix ?? `${PAGE_ORIGIN}${PREFIX}`,
    pins: pinsFor(),
    gpuProbe: async () => true,
    workerUrl: o.workerUrl ?? WORKER_URL,
    spawnWorker: (url, name) => {
      const worker =
        o.spawn?.(url, name) ??
        new LoopbackWorker(url, name, o.engine ?? {}, {
          ...(o.guard === false ? { guard: false } : {}),
          ...(o.wasmPeakBytes !== undefined ? { wasmPeakBytes: o.wasmPeakBytes } : {}),
        });
      workers.push(worker);
      allWorkers.push(worker);
      return worker;
    },
    urlApi: {
      createObjectURL: (b) => {
        const u = `blob:https://app.test/${created.length + 1}`;
        created.push(u);
        void b;
        return u;
      },
      revokeObjectURL: (u) => revoked.push(u),
    },
    ...(o.abortGraceMs !== undefined ? { abortGraceMs: o.abortGraceMs } : {}),
  }) as unknown as WorkerAdapterHandle;
  rigs.push(adapter);
  const profile = profileOf(o.device === 'webgpu' ? 'webgpu-f16' : 'wasm-simd');
  return {
    w,
    events,
    adapter,
    workers,
    created,
    revoked,
    load: (over = {}) =>
      adapter.load(w.descriptorEntry, { assets: w.mgr as AssetSource, profile, events, ...over }),
  };
}
