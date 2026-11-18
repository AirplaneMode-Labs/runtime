/**
 * The Transformers.js adapter with the engine in a dedicated worker (backend adapter 0.4.0: host
 * 'worker', rules R2w, R3w, R7 to R13 and R15).
 *
 * On the page (this file) R1 and R2 run as on the main thread, except the load-time re-hash: every file is
 * acquired and the SAME Blob objects are posted to the worker together with their manifest entries. In the
 * worker (R15, spec/backend-adapter.md) the size is checked first, SHA-256 then runs over every
 * engine-readable file, and the engine is served exactly the hashed bytes, by method (ii) chosen in R15 (the
 * very File snapshot that was hashed). The main thread does not re-hash at load time; the asset manager's
 * download-time verification stays. The worker never opens storage and never fetches; its network function
 * is the verified-file shim behind the egress guard (src/worker/).
 *
 * Isolation (R7): every load() starts a fresh module worker named
 * 'airplanemode-engine-<adapter>-<device>' from a blob: bootstrap, and unload(), an abort that is not
 * answered within 250 ms, a crash and a failed load all terminate it and release the asset holds, the
 * bootstrap URL and the registry keys. A WebGPU failure after session creation therefore cannot poison
 * the WebAssembly rung: it starts its own worker.
 *
 * Untrusted messages (R13): everything the worker posts goes through createWorkerMessageValidator; an
 * unknown type, a bad shape or a repeated phase is a crash (the worker is terminated and the pending
 * calls reject 'backend'). Only token text and the result text reach the application; no worker
 * string reaches an event, a message or the DOM. The page builds every event itself (R12).
 */

import {
  AdapterError,
  type AdapterCapabilities,
  type AssetHandle,
  type AssetSource,
  type BackendAdapter,
  type ChatMessage,
  type EmbedOptions,
  type EmbedResult,
  type ExecutionDevice,
  type GenerateOptions,
  type GenerateResult,
  type LoadOptions,
} from '../../spec/backend-adapter';
import {
  BACKEND_TIER_RANK,
  type BackendTier,
  type CapabilityProfile,
} from '../../spec/capability-profile';
import type { EventSink } from '../../spec/event';
import type { ManifestEntry } from '../../spec/manifest';
import type { ModelDescriptor } from '../../spec/model-descriptor';
import { AssetError } from '../errors';
import { newEvent } from '../events';
import {
  PhaseTimer,
  emitMemorySample,
  meterDownloads,
  newLoadId,
  type DownloadMeter,
} from '../observability';
import {
  MAX_PHASE_MS,
  createWorkerMessageValidator,
  type InitMessage,
  type WorkerGenerateResult,
  type WorkerMessage,
} from '../worker/protocol';
import { loadDescriptor } from './descriptor';
import { forEntry } from './entry-error';
import { ORT_PINS } from './ort-pins';
import {
  probeWebGpuDevice,
  usableModelId,
  checkEmbedTexts,
  checkMaxTokens,
  resolveEmbedOptions,
  checkSessionOptions,
  now,
  type OrtPin,
  type SessionOptions,
} from './tjs-core';
import { defaultVerifiedPrefix, egressOrigin } from './verified-files';
import {
  createBootstrapUrl,
  getWorkerUrlPolicy,
  resolveWorkerUrl,
  type Bootstrap,
  type TrustedTypesLike,
} from './worker-bootstrap';

const ADAPTER_ID = 'transformers-js';
const VERIFIED_SUFFIX = '__airplanemode/verified/';
/**
 * The phases the worker reports itself; acquire is timed on the page. 'verify' is the worker's since backend
 * adapter 0.4.0 (R15): the worker hashes every file, and the page no longer re-hashes on the load path.
 */
const WORKER_PHASES: ReadonlySet<string> = new Set(['verify', 'handoff', 'session', 'first_token']);

/** The slice of Worker this adapter uses. */
export interface WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WorkerAdapterOptions {
  device: 'webgpu' | 'wasm';
  ortFactoryUrl: string;
  /** URL of the engine worker script (dist/worker/engine-worker.js, or the bundler's output for it). */
  workerUrl: string;
  /** Absolute verified prefix on the page origin ending in '__airplanemode/verified/'. Default: derived from the page URL. */
  verifiedPrefix?: string;
  pins?: Readonly<Record<'wasm' | 'webgpu', OrtPin>>;
  /** Deprecated; see TransformersAdapterOptions.sessionOptions. */
  sessionOptions?: SessionOptions;
  gpuProbe?: () => Promise<boolean>;
  /** Starts the worker. Default: new Worker(url, { type: 'module', name }). Tests inject a fake. */
  spawnWorker?: (url: string, name: string) => WorkerLike;
  /** URL.createObjectURL and revokeObjectURL. Default: the global URL. */
  urlApi?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  /** How long an abort may wait for the worker's own answer before the worker is terminated. Default 250 ms. */
  abortGraceMs?: number;
  /** Base for a relative workerUrl. Default: document.baseURI, else the page URL. */
  baseURI?: string;
  trustedTypes?: TrustedTypesLike | undefined;
}

interface Pending {
  kind: 'generate';
  resolve(r: GenerateResult): void;
  reject(e: Error): void;
  onToken: ((t: string) => void) | undefined;
  text: string;
  startedAt: number;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** A call to embed() waiting for the worker: what the host checks the answer against (R14). */
interface PendingEmbed {
  kind: 'embed';
  resolve(r: EmbedResult): void;
  reject(e: Error): void;
  startedAt: number;
  count: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface Session {
  loadId: string;
  worker: WorkerLike;
  bootstrap: Bootstrap;
  held: AssetHandle[];
  timer: PhaseTimer;
  events: EventSink | undefined;
  descriptor: ModelDescriptor;
  entryId: string;
  validate: ReturnType<typeof createWorkerMessageValidator>;
  pending: Map<number, Pending | PendingEmbed>;
  nextId: number;
  spawnedAt: number;
  ready: { resolve(): void; reject(e: Error): void } | undefined;
  closed: boolean;
  /** Worker-reported egress refusals recorded for this loadId (S1-074); at most MAX_WORKER_EGRESS_EVENTS. */
  egressReports: number;
}

/** Worker-reported backend.egress.refused events recorded per loadId; later reports are dropped. */
const MAX_WORKER_EGRESS_EVENTS = 16;

function safeEmit(sink: EventSink | undefined, build: () => ReturnType<typeof newEvent>): void {
  if (!sink) return;
  try {
    sink.emit(build());
  } catch {
    // telemetry must never change the outcome of a load or a generation
  }
}

function isAbortLike(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === 'object' &&
    ((e as { name?: unknown }).name === 'AbortError' ||
      (e instanceof AssetError && e.code === 'aborted'))
  );
}

function mapError(e: unknown, message: string): Error {
  if (e instanceof AdapterError) return e;
  if (isAbortLike(e)) return new AdapterError('aborted', 'the operation was aborted', { cause: e });
  if (e instanceof AssetError) return e;
  return new AdapterError('backend', message, { cause: e });
}

const codeOf = (e: Error): string => (e instanceof AdapterError ? e.code : 'backend');

export class WorkerTransformersAdapter implements BackendAdapter {
  readonly id = ADAPTER_ID;
  readonly tier: BackendTier;
  readonly device: 'webgpu' | 'wasm';
  readonly host = 'worker' as const;
  private readonly o: WorkerAdapterOptions;
  private readonly pins: Readonly<Record<'wasm' | 'webgpu', OrtPin>>;
  private readonly sessionOptions: SessionOptions | undefined;
  private readonly gpuProbe: () => Promise<boolean>;
  private session: Session | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerAdapterOptions) {
    this.o = options;
    this.device = options.device;
    this.tier = options.device === 'webgpu' ? 'webgpu-f32' : 'wasm';
    this.pins = options.pins ?? ORT_PINS;
    this.sessionOptions =
      options.sessionOptions !== undefined
        ? checkSessionOptions(options.sessionOptions)
        : undefined;
    this.gpuProbe = options.gpuProbe ?? (() => probeWebGpuDevice());
  }

  capabilities(): AdapterCapabilities {
    const task = this.session?.descriptor.task;
    return {
      generate: task === undefined ? true : task === 'text-generation',
      embed: task === 'feature-extraction',
      streaming: true,
    };
  }

  diagnostics(): { device: ExecutionDevice; executionProviders: string[]; dtype: string } {
    return {
      device: this.device,
      executionProviders: [this.device === 'webgpu' ? 'webgpu' : 'wasm'],
      dtype: this.session?.descriptor.dtype ?? '',
    };
  }

  /** A worker per load never shares an engine module, so no engine of this adapter is ever blocked (T1-S2-01). */
  engineBlocked(): boolean {
    return false;
  }

  async available(profile: CapabilityProfile): Promise<boolean> {
    if (!this.profileAllows(profile)) return false;
    return this.device === 'webgpu' ? this.gpuProbe() : true;
  }

  private profileAllows(profile: CapabilityProfile): boolean {
    const rank = BACKEND_TIER_RANK[profile.backendTier];
    if (this.device === 'webgpu')
      return profile.gpu === 'webgpu' && rank >= BACKEND_TIER_RANK['webgpu-f32'];
    return rank >= BACKEND_TIER_RANK['wasm'];
  }

  load(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    const run = this.chain.then(
      () => this.loadLocked(entry, opts),
      () => this.loadLocked(entry, opts),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- page-side checks ---------------------------------------------------------------------------

  private pageLocation(): { href: string; origin: string } {
    const loc = (globalThis as { location?: { href: string; origin: string } }).location;
    if (!loc) throw new AdapterError('backend', 'no page location is available');
    return loc;
  }

  private resolveVerifiedPrefix(): string {
    const loc = this.pageLocation();
    const raw = this.o.verifiedPrefix ?? new URL(defaultVerifiedPrefix(), loc.href).href;
    let url: URL;
    try {
      url = new URL(raw, loc.href);
    } catch {
      throw new AdapterError('bad_descriptor', 'the verified prefix is not a URL');
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== loc.origin)
      throw new AdapterError('egress_refused', 'the verified prefix is not on the page origin');
    if (url.search !== '' || url.hash !== '' || !url.pathname.endsWith(`/${VERIFIED_SUFFIX}`))
      throw new AdapterError(
        'bad_descriptor',
        'the verified prefix must end in __airplanemode/verified/',
      );
    return url.href;
  }

  private resolveFactoryUrl(events: EventSink | undefined): string {
    const loc = this.pageLocation();
    let url: URL | undefined;
    try {
      url = new URL(this.o.ortFactoryUrl, loc.href);
    } catch {
      url = undefined;
    }
    const same =
      url !== undefined &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === loc.origin &&
      !/[?#]/.test(url.href);
    if (!same) {
      const origin = egressOrigin(url);
      safeEmit(events, () =>
        newEvent({
          source: 'runtime',
          kind: 'error',
          name: 'backend.egress.refused',
          level: 'error',
          attrs: { adapter: this.id, reporter: 'main', origin },
        }),
      );
      throw new AdapterError(
        'egress_refused',
        'the ONNX runtime factory is not served from the page origin',
      );
    }
    return url!.href;
  }

  // ---- load ---------------------------------------------------------------------------------------

  private async loadLocked(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    const t0 = now();
    await this.closeSession('unload');
    const held: AssetHandle[] = [];
    const loadId = newLoadId();
    const timer = new PhaseTimer({
      sink: opts.events,
      loadId,
      adapter: this.id,
      device: this.device,
      model: entry.id,
      host: 'worker',
    });
    const meter: DownloadMeter = meterDownloads(opts.assets);
    const onProgress: NonNullable<LoadOptions['onProgress']> = (p) => {
      meter.progress(p);
      opts.onProgress?.(p);
    };
    emitMemorySample(opts.events, loadId, 'page', 'before_load');
    let session: Session | undefined;
    let bootstrap: Bootstrap | undefined;
    const aborted = () => {
      if (opts.signal?.aborted) throw new AdapterError('aborted', 'the load was aborted');
    };
    try {
      aborted();
      // refused before anything is downloaded or created: the worker script, the prefix, the factory
      const loc = this.pageLocation();
      const baseURI =
        this.o.baseURI ??
        (globalThis as { document?: { baseURI?: string } }).document?.baseURI ??
        loc.href;
      const workerAbs = resolveWorkerUrl(this.o.workerUrl, baseURI, loc.origin);
      const verifiedPrefix = this.resolveVerifiedPrefix();
      const ortFactoryUrl = this.resolveFactoryUrl(opts.events);
      if (!this.profileAllows(opts.profile))
        throw new AdapterError(
          'unsupported_profile',
          'this device cannot run the adapter on this execution device',
        );
      if (!usableModelId(entry.id))
        throw new AdapterError(
          'bad_descriptor',
          'the descriptor entry id cannot be used as an engine model id',
        );

      // R1
      const loaded = await loadDescriptor(entry, {
        assets: opts.assets,
        profile: opts.profile,
        adapterId: this.id,
        device: this.device,
        held,
        signal: opts.signal,
        onProgress,
        cacheOnly: opts.cacheOnly,
        timer,
        hashOnPage: true,
      });
      aborted();
      const d = loaded.descriptor;
      const wasmFile = loaded.files.find((f) => f.path === d.runtimeWasm);
      const pin = this.pins[this.device === 'webgpu' ? 'webgpu' : 'wasm'];
      if (!wasmFile || wasmFile.entry.sha256 !== pin.wasmSha256)
        throw new AdapterError(
          'bad_descriptor',
          'runtimeWasm is not the pinned ONNX runtime binary for this device',
        );

      // R2 on the page: acquire every file (download-time verification); the worker re-hashes (R15)
      const acquireOpts: Parameters<NonNullable<AssetSource['acquire']>>[1] = { onProgress };
      if (opts.signal) acquireOpts.signal = opts.signal;
      if (opts.cacheOnly === true) acquireOpts.cacheOnly = true;
      for (const f of loaded.files) {
        held.push(
          await timer.measure('acquire', () =>
            forEntry(f.entry.id, () => opts.assets.acquire!(f.entry.id, acquireOpts)),
          ),
        );
        aborted();
      }
      timer.add('acquire', 0, meter.bytes());
      timer.emit('acquire');
      // R15 (backend adapter 0.4.0, S1-070): the page does NOT re-hash. It posts the stored files with the
      // sha256 and size of their manifest entries; the worker hashes every one before the engine sees a byte
      // and emits the verify phase. The asset manager's download-time verification is unchanged.
      const files: InitMessage['files'] = [];
      let bytes = entry.size;
      for (const f of loaded.files) {
        const blob = await forEntry(f.entry.id, () => opts.assets.getBlob(f.entry.id));
        bytes += f.entry.size;
        files.push({
          path: f.path,
          entryId: f.entry.id,
          sha256: f.entry.sha256,
          size: f.entry.size,
          blob,
        });
      }
      aborted();

      // R7: a fresh module worker from a blob bootstrap
      const name = `airplanemode-engine-${this.id}-${this.device}`;
      bootstrap = createBootstrapUrl(workerAbs, {
        policy: getWorkerUrlPolicy({
          trustedTypes:
            'trustedTypes' in this.o
              ? this.o.trustedTypes
              : (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes,
        }),
        createObjectURL: (b) => (this.o.urlApi ?? URL).createObjectURL(b),
        revokeObjectURL: (u) => (this.o.urlApi ?? URL).revokeObjectURL(u),
      });
      const spawn =
        this.o.spawnWorker ??
        ((url: string, n: string): WorkerLike =>
          new Worker(url, { type: 'module', name: n }) as unknown as WorkerLike);
      const worker = spawn(bootstrap.trusted, name);
      session = {
        loadId,
        worker,
        bootstrap,
        held,
        timer,
        events: opts.events,
        descriptor: d,
        entryId: entry.id,
        validate: createWorkerMessageValidator(),
        pending: new Map(),
        nextId: 0,
        spawnedAt: now(),
        egressReports: 0,
        ready: undefined,
        closed: false,
      };
      this.session = session;
      this.workerEvent(session, 'started', 'load', undefined);
      const ready = new Promise<void>((resolve, reject) => {
        session!.ready = { resolve, reject };
      });
      this.attach(session);
      const onAbort = () =>
        session?.ready?.reject(new AdapterError('aborted', 'the load was aborted'));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const init: InitMessage = {
        v: 1,
        type: 'init',
        adapter: this.id,
        device: this.device,
        loadId,
        verifiedPrefix,
        ortFactoryUrl,
        descriptorEntryId: entry.id,
        descriptor: d,
        files,
        runtimeWasm: d.runtimeWasm!,
        ...(this.sessionOptions && Object.keys(this.sessionOptions).length > 0
          ? { sessionOptions: { ...this.sessionOptions } }
          : {}),
      };
      try {
        worker.postMessage(init);
        await ready;
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
      }
      aborted();
      session.ready = undefined;
      this.workerEvent(session, 'ready', 'load', now() - session.spawnedAt);
      emitMemorySample(opts.events, loadId, 'page', 'after_session');
      safeEmit(opts.events, () =>
        newEvent({
          source: 'runtime',
          kind: 'model-load',
          name: 'model.load',
          level: 'info',
          bytes,
          durationMs: Math.max(0, now() - t0),
          attrs: {
            adapter: this.id,
            model: entry.id,
            device: this.device,
            dtype: d.dtype,
            files: d.files.length,
            tier: this.tier,
            verified: true,
            loadId,
            host: 'worker',
          },
        }),
      );
    } catch (e) {
      const err = mapError(e, 'the inference engine failed to load the model');
      const reason =
        err instanceof AdapterError && err.code === 'aborted' ? 'abort' : 'load_failed';
      if (session && !session.closed) await this.terminate(session, reason);
      else {
        bootstrap?.revoke();
        for (const h of held) h.release();
      }
      if (this.session === session) this.session = undefined;
      safeEmit(opts.events, () =>
        newEvent({
          source: 'runtime',
          kind: 'model-load',
          name: 'model.load.failed',
          level: 'error',
          attrs: {
            adapter: this.id,
            model: entry.id,
            device: this.device,
            code: codeOf(err),
            loadId,
            host: 'worker',
          },
        }),
      );
      throw err;
    } finally {
      meter.stop();
    }
  }

  // ---- messages -----------------------------------------------------------------------------------

  private workerEvent(
    s: Session,
    state: 'started' | 'ready' | 'terminated' | 'crashed',
    reason: 'load' | 'unload' | 'load_failed' | 'abort' | 'error',
    durationMs: number | undefined,
  ): void {
    safeEmit(s.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'log',
        name: 'backend.worker',
        level: state === 'crashed' ? 'warn' : 'info',
        ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
        attrs: { adapter: this.id, device: this.device, state, reason },
      }),
    );
  }

  private attach(s: Session): void {
    s.worker.onmessage = (ev) => this.onMessage(s, ev?.data);
    s.worker.onerror = () => void this.crash(s);
    s.worker.onmessageerror = () => void this.crash(s);
  }

  private onMessage(s: Session, raw: unknown): void {
    if (s.closed) return;
    const v = s.validate(raw);
    if (!v.ok) {
      void this.crash(s);
      return;
    }
    const m: WorkerMessage = v.message;
    switch (m.type) {
      case 'phase':
        if (!WORKER_PHASES.has(m.phase)) {
          void this.crash(s);
          return;
        }
        if (s.timer.record(m.phase, m.durationMs, m.bytes) && m.phase === 'first_token')
          emitMemorySample(s.events, s.loadId, 'page', 'after_first_token');
        return;
      case 'memory':
        safeEmit(s.events, () =>
          newEvent({
            source: 'runtime',
            kind: 'memory',
            name: 'memory.sample',
            level: 'info',
            ...(m.usedJsHeap !== null ? { bytes: m.usedJsHeap } : {}),
            attrs: {
              loadId: s.loadId,
              scope: 'worker',
              at: m.at,
              api: m.api,
              usedJsHeap: m.usedJsHeap,
              totalJsHeap: m.totalJsHeap,
              jsHeapLimit: m.jsHeapLimit,
              wasmMemory: m.wasmMemory,
            },
          }),
        );
        return;
      case 'ready':
        s.ready?.resolve();
        return;
      case 'token': {
        const p = s.pending.get(m.id);
        if (!p || p.kind !== 'generate') return;
        p.text += m.text;
        try {
          p.onToken?.(m.text);
        } catch {
          // a token listener must not break generation
        }
        return;
      }
      case 'done': {
        const p = s.pending.get(m.id);
        if (!p || p.kind !== 'generate') return;
        this.finish(s, m.id, p);
        this.emitGenerate(s, m.result, now() - p.startedAt);
        p.resolve({
          text: m.result.text,
          finishReason: m.result.finishReason,
          usage: m.result.usage,
          timings: m.result.timings,
          ...(m.result.budget !== undefined ? { budget: m.result.budget } : {}),
        });
        return;
      }
      case 'embedded': {
        const p = s.pending.get(m.id);
        if (!p || p.kind !== 'embed') return;
        this.finish(s, m.id, p);
        // R14: the worker's answer is untrusted. Count, type, length and finiteness are checked here; a lie
        // rejects 'backend' for this call (the worker is not otherwise trusted more or less afterwards).
        const bad = (): boolean => {
          if (m.vectors.length !== p.count) return true;
          for (const v of m.vectors) {
            if (!(v instanceof Float32Array) || v.length !== m.dims) return true;
            for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return true;
          }
          return false;
        };
        if (bad()) {
          this.emitEmbed(s, p, 'backend', { dims: m.dims, truncated: 0 });
          p.reject(
            new AdapterError('backend', 'the inference engine returned an unusable embedding'),
          );
          return;
        }
        // Copy into fresh, non-shared, plain Float32Arrays and re-check finiteness on the copy, so nothing the
        // worker still holds (shared memory, a view of a bigger buffer, a subclass) can change after validation.
        const copies: Float32Array[] = [];
        for (const v of m.vectors as Float32Array[]) {
          const c = new Float32Array(v.length);
          c.set(v);
          for (let i = 0; i < c.length; i++) {
            if (!Number.isFinite(c[i])) {
              this.emitEmbed(s, p, 'backend', { dims: m.dims, truncated: 0 });
              p.reject(
                new AdapterError('backend', 'the inference engine returned an unusable embedding'),
              );
              return;
            }
          }
          copies.push(c);
        }
        this.emitEmbed(s, p, 'ok', { dims: m.dims, truncated: m.truncated });
        p.resolve({
          vectors: copies,
          dims: m.dims,
          normalized: m.normalized,
          truncated: m.truncated > 0,
          timings: { totalMs: m.totalMs },
        });
        return;
      }
      case 'peak':
        safeEmit(s.events, () =>
          newEvent({
            source: 'runtime',
            kind: 'memory',
            name: 'model.memory',
            level: 'info',
            ...(m.measure === 'wasm-memory' && m.bytes !== undefined ? { bytes: m.bytes } : {}),
            attrs: {
              adapter: this.id,
              host: 'worker',
              loadId: s.loadId,
              phase: m.phase,
              measure: m.measure,
            },
          }),
        );
        return;
      case 'error': {
        const err = new AdapterError(m.code, 'the inference engine reported an error');
        if (s.ready) {
          s.ready.reject(err);
          return;
        }
        for (const [id, p] of [...s.pending]) {
          this.finish(s, id, p);
          if (p.kind === 'embed') this.emitEmbed(s, p, m.code, { dims: 0, truncated: 0 });
          p.reject(err);
        }
        return;
      }
      case 'egress': {
        // S1-074: the worker's text is discarded. The event carries the host's own adapter id, the
        // fixed origin 'worker-reported' and the 1-based count of this report within the load.
        if (s.egressReports >= MAX_WORKER_EGRESS_EVENTS) return;
        const count = ++s.egressReports;
        safeEmit(s.events, () =>
          newEvent({
            source: 'runtime',
            kind: 'error',
            name: 'backend.egress.refused',
            level: 'error',
            attrs: { adapter: this.id, reporter: 'worker', origin: 'worker-reported', count },
          }),
        );
        return;
      }
    }
  }

  private finish(s: Session, id: number, p: Pending | PendingEmbed): void {
    s.pending.delete(id);
    if (p.kind === 'generate' && p.graceTimer !== undefined) clearTimeout(p.graceTimer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
  }

  /** model.embed (Event 0.1.4): counts, the dims and the outcome; never an input text or a vector. */
  private emitEmbed(
    s: Session,
    p: PendingEmbed,
    outcome: string,
    r: { dims: number; truncated: number },
  ): void {
    safeEmit(s.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.embed',
        level: outcome === 'ok' ? 'info' : 'warn',
        durationMs: Math.max(0, Math.min(now() - p.startedAt, MAX_PHASE_MS)),
        attrs: {
          adapter: this.id,
          model: s.entryId,
          device: this.device,
          host: 'worker',
          loadId: s.loadId,
          inputs: p.count,
          truncated: r.truncated,
          dims: r.dims,
          outcome,
        },
      }),
    );
  }

  private emitGenerate(s: Session, r: WorkerGenerateResult, wallMs: number): void {
    safeEmit(s.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.generate',
        level: 'info',
        durationMs: Math.max(0, Math.min(wallMs, MAX_PHASE_MS)),
        attrs: {
          adapter: this.id,
          device: this.device,
          finishReason: r.finishReason,
          inTokens: r.usage.promptTokens ?? 0,
          outTokens: r.usage.completionTokens ?? 0,
          tokensPerSecond: r.timings.tokensPerSecond ?? 0,
          prefillMs: r.timings.prefillMs ?? 0,
          decodeMs: r.timings.decodeMs ?? 0,
          firstTokenMs: r.timings.firstTokenMs ?? null,
          host: 'worker',
          ...(r.budget !== undefined ? { budget: r.budget } : {}),
        },
      }),
    );
  }

  // ---- termination --------------------------------------------------------------------------------

  /** Terminates the worker and releases everything the page holds for it (R8). Idempotent. */
  private async terminate(
    s: Session,
    reason: 'unload' | 'load_failed' | 'abort' | 'error',
    emitTerminated = true,
  ): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    s.worker.onmessage = null;
    s.worker.onerror = null;
    s.worker.onmessageerror = null;
    try {
      s.worker.terminate();
    } catch {
      // already gone
    }
    s.bootstrap.revoke();
    for (const h of s.held) h.release();
    if (emitTerminated) this.workerEvent(s, 'terminated', reason, undefined);
    if (this.session === s) this.session = undefined;
  }

  private async crash(s: Session): Promise<void> {
    if (s.closed) return;
    this.workerEvent(s, 'crashed', 'error', undefined);
    const err = new AdapterError('backend', 'the engine worker stopped unexpectedly');
    const ready = s.ready;
    const pending = [...s.pending.values()];
    for (const p of pending) {
      if (p.kind === 'generate' && p.graceTimer !== undefined) clearTimeout(p.graceTimer);
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    }
    s.pending.clear();
    await this.terminate(s, 'error', false);
    ready?.reject(err);
    for (const p of pending) p.reject(err);
  }

  private async closeSession(reason: 'unload'): Promise<void> {
    const s = this.session;
    if (!s) return;
    for (const [id, p] of [...s.pending]) {
      this.finish(s, id, p);
      p.reject(new AdapterError('not_loaded', 'the model was unloaded'));
    }
    try {
      s.worker.postMessage({ v: 1, type: 'unload' });
    } catch {
      // the worker is terminated next either way
    }
    await this.terminate(s, reason);
  }

  async unload(): Promise<void> {
    await this.closeSession('unload');
  }

  // ---- generate -----------------------------------------------------------------------------------

  generate(prompt: string | ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const s = this.session;
    if (!s || s.closed) return Promise.reject(new AdapterError('not_loaded', 'call load() first'));
    if (s.descriptor.task !== 'text-generation')
      return Promise.reject(
        new AdapterError('unsupported_operation', 'this model does not generate text'),
      );
    try {
      checkMaxTokens(opts.maxTokens);
    } catch (e) {
      return Promise.reject(e);
    }
    if (opts.signal?.aborted)
      return Promise.reject(new AdapterError('aborted', 'the generation was aborted'));
    const id = ++s.nextId;
    const grace = this.o.abortGraceMs ?? 250;
    return new Promise<GenerateResult>((resolve, reject) => {
      const p: Pending = {
        kind: 'generate',
        resolve,
        reject,
        onToken: opts.onToken,
        text: '',
        startedAt: now(),
        graceTimer: undefined,
        signal: opts.signal,
        onAbort: undefined,
      };
      if (opts.signal) {
        p.onAbort = () => {
          // ask the engine to stop; if it does not answer in time the worker is terminated (R8)
          try {
            s.worker.postMessage({ v: 1, type: 'abort', id });
          } catch {
            // terminated below
          }
          p.graceTimer = setTimeout(() => {
            if (!s.pending.has(id)) return;
            this.finish(s, id, p);
            // R4b: Stop after the first token keeps the partial text; before it, the call is rejected
            void this.terminate(s, 'abort').then(() =>
              p.text === ''
                ? reject(new AdapterError('aborted', 'the generation was aborted'))
                : resolve({ text: p.text, finishReason: 'abort', usage: {}, timings: {} }),
            );
          }, grace);
        };
        opts.signal.addEventListener('abort', p.onAbort, { once: true });
      }
      s.pending.set(id, p);
      const wire: Record<string, unknown> = {};
      if (opts.maxTokens !== undefined) wire['maxTokens'] = opts.maxTokens;
      if (opts.temperature !== undefined) wire['temperature'] = opts.temperature;
      if (opts.topP !== undefined) wire['topP'] = opts.topP;
      if (opts.seed !== undefined) wire['seed'] = opts.seed;
      if (opts.stop !== undefined) wire['stop'] = [...opts.stop];
      s.worker.postMessage({
        v: 1,
        type: 'generate',
        id,
        prompt:
          typeof prompt === 'string'
            ? prompt
            : prompt.map((m) => ({ role: m.role, content: m.content })),
        opts: wire,
      });
    });
  }

  /**
   * R14. The input rules are checked here, before any message leaves the page. An abort rejects 'aborted' at
   * once and leaves the worker usable: an embedding is one engine call that cannot be interrupted, so its
   * late answer is ignored (its id is no longer pending) instead of terminating the worker.
   */
  embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    const s = this.session;
    if (!s || s.closed) return Promise.reject(new AdapterError('not_loaded', 'call load() first'));
    if (s.descriptor.task !== 'feature-extraction')
      return Promise.reject(
        new AdapterError('unsupported_operation', 'this model does not produce embeddings'),
      );
    let resolved: ReturnType<typeof resolveEmbedOptions>;
    try {
      checkEmbedTexts(texts);
      resolved = resolveEmbedOptions(opts);
    } catch (e) {
      return Promise.reject(e);
    }
    if (opts.signal?.aborted)
      return Promise.reject(new AdapterError('aborted', 'the embedding was aborted'));
    const id = ++s.nextId;
    return new Promise<EmbedResult>((resolve, reject) => {
      const p: PendingEmbed = {
        kind: 'embed',
        resolve,
        reject,
        startedAt: now(),
        count: texts.length,
        signal: opts.signal,
        onAbort: undefined,
      };
      if (opts.signal) {
        p.onAbort = () => {
          if (!s.pending.has(id)) return;
          this.finish(s, id, p);
          this.emitEmbed(s, p, 'aborted', { dims: 0, truncated: 0 });
          reject(new AdapterError('aborted', 'the embedding was aborted'));
        };
        opts.signal.addEventListener('abort', p.onAbort, { once: true });
      }
      s.pending.set(id, p);
      s.worker.postMessage({
        v: 1,
        type: 'embed',
        id,
        texts: [...texts],
        opts: { pooling: resolved.pooling, normalize: resolved.normalize },
      });
    });
  }
}

export type WorkerAdapterHandle = WorkerTransformersAdapter;

export function createWorkerAdapter(options: WorkerAdapterOptions): WorkerTransformersAdapter {
  return new WorkerTransformersAdapter(options);
}
