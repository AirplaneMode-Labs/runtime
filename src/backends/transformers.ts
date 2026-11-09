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
import { loadDescriptor } from './descriptor';
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

// ---- the slice of the engine we rely on ---------------------------------------------------------

export interface EngineEnv {
  backends: { onnx: { wasm: Record<string, unknown> } };
  fetch: unknown;
  [key: string]: unknown;
}

export interface EnginePipeline {
  (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  tokenizer?: unknown;
  dispose?(): Promise<void> | void;
}

interface EngineStreamer {
  put(value: bigint[][]): void;
  end(): void;
}

export interface TransformersModule {
  env: EngineEnv;
  pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<EnginePipeline>;
  TextStreamer: new (tokenizer: unknown, options: Record<string, unknown>) => EngineStreamer;
  InterruptableStoppingCriteria: new () => { interrupt(): void; reset(): void };
}

export interface OrtPin {
  wasmFile: string;
  wasmSha256: string;
  factoryFile: string;
  factorySha256: string;
}

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
   * docs/model-choice.md). Any other key is refused. It belongs in the model descriptor eventually;
   * until the contract carries it, the application passes it here.
   */
  sessionOptions?: SessionOptions;
  /**
   * Answers "can a WebGPU device be created here?" for available() on the webgpu device. Default:
   * probeWebGpuDevice() (navigator.gpu.requestAdapter() then requestDevice(), then destroy()).
   */
  gpuProbe?: () => Promise<boolean>;
}

export interface SessionOptions {
  graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'layout' | 'all';
}

const GRAPH_LEVELS: ReadonlySet<string> = new Set([
  'disabled',
  'basic',
  'extended',
  'layout',
  'all',
]);

/** Accepts only {graphOptimizationLevel} with a known level; anything else is a TypeError. */
export function checkSessionOptions(o: unknown): SessionOptions {
  if (o === null || typeof o !== 'object' || Array.isArray(o))
    throw new TypeError('sessionOptions must be an object');
  const out: SessionOptions = {};
  for (const [key, value] of Object.entries(o)) {
    if (key !== 'graphOptimizationLevel')
      throw new TypeError(`sessionOptions.${key} is not allowed; only graphOptimizationLevel is`);
    if (typeof value !== 'string' || !GRAPH_LEVELS.has(value))
      throw new TypeError('sessionOptions.graphOptimizationLevel is not a known level');
    out.graphOptimizationLevel = value as NonNullable<SessionOptions['graphOptimizationLevel']>;
  }
  return out;
}

// ---- the WebGPU device probe ----------------------------------------------------------------------

/** The slice of navigator.gpu the probe uses (so tests can hand it a fake). */
export interface GpuLike {
  requestAdapter(): Promise<{
    requestDevice(): Promise<{ destroy(): void } | null | undefined>;
  } | null>;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * True only when the browser hands out a WebGPU adapter AND a device from it. The device is destroyed
 * at once: this asks "can a device be created here", it keeps nothing. Never throws; a missing
 * navigator.gpu, a null adapter or device, a rejection, or no answer within the timeout is false. No
 * download, no model, no engine import (the contract says available() is cheap).
 */
export async function probeWebGpuDevice(
  gpu: GpuLike | undefined = (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  const attempt = (async (): Promise<boolean> => {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    if (!device) return false;
    try {
      device.destroy();
    } catch {
      // a device that cannot be destroyed was still created
    }
    return true;
  })().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- constants ----------------------------------------------------------------------------------

const ADAPTER_ID = 'transformers-js';
const DEFAULT_MAX_NEW_TOKENS = 256;
const REMOTE_HOST_SINK = 'https://invalid.invalid/';

/** Flags that must hold at every pipeline() and generate(): remote and every cache switched off. */
const REQUIRED_FLAGS: Readonly<Record<string, boolean | string>> = Object.freeze({
  allowRemoteModels: false,
  allowLocalModels: true,
  useBrowserCache: false,
  useFSCache: false,
  useFS: false,
  useCustomCache: false,
  useWasmCache: false,
  experimental_useCrossOriginStorage: false,
  remoteHost: REMOTE_HOST_SINK,
});

/** The engine builds its URL as <localModelPath><model id>/<file>: the id must pass its own regex. */
function usableModelId(id: string): boolean {
  return (
    id.length <= 96 &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id) &&
    !id.includes('..') &&
    !id.includes('--') &&
    !id.endsWith('.git') &&
    !id.endsWith('.ipynb')
  );
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

/** Weight files: reading one means the engine is about to create a session. */
const WEIGHTS_PATH = /(?:^|\/)onnx\/|\.onnx(?:_data)?$/;

const defaultEngineLoader = (): Promise<TransformersModule> =>
  import('@huggingface/transformers') as unknown as Promise<TransformersModule>;

// ---- engine env ---------------------------------------------------------------------------------

interface EnvContext {
  prefix: string;
  shim: VerifiedFetch;
  ortFactoryUrl: string;
  wasmBinary: ArrayBuffer;
  numThreads: number;
}

function wasmEnv(env: EngineEnv): Record<string, unknown> {
  const wasm = env?.backends?.onnx?.wasm;
  if (!wasm || typeof wasm !== 'object')
    throw new AdapterError('backend', 'the engine does not expose its ONNX runtime settings');
  return wasm;
}

function expectedThreads(): number {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return Math.max(1, Math.min(4, cores ?? 1));
}

/** Runs right after import() and before the first pipeline(). */
function configureEnv(env: EngineEnv, ctx: EnvContext): void {
  for (const [key, value] of Object.entries(REQUIRED_FLAGS)) env[key] = value;
  env['localModelPath'] = ctx.prefix;
  env.fetch = ctx.shim;
  const wasm = wasmEnv(env);
  // The library default points wasmPaths at a CDN. An object with only `mjs` (and no `wasm` key)
  // makes it use the wasmBinary below instead of fetching the binary.
  wasm['wasmPaths'] = { mjs: ctx.ortFactoryUrl };
  wasm['wasmBinary'] = ctx.wasmBinary;
  wasm['numThreads'] = ctx.numThreads;
  wasm['proxy'] = false;
}

/** Re-asserts every configured value; any drift is AdapterError 'backend' and nothing runs. */
function assertEnv(env: EngineEnv, ctx: EnvContext): void {
  const drift = (what: string): never => {
    throw new AdapterError(
      'backend',
      `the engine settings no longer match the verified configuration (${what})`,
    );
  };
  for (const [key, value] of Object.entries(REQUIRED_FLAGS)) if (env[key] !== value) drift(key);
  if (env['localModelPath'] !== ctx.prefix) drift('localModelPath');
  if (env.fetch !== ctx.shim) drift('fetch');
  const wasm = wasmEnv(env);
  const paths = wasm['wasmPaths'];
  if (
    paths === null ||
    typeof paths !== 'object' ||
    Object.keys(paths).length !== 1 ||
    (paths as { mjs?: unknown }).mjs !== ctx.ortFactoryUrl
  )
    drift('wasmPaths');
  if (wasm['wasmBinary'] !== ctx.wasmBinary) drift('wasmBinary');
  if (wasm['numThreads'] !== ctx.numThreads) drift('numThreads');
  if (wasm['proxy'] !== false) drift('proxy');
}

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
          attrs: { adapter: this.id, origin },
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
        onProgress: opts.onProgress,
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

      // R2: every byte the engine gets comes from a Blob read after acquire() with rehash.
      const verified: VerifiedFileInput[] = [];
      let wasmBlob: Blob | undefined;
      let bytes = entry.size;
      for (const f of loaded.files) {
        held.push(await opts.assets.acquire!(f.entry.id, acquireOptions(opts)));
        aborted();
        const blob = await opts.assets.getBlob(f.entry.id, { rehash: true });
        bytes += blob.size;
        verified.push({ path: f.path, blob, sha256: f.entry.sha256 });
        if (f === wasmFile) wasmBlob = blob;
      }
      const wasmBinary = await wasmBlob!.arrayBuffer();
      aborted();

      const prefix = this.prefix ?? defaultVerifiedPrefix();
      set = registerVerifiedFiles(prefix, entry.id, verified);
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
      try {
        generator = await mod.pipeline(d.task, entry.id, {
          device: this.device,
          dtype: d.dtype,
          local_files_only: true,
          ...(this.sessionOptions && Object.keys(this.sessionOptions).length > 0
            ? { session_options: { ...this.sessionOptions } }
            : {}),
        });
      } catch (e) {
        // the engine had read the weights, so the failure is (or may be) a rejected session creation,
        // which poisons this module instance; an abort is not an engine failure
        if (sessionStarted && !isAbortLike(e)) POISONED_ENGINES.add(this.engineLoader);
        throw e;
      }
      aborted();

      this.state = {
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
          attrs: { adapter: this.id, model: entry.id, device: this.device, code: codeOf(err) },
        }),
      );
      throw err;
    }
  }

  async generate(
    prompt: string | ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const st = this.requireLoaded();
    if (st.descriptor.task !== 'text-generation')
      throw new AdapterError('unsupported_operation', 'this model does not generate text');
    assertEnv(st.mod.env, st.env);
    if (opts.signal?.aborted) return { text: '', finishReason: 'abort', usage: {}, timings: {} };

    const messages: ChatMessage[] =
      typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    const maxTokens =
      opts.maxTokens ?? st.descriptor.generation?.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS;
    const greedy =
      opts.temperature === 0 || (opts.temperature === undefined && opts.seed !== undefined);
    const kwargs: Record<string, unknown> = { max_new_tokens: maxTokens };
    if (greedy) kwargs['do_sample'] = false;
    else if (opts.temperature !== undefined || opts.topP !== undefined) {
      kwargs['do_sample'] = true;
      if (opts.temperature !== undefined) kwargs['temperature'] = opts.temperature;
      if (opts.topP !== undefined) kwargs['top_p'] = opts.topP;
    }
    const templateKwargs = st.descriptor.generation?.chatTemplateKwargs;
    if (templateKwargs && Object.keys(templateKwargs).length > 0)
      kwargs['tokenizer_encode_kwargs'] = { ...templateKwargs };

    const stopper = new st.mod.InterruptableStoppingCriteria();
    const onAbort = () => stopper.interrupt();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const stats = {
      puts: 0,
      inTokens: 0,
      outTokens: 0,
      firstTokenAt: undefined as number | undefined,
    };
    const textStreamer = new st.mod.TextStreamer(st.generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (piece: string) => {
        try {
          opts.onToken?.(piece);
        } catch {
          // a token listener must not break generation
        }
      },
    });
    kwargs['streamer'] = {
      put(value: bigint[][]) {
        stats.puts++;
        if (stats.puts === 1) stats.inTokens = value[0]?.length ?? 0;
        else {
          stats.outTokens++;
          stats.firstTokenAt ??= now();
        }
        textStreamer.put(value);
      },
      end() {
        textStreamer.end();
      },
    } satisfies EngineStreamer;
    kwargs['stopping_criteria'] = stopper;

    const t0 = now();
    let out: unknown;
    try {
      out = await st.generator(messages, kwargs);
    } catch (e) {
      throw mapError(e, 'the inference engine failed while generating');
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const t1 = now();

    let text = extractText(out);
    let stoppedOnString = false;
    for (const s of opts.stop ?? []) {
      if (s.length === 0) continue;
      const i = text.indexOf(s);
      if (i >= 0 && (!stoppedOnString || i < text.length)) {
        text = text.slice(0, i);
        stoppedOnString = true;
      }
    }
    const aborted = opts.signal?.aborted === true;
    const finishReason: GenerateResult['finishReason'] = aborted
      ? 'abort'
      : !stoppedOnString && stats.outTokens >= maxTokens
        ? 'length'
        : 'stop';
    const prefillMs = Math.max(0, (stats.firstTokenAt ?? t1) - t0);
    const decodeMs = Math.max(0, t1 - (stats.firstTokenAt ?? t1));
    const tokensPerSecond = decodeMs > 0 ? (stats.outTokens / decodeMs) * 1000 : 0;
    safeEmit(st.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.generate',
        level: 'info',
        durationMs: Math.max(0, t1 - t0),
        attrs: {
          adapter: this.id,
          device: this.device,
          finishReason,
          inTokens: stats.inTokens,
          outTokens: stats.outTokens,
          tokensPerSecond,
          prefillMs,
          decodeMs,
        },
      }),
    );
    return {
      text,
      finishReason,
      usage: { promptTokens: stats.inTokens, completionTokens: stats.outTokens },
      timings: { prefillMs, decodeMs, tokensPerSecond },
    };
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<EmbedResult> {
    const st = this.requireLoaded();
    if (st.descriptor.task !== 'feature-extraction')
      throw new AdapterError('unsupported_operation', 'this model does not produce embeddings');
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'the embedding was aborted');
    assertEnv(st.mod.env, st.env);
    if (texts.length === 0) return { vectors: [], dims: 0, normalized: true };
    let out: unknown;
    try {
      out = await st.generator(texts, { pooling: 'mean', normalize: true });
    } catch (e) {
      throw mapError(e, 'the inference engine failed while embedding');
    }
    const t = out as { dims?: number[]; data?: ArrayLike<number> };
    const dims = t.dims?.[1];
    if (!t.data || typeof dims !== 'number' || dims < 1)
      throw new AdapterError(
        'backend',
        'the inference engine returned an unexpected embedding shape',
      );
    const data = Float32Array.from(t.data);
    const vectors = texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    return { vectors, dims, normalized: true };
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
  return o;
}

/** Text of a text-generation result: the last chat message's content, or the generated string. */
function extractText(out: unknown): string {
  const first = Array.isArray(out)
    ? (out[0] as { generated_text?: unknown } | undefined)
    : undefined;
  const gt = first?.generated_text;
  if (typeof gt === 'string') return gt;
  if (Array.isArray(gt)) {
    const last = gt[gt.length - 1] as { content?: unknown } | undefined;
    if (typeof last?.content === 'string') return last.content;
  }
  return '';
}

export function createTransformersAdapter(opts: TransformersAdapterOptions): TransformersAdapter {
  return new TransformersAdapter(opts);
}
