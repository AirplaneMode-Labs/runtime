/**
 * Transformers.js adapter (backend adapter 0.2.0): ONNX Runtime Web on WebGPU or WebAssembly.
 *
 * One class, two devices. It loads a model descriptor (R1), acquires every file through the asset
 * manager and reads each from a Blob that was verified after acquire (R2), hands the engine only
 * those bytes through a shim that replaces the engine's network function and refuses everything else
 * (R3), and keeps engine messages out of errors, events and DOM (R5).
 *
 * The engine package is imported lazily, once, and only from here: the main entry of this library
 * never imports it. `engine` can be replaced (tests inject a mocked module).
 *
 * Process-global state this adapter touches (the engine's `env`) is configured right after import()
 * and re-checked before every pipeline() and generate(); a mismatch is AdapterError 'backend' and
 * nothing runs. Only one transformers-js load() runs at a time.
 *
 * Honest fallback (T1-S2-01). available() on the WebGPU device asks the browser for a device and
 * destroys it again, so most GPU failures are seen before any session exists and the WebAssembly rung
 * loads in a clean engine. What the adapter cannot undo: @huggingface/transformers chains every
 * InferenceSession.create() on one module-level promise, so one rejection poisons every later session
 * in that module instance. The adapter notes when a load failed after the engine had started to read
 * the weights (session creation), engineBlocked() reports it, and a later load() on the same engine
 * refuses with 'backend' before pipeline() is called. Per-rung engine isolation is Sprint 3.
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
import { PhaseTimer, emitMemorySample, meterDownloads, newLoadId } from '../observability';
import {
  WEIGHTS_PATH,
  assertEnv,
  buildSessionOptions,
  checkSessionOptions,
  configureEnv,
  checkEmbedTexts,
  checkMaxTokens,
  embedTexts,
  expectedThreads,
  generateText,
  now,
  resolveEmbedOptions,
  probeWebGpuDevice,
  usableModelId,
  type EngineEnv,
  type EnginePipeline,
  type EnvContext,
  type GpuLike,
  type OrtPin,
  type SessionOptions,
  type TransformersModule,
} from './tjs-core';
import { loadDescriptor } from './descriptor';
import {
  createWorkerAdapter,
  type WorkerAdapterOptions,
  type WorkerTransformersAdapter,
} from './worker-adapter';
import { forEntry } from './entry-error';
import { ORT_PINS } from './ort-pins';
import {
  createVerifiedFetch,
  defaultVerifiedPrefix,
  egressOrigin,
  registerVerifiedFiles,
  type VerifiedFetch,
  type VerifiedFileInput,
  type VerifiedFileSet,
} from './verified-files';

export {
  checkSessionOptions,
  probeWebGpuDevice,
  type GpuLike,
  type OrtPin,
  type EngineEnv,
  type EnginePipeline,
  type SessionOptions,
  type TransformersModule,
};

export interface TransformersAdapterOptions {
  device: 'webgpu' | 'wasm';
  /**
   * URL of the ONNX Runtime Web factory (.mjs) served from the page origin (the demo copies it to
   * app/ort/). Resolved against location.href; anything that resolves outside the page origin is
   * refused with egress_refused.
   */
  ortFactoryUrl: string;
  /** Same-origin directory the verified files are served from. Default: derived from the page URL. */
  verifiedPrefix?: string;
  /** Loader of the engine module. Default: import('@huggingface/transformers'). */
  engine?: () => Promise<TransformersModule>;
  /** ORT pins per device. Default: the generated src/backends/ort-pins.ts. */
  pins?: Readonly<Record<'wasm' | 'webgpu', OrtPin>>;
  /**
   * The one ONNX Runtime session option an app may set: graphOptimizationLevel. Needed for a model
   * whose session creation runs out of the 4 GB WebAssembly heap with the default 'all' level (the
   * planned Qwen3-1.7B q4f16 fails with std::bad_alloc unless it is 'disabled'; see
   * docs/model-choice.md). Any other key is refused. Deprecated since model descriptor 0.2.0, which
   * carries the same field as `sessionOptions.graphOptimizationLevel`: the descriptor is signed with
   * the manifest, so a model that needs the option no longer needs the application to know it. When
   * given, a level named here wins over the descriptor's.
   */
  sessionOptions?: SessionOptions;
  /**
   * Answers "can a WebGPU device be created here?" for available() on the webgpu device. Default:
   * probeWebGpuDevice() (navigator.gpu.requestAdapter() then requestDevice(), then destroy()).
   */
  gpuProbe?: () => Promise<boolean>;
  /**
   * URL of the engine worker script (backend adapter 0.3.0, rules R2w, R3w and R7 to R13). When given,
   * createTransformersAdapter() returns the worker adapter (host 'worker'): the engine runs in a
   * dedicated module worker, one per load(), so the page does not freeze on WebAssembly and a WebGPU
   * failure cannot poison the next rung. Without it the main-thread adapter is returned.
   */
  workerUrl?: string;
  /** Worker adapter only: starts the worker (tests inject a fake). */
  spawnWorker?: WorkerAdapterOptions['spawnWorker'];
  /** Worker adapter only: URL.createObjectURL and revokeObjectURL. */
  urlApi?: WorkerAdapterOptions['urlApi'];
  /** Worker adapter only: how long an abort waits for the worker before it is terminated. Default 250 ms. */
  abortGraceMs?: number;
}

// ---- constants ----------------------------------------------------------------------------------

const ADAPTER_ID = 'transformers-js';
const DEFAULT_MAX_NEW_TOKENS = 256;

// ---- one load at a time -------------------------------------------------------------------------

let loadChain: Promise<unknown> = Promise.resolve();

function withLoadMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn, fn);
  loadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- a poisoned engine (T1-S2-01) ---------------------------------------------------------------

/**
 * Engine loaders whose module can no longer create a session. @huggingface/transformers 4.3.1 chains
 * every InferenceSession.create() on one module-level promise (webInitChain): after one rejection every
 * later creation in that module instance rejects with the same error. Keyed by the loader function,
 * which stands for one module instance (every default adapter shares the default loader).
 */
const POISONED_ENGINES = new WeakSet<object>();

const defaultEngineLoader = (): Promise<TransformersModule> =>
  import('@huggingface/transformers') as unknown as Promise<TransformersModule>;

// ---- errors and events --------------------------------------------------------------------------

function isAbortLike(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === 'object' &&
    ((e as { name?: unknown }).name === 'AbortError' ||
      (e instanceof AssetError && e.code === 'aborted'))
  );
}

/** Adapter and asset errors keep their codes; engine errors become 'backend' with the cause kept. */
function mapError(e: unknown, message: string): Error {
  if (e instanceof AdapterError) return e;
  if (isAbortLike(e)) return new AdapterError('aborted', 'the operation was aborted', { cause: e });
  if (e instanceof AssetError) return e;
  return new AdapterError('backend', message, { cause: e });
}

function codeOf(e: Error): string {
  return e instanceof AdapterError ? e.code : 'backend';
}

function safeEmit(sink: EventSink | undefined, build: () => ReturnType<typeof newEvent>): void {
  if (!sink) return;
  try {
    sink.emit(build());
  } catch {
    // telemetry must never change the outcome of a load or a generation
  }
}

// ---- the adapter --------------------------------------------------------------------------------

interface LoadedState {
  loadId: string;
  /** Emits model.load.phase for this load; first_token is added by the first generate(). */
  timer: PhaseTimer;
  mod: TransformersModule;
  generator: EnginePipeline;
  descriptor: ModelDescriptor;
  entryId: string;
  set: VerifiedFileSet;
  held: AssetHandle[];
  env: EnvContext;
  events: EventSink | undefined;
}

export class TransformersAdapter implements BackendAdapter {
  readonly id = ADAPTER_ID;
  readonly tier: BackendTier;
  readonly device: ExecutionDevice;
  /** The engine runs on the page's main thread; a worker adapter reports 'worker'. */
  readonly host = 'main' as const;
  private readonly ortFactoryUrl: string;
  private readonly prefix: string | undefined;
  private readonly engineLoader: () => Promise<TransformersModule>;
  private readonly pins: Readonly<Record<'wasm' | 'webgpu', OrtPin>>;
  private readonly sessionOptions: SessionOptions | undefined;
  private readonly gpuProbe: () => Promise<boolean>;
  private state: LoadedState | undefined;

  constructor(opts: TransformersAdapterOptions) {
    this.device = opts.device;
    this.tier = opts.device === 'webgpu' ? 'webgpu-f32' : 'wasm';
    this.ortFactoryUrl = opts.ortFactoryUrl;
    this.prefix = opts.verifiedPrefix;
    this.engineLoader = opts.engine ?? defaultEngineLoader;
    this.gpuProbe = opts.gpuProbe ?? (() => probeWebGpuDevice());
    this.pins = opts.pins ?? ORT_PINS;
    this.sessionOptions =
      opts.sessionOptions !== undefined ? checkSessionOptions(opts.sessionOptions) : undefined;
  }

  capabilities(): AdapterCapabilities {
    const task = this.state?.descriptor.task;
    return {
      generate: task === undefined ? true : task === 'text-generation',
      embed: task === 'feature-extraction',
      streaming: true,
    };
  }

  /** The device and execution provider the loaded model runs on (a failed create() would have thrown). */
  diagnostics(): { device: ExecutionDevice; executionProviders: string[]; dtype: string } {
    return {
      device: this.device,
      executionProviders: [this.device === 'webgpu' ? 'webgpu' : 'wasm'],
      dtype: this.state?.descriptor.dtype ?? '',
    };
  }

  /**
   * Cheap: no download, no engine import, no model. On the WebGPU device it also asks the browser for
   * a device and destroys it (probeWebGpuDevice), so a GPU that exists but cannot be used is reported
   * here, before any session is created.
   */
  async available(profile: CapabilityProfile): Promise<boolean> {
    if (!this.profileAllows(profile)) return false;
    return this.device === 'webgpu' ? this.gpuProbe() : true;
  }

  /** The profile half of available(): what load() re-checks. */
  private profileAllows(profile: CapabilityProfile): boolean {
    const rank = BACKEND_TIER_RANK[profile.backendTier];
    if (this.device === 'webgpu')
      return profile.gpu === 'webgpu' && rank >= BACKEND_TIER_RANK['webgpu-f32'];
    return rank >= BACKEND_TIER_RANK['wasm'];
  }

  /**
   * True once a load on this adapter's engine module failed after the engine had started creating a
   * session: that module cannot create another one in this page until the page is reloaded. The chain
   * asks this before it plans a download for a rung.
   */
  engineBlocked(): boolean {
    return POISONED_ENGINES.has(this.engineLoader);
  }

  load(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    return withLoadMutex(() => this.loadLocked(entry, opts));
  }

  private resolveOrtFactoryUrl(events: EventSink | undefined): string {
    const loc = (globalThis as { location?: { href: string; origin: string } }).location;
    let url: URL | undefined;
    try {
      url = loc ? new URL(this.ortFactoryUrl, loc.href) : new URL(this.ortFactoryUrl);
    } catch {
      url = undefined;
    }
    const sameOrigin =
      url !== undefined &&
      loc !== undefined &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === loc.origin &&
      !/[?#]/.test(url.href);
    if (!sameOrigin) {
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

  private async loadLocked(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    const t0 = now();
    await this.unloadLocked();
    const held: AssetHandle[] = [];
    let set: VerifiedFileSet | undefined;
    const loadId = newLoadId();
    const timer = new PhaseTimer({
      sink: opts.events,
      loadId,
      adapter: this.id,
      device: this.device,
      model: entry.id,
      host: this.host,
    });
    const meter = meterDownloads(opts.assets);
    const onProgress: NonNullable<LoadOptions['onProgress']> = (p) => {
      meter.progress(p);
      opts.onProgress?.(p);
    };
    emitMemorySample(opts.events, loadId, 'page', 'before_load');
    const aborted = () => {
      if (opts.signal?.aborted) throw new AdapterError('aborted', 'the load was aborted');
    };
    try {
      aborted();
      // the profile only: the chain already asked available(), which includes the device probe
      if (!this.profileAllows(opts.profile))
        throw new AdapterError(
          'unsupported_profile',
          'this device cannot run the adapter on this execution device',
        );
      // T1-S2-01: nothing is acquired and pipeline() is not called for an engine that cannot recover
      if (this.engineBlocked())
        throw new AdapterError(
          'backend',
          'the inference engine in this page cannot start another session until the page is reloaded',
        );
      if (!usableModelId(entry.id))
        throw new AdapterError(
          'bad_descriptor',
          'the descriptor entry id cannot be used as an engine model id',
        );
      const ortFactoryUrl = this.resolveOrtFactoryUrl(opts.events);

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

      // R2: every byte the engine gets comes from a Blob read after acquire() with rehash. The two
      // steps run one after the other so each phase (acquire, then verify) is timed on its own.
      const acquireOpts = acquireOptions({ ...opts, onProgress });
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
      const verified: VerifiedFileInput[] = [];
      let wasmBlob: Blob | undefined;
      let bytes = entry.size;
      for (const f of loaded.files) {
        const blob = await timer.measure(
          'verify',
          () => forEntry(f.entry.id, () => opts.assets.getBlob(f.entry.id, { rehash: true })),
          (b) => b.size,
        );
        bytes += blob.size;
        verified.push({ path: f.path, blob, sha256: f.entry.sha256 });
        if (f === wasmFile) wasmBlob = blob;
      }
      timer.emit('verify');
      aborted();

      // hand-off: read the wasm binary and register the verified Blobs the engine is given
      const handoffStart = now();
      const wasmBinary = await wasmBlob!.arrayBuffer();
      aborted();
      const prefix = this.prefix ?? defaultVerifiedPrefix();
      set = registerVerifiedFiles(prefix, entry.id, verified);
      timer.add('handoff', now() - handoffStart, bytes - entry.size);
      timer.emit('handoff');
      let sessionStarted = false;
      const fileBase = `${prefix}${entry.id}/`;
      const shim = createVerifiedFetch({
        adapterId: this.id,
        events: opts.events,
        prefix,
        // a GET of the weights is the engine reading them for InferenceSession.create()
        onServe: (pathname, method) => {
          if (
            method === 'GET' &&
            pathname.startsWith(fileBase) &&
            WEIGHTS_PATH.test(pathname.slice(fileBase.length))
          )
            sessionStarted = true;
        },
      });
      const mod = await this.engineLoader();
      const envCtx: EnvContext = {
        prefix,
        shim,
        ortFactoryUrl,
        wasmBinary,
        numThreads: expectedThreads(),
      };
      configureEnv(mod.env, envCtx);
      assertEnv(mod.env, envCtx);
      aborted();
      let generator: EnginePipeline;
      const sessionOptions = buildSessionOptions(this.sessionOptions, d);
      try {
        generator = await timer.measure('session', () =>
          mod.pipeline(d.task, entry.id, {
            device: this.device,
            dtype: d.dtype,
            local_files_only: true,
            ...(sessionOptions ? { session_options: sessionOptions } : {}),
          }),
        );
      } catch (e) {
        // the engine had read the weights, so the failure is (or may be) a rejected session creation,
        // which poisons this module instance; an abort is not an engine failure
        if (sessionStarted && !isAbortLike(e)) POISONED_ENGINES.add(this.engineLoader);
        throw e;
      }
      aborted();
      timer.emit('session');
      emitMemorySample(opts.events, loadId, 'page', 'after_session');

      this.state = {
        loadId,
        timer,
        mod,
        generator,
        descriptor: d,
        entryId: entry.id,
        set,
        held,
        env: envCtx,
        events: opts.events,
      };
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
            host: this.host,
          },
        }),
      );
    } catch (e) {
      set?.release();
      for (const h of held) h.release();
      const err = mapError(e, 'the inference engine failed to load the model');
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
            host: this.host,
          },
        }),
      );
      throw err;
    } finally {
      meter.stop();
    }
  }

  async generate(
    prompt: string | ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const st = this.requireLoaded();
    if (st.descriptor.task !== 'text-generation')
      throw new AdapterError('unsupported_operation', 'this model does not generate text');
    checkMaxTokens(opts.maxTokens);
    assertEnv(st.mod.env, st.env);
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'the generation was aborted');

    let r: Awaited<ReturnType<typeof generateText>>;
    try {
      r = await generateText(st.mod, st.generator, st.descriptor, prompt, opts);
    } catch (e) {
      throw mapError(e, 'the inference engine failed while generating');
    }
    const { finishReason, prefillMs, decodeMs, tokensPerSecond, firstTokenMs, text } = r;
    const stats = { inTokens: r.inTokens, outTokens: r.outTokens };
    // the first token of the first generate() after the load: one model.load.phase and one sample
    if (firstTokenMs !== undefined && st.timer.record('first_token', firstTokenMs))
      emitMemorySample(st.events, st.loadId, 'page', 'after_first_token');
    safeEmit(st.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.generate',
        level: 'info',
        durationMs: r.durationMs,
        attrs: {
          adapter: this.id,
          device: this.device,
          finishReason,
          inTokens: stats.inTokens,
          outTokens: stats.outTokens,
          tokensPerSecond,
          prefillMs,
          decodeMs,
          firstTokenMs: firstTokenMs ?? null,
          host: this.host,
          budget: r.budget ?? 0,
        },
      }),
    );
    return {
      text,
      finishReason,
      ...(r.budget !== undefined ? { budget: r.budget } : {}),
      usage: { promptTokens: stats.inTokens, completionTokens: stats.outTokens },
      timings: {
        prefillMs,
        decodeMs,
        tokensPerSecond,
        ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      },
    };
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    const st = this.requireLoaded();
    if (st.descriptor.task !== 'feature-extraction')
      throw new AdapterError('unsupported_operation', 'this model does not produce embeddings');
    checkEmbedTexts(texts);
    const resolved = resolveEmbedOptions(opts);
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'the embedding was aborted');
    assertEnv(st.mod.env, st.env);
    let out: Awaited<ReturnType<typeof embedTexts>>;
    try {
      out = await embedTexts(st.generator, st.descriptor, texts, resolved);
    } catch (e) {
      throw mapError(e, 'the inference engine failed while embedding');
    }
    return {
      vectors: out.vectors,
      dims: out.dims,
      normalized: out.normalized,
      truncated: out.truncated > 0,
      timings: { totalMs: out.totalMs },
    };
  }

  async unload(): Promise<void> {
    await this.unloadLocked();
  }

  private async unloadLocked(): Promise<void> {
    const st = this.state;
    this.state = undefined;
    if (!st) return;
    try {
      await st.generator.dispose?.();
    } catch {
      // disposing is best effort: the files are released either way
    }
    st.set.release();
    for (const h of st.held) h.release();
  }

  private requireLoaded(): LoadedState {
    if (!this.state) throw new AdapterError('not_loaded', 'call load() first');
    return this.state;
  }
}

function acquireOptions(opts: LoadOptions): Parameters<NonNullable<AssetSource['acquire']>>[1] {
  const o: NonNullable<Parameters<NonNullable<AssetSource['acquire']>>[1]> = {};
  if (opts.signal) o.signal = opts.signal;
  if (opts.onProgress) o.onProgress = opts.onProgress;
  if (opts.cacheOnly === true) o.cacheOnly = true;
  return o;
}

export function createTransformersAdapter(
  opts: TransformersAdapterOptions & { workerUrl: string },
): WorkerTransformersAdapter;
export function createTransformersAdapter(opts: TransformersAdapterOptions): TransformersAdapter;
export function createTransformersAdapter(
  opts: TransformersAdapterOptions,
): TransformersAdapter | WorkerTransformersAdapter {
  if (opts.workerUrl !== undefined) {
    const { workerUrl, spawnWorker, urlApi, abortGraceMs, ...rest } = opts;
    return createWorkerAdapter({
      device: rest.device,
      ortFactoryUrl: rest.ortFactoryUrl,
      workerUrl,
      ...(rest.verifiedPrefix !== undefined ? { verifiedPrefix: rest.verifiedPrefix } : {}),
      ...(rest.pins !== undefined ? { pins: rest.pins } : {}),
      ...(rest.sessionOptions !== undefined ? { sessionOptions: rest.sessionOptions } : {}),
      ...(rest.gpuProbe !== undefined ? { gpuProbe: rest.gpuProbe } : {}),
      ...(spawnWorker !== undefined ? { spawnWorker } : {}),
      ...(urlApi !== undefined ? { urlApi } : {}),
      ...(abortGraceMs !== undefined ? { abortGraceMs } : {}),
    });
  }
  return new TransformersAdapter(opts);
}
