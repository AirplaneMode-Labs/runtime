/**
 * The Transformers.js engine inside the worker (backend-adapter.md R2w, R7, R12). One TjsEngine serves
 * exactly one load: the page starts a fresh worker per load() and terminates it afterwards.
 *
 * Order of work on `init`: the egress guard sentinel is checked FIRST (without it nothing runs); the
 * verifiedPrefix must be absolute, end in '__airplanemode/verified/', carry no query or fragment and
 * share its origin with this script; every file's Blob must have exactly the manifest size (a Blob that
 * is not readable or has another size is 'integrity'); then R15 (S1-070): every file the engine can read
 * is hashed HERE against the sha256 the manifest entry carries and the engine is served the bytes that
 * were hashed (verify-files.ts), before anything is registered or imported; then hand-off (register the
 * verified bytes, take the wasm binary), the engine is configured exactly as on the main thread
 * (configureEnv with the shim built from an EXPLICIT location, never from self.location, which is
 * non-hierarchical in a blob worker), and pipeline() creates the session. A text-generation model
 * answers `generate`; a feature-extraction model answers `embed` (R14). Engine calls run one at a time.
 *
 * The worker never opens storage and never fetches; it posts plain payloads (phases, memory, tokens,
 * the result) and the page builds the events (R12). It posts an enum error code and nothing else on
 * failure: engine text stays here.
 */

import { AdapterError, type AdapterErrorCode } from '../../spec/backend-adapter';
import type { ModelDescriptor } from '../../spec/model-descriptor';
import {
  assertEnv,
  buildSessionOptions,
  checkEmbedTexts,
  configureEnv,
  embedTexts,
  expectedThreads,
  generateText,
  memorySessionOptions,
  now,
  resolveEmbedOptions,
  usableModelId,
  type EnginePipeline,
  type EnvContext,
  type TransformersModule,
} from '../backends/tjs-core';
import {
  createVerifiedFetch,
  registerVerifiedFiles,
  type VerifiedFileSet,
} from '../backends/verified-files';
import { sampleMemory } from '../observability';
import { isEgressGuardInstalled, setGuardedFetch } from './egress-guard';
import type { EmbedMessage, GenerateMessage, InitMessage, PeakPhase } from './protocol';
import { verifyFiles } from './verify-files';
import {
  installWasmMemoryProbe,
  type PeakReading,
  type WasmMemoryProbe,
  type WebAssemblyLike,
} from './wasm-memory';

const VERIFIED_SUFFIX = '__airplanemode/verified/';

export interface TjsEngineDeps {
  /** Posts a plain object to the page. */
  post(message: Record<string, unknown>): void;
  /** Loads the engine module. Default: import('@huggingface/transformers'). */
  loadEngine?: () => Promise<TransformersModule>;
  /** The origin of this worker script: new URL(import.meta.url).origin. */
  selfOrigin: string;
  /** The scope that carries the guard sentinel. Default: globalThis. */
  scope?: object;
  /**
   * Reads the peak WebAssembly.Memory of the engine (event model.memory). Default: a probe installed on this
   * scope's WebAssembly when it has one (the real worker), otherwise none and the answer is 'unavailable'.
   */
  wasmProbe?: WasmMemoryProbe | undefined;
}

const defaultLoader = (): Promise<TransformersModule> =>
  import('@huggingface/transformers') as unknown as Promise<TransformersModule>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * R18: is this an allocation failure? Read INSIDE the worker; only the verdict leaves it (the code enum), never
 * the message. A RangeError that mentions memory or allocation (V8: "WebAssembly.Memory.grow(): Maximum memory
 * size exceeded", "Array buffer allocation failed"), or an engine allocation error of any class (ONNX Runtime:
 * "std::bad_alloc", "Aborted(OOM)", "out of memory"). A RangeError about something else ("Invalid string
 * length") and an error that merely contains the word memory stay 'backend'.
 */
export function isAllocationFailure(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  let name = '';
  let message = '';
  try {
    name = String((e as { name?: unknown }).name ?? '');
    message = String((e as { message?: unknown }).message ?? '');
  } catch {
    return false;
  }
  if (name === 'RangeError' && /memory|alloc/i.test(message)) return true;
  return /bad_alloc|Aborted\(OOM\)|out of memory|failed to allocate|could not allocate|unable to allocate/i.test(
    message,
  );
}

function codeOf(e: unknown): AdapterErrorCode {
  if (e instanceof AdapterError) return e.code;
  // S1-073: an unreadable Blob (the OPFS snapshot changed) is an integrity failure
  if (e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'NotReadableError')
    return 'integrity';
  if (isAllocationFailure(e)) return 'out_of_memory';
  return 'backend';
}

export class TjsEngine {
  private readonly post: (m: Record<string, unknown>) => void;
  private readonly loadEngine: () => Promise<TransformersModule>;
  private readonly selfOrigin: string;
  private readonly scope: object;
  private mod: TransformersModule | undefined;
  private generator: EnginePipeline | undefined;
  private env: EnvContext | undefined;
  private descriptor: ModelDescriptor | undefined;
  private set: VerifiedFileSet | undefined;
  private current: { id: number; ctl: AbortController } | undefined;
  /** The File snapshots that were hashed (R15): re-read once, a byte each, when the engine fails (R20). */
  private hashedBlobs: Blob[] = [];
  private firstTokenPosted = false;
  private inited = false;
  private readonly probe: WasmMemoryProbe | undefined;
  /** Engine calls (generate, embed) run one at a time: a session does not take two runs at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: TjsEngineDeps) {
    this.post = (m) => deps.post({ v: 1, ...m });
    this.loadEngine = deps.loadEngine ?? defaultLoader;
    this.selfOrigin = deps.selfOrigin;
    this.scope = deps.scope ?? globalThis;
    // installed before the engine module is imported, so its memories are reachable
    const wa = (this.scope as { WebAssembly?: WebAssemblyLike }).WebAssembly;
    this.probe = 'wasmProbe' in deps ? deps.wasmProbe : wa ? installWasmMemoryProbe(wa) : undefined;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs `fn` under the memory probe and posts the peak BEFORE its caller posts the result. */
  private async measured<T>(phase: PeakPhase, fn: () => Promise<T>): Promise<T> {
    if (!this.probe) {
      const result = await fn();
      this.post({ type: 'peak', phase, measure: 'unavailable' });
      return result;
    }
    let outcome: { result: T; peak: PeakReading };
    outcome = await this.probe.measure(phase, fn);
    const peak = outcome.peak;
    this.post(
      peak.measure === 'wasm-memory'
        ? { type: 'peak', phase, measure: 'wasm-memory', bytes: peak.bytes }
        : { type: 'peak', phase, measure: 'unavailable' },
    );
    return outcome.result;
  }

  /** Dispatches a message from the page. Never throws. */
  async handle(raw: unknown): Promise<void> {
    try {
      if (!isRecord(raw) || raw['v'] !== 1 || typeof raw['type'] !== 'string') return;
      switch (raw['type']) {
        case 'init':
          return await this.init(raw as unknown as InitMessage);
        case 'generate':
          return await this.enqueue(() => this.generate(raw as unknown as GenerateMessage));
        case 'embed':
          return await this.enqueue(() => this.embed(raw as unknown as EmbedMessage));
        case 'abort':
          if (this.current && this.current.id === raw['id']) this.current.ctl.abort();
          return;
        case 'unload':
          return await this.unload();
        default:
          return;
      }
    } catch (e) {
      this.post({ type: 'error', code: codeOf(e) });
    }
  }

  private fail(e: unknown): void {
    this.post({ type: 'error', code: codeOf(e) });
  }

  private checkInit(m: InitMessage): { prefix: URL } {
    if (!isEgressGuardInstalled(this.scope))
      throw new AdapterError('backend', 'the egress guard is not installed in this worker');
    if (this.inited) throw new AdapterError('backend', 'this worker already loaded a model');
    if (typeof m.verifiedPrefix !== 'string')
      throw new AdapterError('backend', 'no verified prefix');
    let prefix: URL;
    try {
      prefix = new URL(m.verifiedPrefix);
    } catch {
      throw new AdapterError('backend', 'the verified prefix is not a URL');
    }
    if (
      (prefix.protocol !== 'https:' && prefix.protocol !== 'http:') ||
      prefix.search !== '' ||
      prefix.hash !== '' ||
      /[?#]/.test(m.verifiedPrefix) ||
      !prefix.pathname.endsWith(`/${VERIFIED_SUFFIX}`) ||
      prefix.href !== m.verifiedPrefix ||
      prefix.origin !== this.selfOrigin
    )
      throw new AdapterError('backend', 'the verified prefix is not usable from this worker');
    if (
      !Array.isArray(m.files) ||
      m.files.length === 0 ||
      typeof m.runtimeWasm !== 'string' ||
      !isRecord(m.descriptor) ||
      typeof m.descriptorEntryId !== 'string' ||
      !usableModelId(m.descriptorEntryId) ||
      (m.device !== 'wasm' && m.device !== 'webgpu') ||
      typeof m.ortFactoryUrl !== 'string'
    )
      throw new AdapterError('backend', 'the init message is not usable');
    for (const f of m.files) {
      if (!isRecord(f) || typeof f.path !== 'string' || typeof f.entryId !== 'string')
        throw new AdapterError('backend', 'a file of the init message is not usable');
      if (!(f.blob instanceof Blob) || !Number.isSafeInteger(f.size) || f.blob.size !== f.size)
        throw new AdapterError(
          'integrity',
          'a file does not have the size its manifest entry promised',
        );
    }
    if (!m.files.some((f) => f.path === m.runtimeWasm))
      throw new AdapterError('backend', 'the runtime wasm is not among the files');
    return { prefix };
  }

  private async init(m: InitMessage): Promise<void> {
    try {
      const { prefix } = this.checkInit(m);
      this.inited = true;
      const d = m.descriptor;
      this.descriptor = d;

      // R15 (S1-070): hash every file the engine can read, here, before anything is registered or imported.
      // A failure throws 'integrity' and the engine has received 0 bytes.
      const tv = now();
      const verified = await verifyFiles(m.files, { keepBuffer: m.runtimeWasm });
      this.hashedBlobs = verified.files.map((f) => f.blob);
      this.post({
        type: 'phase',
        phase: 'verify',
        durationMs: Math.max(0, now() - tv),
        bytes: verified.bytes,
      });

      // hand-off: the bytes that were hashed, and the wasm binary the engine is given
      const t0 = now();
      const wasmFile = verified.files.find((f) => f.path === m.runtimeWasm)!;
      const wasmBinary = wasmFile.buffer!;
      this.set = registerVerifiedFiles(
        prefix.pathname,
        m.descriptorEntryId,
        verified.files.map((f) => ({ path: f.path, blob: f.blob, sha256: f.sha256 })),
      );
      const bytes = verified.bytes;
      this.post({ type: 'phase', phase: 'handoff', durationMs: Math.max(0, now() - t0), bytes });

      // the engine's network function is the verified shim, built from an explicit location
      const shim = createVerifiedFetch({
        adapterId: m.adapter,
        prefix: prefix.pathname,
        location: { href: m.verifiedPrefix, origin: prefix.origin, pathname: prefix.pathname },
        events: {
          emit: (e) => this.post({ type: 'egress', origin: String(e.attrs['origin'] ?? '') }),
        },
      });
      setGuardedFetch(shim as never);
      // the engine and its session are created under the memory probe (phase 'load')
      const { mod, sessionMs } = await this.measured('load', () =>
        this.createSession(m, d, shim, prefix, wasmBinary),
      );
      this.mod = mod;
      this.post({ type: 'phase', phase: 'session', durationMs: sessionMs });
      this.postMemory('after_session');
      this.post({ type: 'ready' });
    } catch (e) {
      const unreadable = await this.snapshotsUnreadable(e);
      this.cleanup();
      this.fail(
        unreadable ? new AdapterError('integrity', 'a hashed file can no longer be read') : e,
      );
    }
  }

  /**
   * R20: the engine reads each file through a Response over the very snapshot that was hashed, so a snapshot that
   * changed after the shim's one-byte probe fails in the middle of the engine's own read and reaches this worker
   * only as an opaque engine error. When the load fails with a plain engine error, one byte of every hashed
   * snapshot is read again: a snapshot that can no longer be read is 'integrity', never 'backend' (and never
   * retried). An error that already has a better code (integrity, out_of_memory, and the like) is left alone, and
   * nothing is read when the engine did not fail.
   */
  private async snapshotsUnreadable(e: unknown): Promise<boolean> {
    if (codeOf(e) !== 'backend') return false;
    for (const blob of this.hashedBlobs) {
      if (blob.size === 0) continue;
      try {
        await blob.slice(0, 1).arrayBuffer();
      } catch {
        return true;
      }
    }
    return false;
  }

  private async createSession(
    m: InitMessage,
    d: ModelDescriptor,
    shim: ReturnType<typeof createVerifiedFetch>,
    prefix: URL,
    wasmBinary: ArrayBuffer,
  ): Promise<{ mod: TransformersModule; sessionMs: number }> {
    {
      const mod = await this.loadEngine();
      // localModelPath must stay a PATH: the engine treats an absolute http URL as a remote location and
      // skips its local-file check (so it would find no tokenizer). The shim resolves the path against
      // the explicit location above, which is how it reaches the page origin from a blob worker.
      const envCtx: EnvContext = {
        prefix: prefix.pathname,
        shim,
        ortFactoryUrl: m.ortFactoryUrl,
        wasmBinary,
        numThreads: expectedThreads(),
      };
      this.env = envCtx;
      configureEnv(mod.env, envCtx);
      assertEnv(mod.env, envCtx);

      // R17: the descriptor's graph level (when it names one) and, on wasm, the engine memory options
      const level = buildSessionOptions(
        m.sessionOptions as Parameters<typeof buildSessionOptions>[0],
        d,
      );
      const memory = memorySessionOptions(m.device);
      const sessionOptions = level || memory ? { ...level, ...memory } : undefined;
      const t1 = now();
      this.generator = await mod.pipeline(d.task, m.descriptorEntryId, {
        device: m.device,
        dtype: d.dtype,
        local_files_only: true,
        ...(sessionOptions ? { session_options: sessionOptions } : {}),
      });
      return { mod, sessionMs: Math.max(0, now() - t1) };
    }
  }

  private postMemory(at: 'after_session' | 'after_first_token'): void {
    const s = sampleMemory('worker', at, undefined);
    this.post({
      type: 'memory',
      scope: 'worker',
      at: s.at,
      api: s.api,
      usedJsHeap: s.usedJsHeap,
      totalJsHeap: s.totalJsHeap,
      jsHeapLimit: s.jsHeapLimit,
      wasmMemory: s.wasmMemory,
    });
  }

  private async generate(m: GenerateMessage): Promise<void> {
    const { mod, generator, descriptor, env } = this;
    if (!mod || !generator || !descriptor || !env)
      throw new AdapterError('not_loaded', 'not loaded');
    if (!Number.isSafeInteger(m.id) || m.id < 0 || !isRecord(m.opts))
      throw new AdapterError('backend', 'the generate message is not usable');
    if (descriptor.task !== 'text-generation')
      throw new AdapterError('unsupported_operation', 'this model does not generate text');
    const ctl = new AbortController();
    this.current = { id: m.id, ctl };
    try {
      assertEnv(mod.env, env);
      const o = m.opts;
      const r = await this.measured('generate', () =>
        generateText(mod, generator, descriptor, m.prompt, {
          ...(typeof o.maxTokens === 'number' ? { maxTokens: o.maxTokens } : {}),
          ...(typeof o.temperature === 'number' ? { temperature: o.temperature } : {}),
          ...(typeof o.topP === 'number' ? { topP: o.topP } : {}),
          ...(typeof o.seed === 'number' ? { seed: o.seed } : {}),
          ...(Array.isArray(o.stop)
            ? { stop: o.stop.filter((s): s is string => typeof s === 'string') }
            : {}),
          signal: ctl.signal,
          onToken: (text) => {
            this.probe?.tick(); // a sample between decode steps, where the event loop turns
            this.post({ type: 'token', id: m.id, text });
          },
        }),
      );
      if (!this.firstTokenPosted && r.firstTokenMs !== undefined) {
        this.firstTokenPosted = true;
        this.post({ type: 'phase', phase: 'first_token', durationMs: r.firstTokenMs });
        this.postMemory('after_first_token');
      }
      this.post({
        type: 'done',
        id: m.id,
        result: {
          text: r.text,
          finishReason: r.finishReason,
          ...(r.budget !== undefined ? { budget: r.budget } : {}),
          usage: { promptTokens: r.inTokens, completionTokens: r.outTokens },
          timings: {
            prefillMs: r.prefillMs,
            decodeMs: r.decodeMs,
            tokensPerSecond: r.tokensPerSecond,
            ...(r.firstTokenMs !== undefined ? { firstTokenMs: r.firstTokenMs } : {}),
          },
        },
      });
    } finally {
      this.current = undefined;
    }
  }

  /** R14: one feature-extraction call; the peak is posted before the result. */
  private async embed(m: EmbedMessage): Promise<void> {
    const { mod, generator, descriptor, env } = this;
    if (!mod || !generator || !descriptor || !env)
      throw new AdapterError('not_loaded', 'not loaded');
    if (!Number.isSafeInteger(m.id) || m.id < 0 || !isRecord(m.opts))
      throw new AdapterError('backend', 'the embed message is not usable');
    if (descriptor.task !== 'feature-extraction')
      throw new AdapterError('unsupported_operation', 'this model does not produce embeddings');
    // the worker re-checks what the page already checked: the page is not the only possible sender
    checkEmbedTexts(m.texts);
    const opts = resolveEmbedOptions(m.opts);
    assertEnv(mod.env, env);
    const out = await this.measured('embed', () =>
      embedTexts(generator, descriptor, m.texts, opts),
    );
    this.post({
      type: 'embedded',
      id: m.id,
      dims: out.dims,
      vectors: out.vectors,
      normalized: out.normalized,
      truncated: out.truncated,
      totalMs: out.totalMs,
    });
  }

  private cleanup(): void {
    this.set?.release();
    this.set = undefined;
    this.hashedBlobs = [];
  }

  async unload(): Promise<void> {
    try {
      await this.generator?.dispose?.();
    } catch {
      // best effort: the page terminates this worker next
    }
    this.generator = undefined;
    this.cleanup();
  }
}
