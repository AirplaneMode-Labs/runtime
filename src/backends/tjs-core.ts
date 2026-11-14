/**
 * Engine-independent pieces of the Transformers.js adapters, shared by the main-thread adapter
 * (transformers.ts) and the worker host (src/worker/tjs-engine.ts): the slice of the engine they rely
 * on, the verified engine configuration (configureEnv and assertEnv), the ONNX Runtime session options
 * built from a descriptor, the chat-template variables, and one generation run.
 *
 * Nothing here touches `document`, `location` or storage, and nothing here fetches: the engine's own
 * network function is replaced by the verified-file shim before any of this runs.
 */

import {
  AdapterError,
  type ChatMessage,
  type GenerateOptions,
  type GenerateResult,
} from '../../spec/backend-adapter';
import type { ModelDescriptor } from '../../spec/model-descriptor';
import type { VerifiedFetch } from './verified-files';

export const DEFAULT_MAX_NEW_TOKENS = 256;

export const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

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

export interface EngineStreamer {
  put(value: bigint[][]): void;
  end(): void;
}

export interface TransformersModule {
  env: EngineEnv;
  pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<EnginePipeline>;
  TextStreamer: new (tokenizer: unknown, options: Record<string, unknown>) => EngineStreamer;
  InterruptableStoppingCriteria: new () => { interrupt(): void; reset(): void };
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

/**
 * The session options for one load: a fresh object literal holding the validated graphOptimizationLevel
 * and nothing else. The deprecated application option wins when it names a level; otherwise the
 * descriptor's `sessionOptions` (0.2) supplies it. Never Object.assign, for...in or spread of either
 * source, so no other key and no prototype can come through.
 */
export function buildSessionOptions(
  app: SessionOptions | undefined,
  descriptor: ModelDescriptor,
): { graphOptimizationLevel: NonNullable<SessionOptions['graphOptimizationLevel']> } | undefined {
  const level = app?.graphOptimizationLevel ?? descriptor.sessionOptions?.graphOptimizationLevel;
  if (level === undefined) return undefined;
  if (typeof level !== 'string' || !GRAPH_LEVELS.has(level))
    throw new AdapterError('bad_descriptor', 'the descriptor session option is not a known level');
  return { graphOptimizationLevel: level };
}

/**
 * chatTemplateKwargs as a fresh plain object: each validated key is defined as an own data property,
 * so even a key that names a prototype slot could not reach Object.prototype (the descriptor parser
 * has already refused __proto__, constructor and prototype).
 */
export function copyTemplateKwargs(
  source: Readonly<Record<string, string | number | boolean>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      throw new AdapterError('bad_descriptor', 'a chat template variable has an unusable value');
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

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

const REMOTE_HOST_SINK = 'https://invalid.invalid/';

/** Flags that must hold at every pipeline() and generate(): remote and every cache switched off. */
export const REQUIRED_FLAGS: Readonly<Record<string, boolean | string>> = Object.freeze({
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
export function usableModelId(id: string): boolean {
  return (
    id.length <= 96 &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id) &&
    !id.includes('..') &&
    !id.includes('--') &&
    !id.endsWith('.git') &&
    !id.endsWith('.ipynb')
  );
}

/** Weight files: reading one means the engine is about to create a session. */
export const WEIGHTS_PATH = /(?:^|\/)onnx\/|\.onnx(?:_data)?$/;

// ---- engine env ---------------------------------------------------------------------------------

export interface EnvContext {
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

export function expectedThreads(): number {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return Math.max(1, Math.min(4, cores ?? 1));
}

/** Runs right after import() and before the first pipeline(). */
export function configureEnv(env: EngineEnv, ctx: EnvContext): void {
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
export function assertEnv(env: EngineEnv, ctx: EnvContext): void {
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

/** Text of a text-generation result: the last chat message's content, or the generated string. */
export function extractText(out: unknown): string {
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

export interface GenerationOutcome {
  text: string;
  finishReason: GenerateResult['finishReason'];
  inTokens: number;
  outTokens: number;
  prefillMs: number;
  decodeMs: number;
  tokensPerSecond: number;
  /** Milliseconds to the first generated token, or undefined when none was produced. */
  firstTokenMs: number | undefined;
  durationMs: number;
}

/**
 * One text generation: greedy or sampled per the options, streaming each piece to opts.onToken and
 * honouring opts.signal through the engine's stopping criteria. Engine failures are thrown as they
 * are; the caller maps them (R5). `descriptor.generation.chatTemplateKwargs` reaches the chat template
 * as a fresh plain object.
 */
export async function generateText(
  mod: TransformersModule,
  generator: EnginePipeline,
  descriptor: ModelDescriptor,
  prompt: string | ChatMessage[],
  opts: GenerateOptions,
): Promise<GenerationOutcome> {
  const messages: ChatMessage[] =
    typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
  const maxTokens = opts.maxTokens ?? descriptor.generation?.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS;
  const greedy =
    opts.temperature === 0 || (opts.temperature === undefined && opts.seed !== undefined);
  const kwargs: Record<string, unknown> = { max_new_tokens: maxTokens };
  if (greedy) kwargs['do_sample'] = false;
  else if (opts.temperature !== undefined || opts.topP !== undefined) {
    kwargs['do_sample'] = true;
    if (opts.temperature !== undefined) kwargs['temperature'] = opts.temperature;
    if (opts.topP !== undefined) kwargs['top_p'] = opts.topP;
  }
  const templateKwargs = descriptor.generation?.chatTemplateKwargs;
  if (templateKwargs && Object.keys(templateKwargs).length > 0)
    kwargs['tokenizer_encode_kwargs'] = copyTemplateKwargs(templateKwargs);

  const stopper = new mod.InterruptableStoppingCriteria();
  const onAbort = () => stopper.interrupt();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const stats = {
    puts: 0,
    inTokens: 0,
    outTokens: 0,
    firstTokenAt: undefined as number | undefined,
  };
  const textStreamer = new mod.TextStreamer(generator.tokenizer, {
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
    out = await generator(messages, kwargs);
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
  return {
    text,
    finishReason,
    inTokens: stats.inTokens,
    outTokens: stats.outTokens,
    prefillMs,
    decodeMs,
    tokensPerSecond: decodeMs > 0 ? (stats.outTokens / decodeMs) * 1000 : 0,
    firstTokenMs: stats.firstTokenAt === undefined ? undefined : prefillMs,
    durationMs: Math.max(0, t1 - t0),
  };
}

/** The pinned ONNX Runtime Web binary and factory for one device (src/backends/ort-pins.ts). */
export interface OrtPin {
  wasmFile: string;
  wasmSha256: string;
  factoryFile: string;
  factorySha256: string;
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
