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
  EMBED_MAX_TEXTS,
  EMBED_TEXT_MAX,
  type ChatMessage,
  type EmbedOptions,
  type GenerateOptions,
  type GenerateResult,
} from '../../spec/backend-adapter';
import type { ModelDescriptor } from '../../spec/model-descriptor';
import type { VerifiedFetch } from './verified-files';

export const DEFAULT_MAX_NEW_TOKENS = 256;
/** The largest maxTokens a caller may ask for (R4b). */
export const MAX_TOKENS_LIMIT = 32768;

/** R4b: maxTokens is absent, or an integer 1..MAX_TOKENS_LIMIT; anything else is a TypeError before any work. */
export function checkMaxTokens(v: unknown): asserts v is number | undefined {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TOKENS_LIMIT)
    throw new TypeError(`maxTokens must be an integer from 1 to ${MAX_TOKENS_LIMIT}`);
}

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
 * The engine memory options of the worker host (backend adapter R17, Sprint 6 B1): on device 'wasm' the
 * session is created with ONNX Runtime's CPU memory arena and memory-pattern planning turned off, which trades
 * a little speed for a smaller peak. They are fixed by the host and are NOT part of the application-facing
 * `sessionOptions` allow-list (checkSessionOptions still accepts graphOptimizationLevel and nothing else), so
 * no descriptor and no caller can set or flip them. WebGPU gets none: ONNX Runtime Web already forces
 * memory-pattern planning off there. A fresh object on every call.
 */
export function memorySessionOptions(
  device: 'wasm' | 'webgpu',
): { enableCpuMemArena: false; enableMemPattern: false } | undefined {
  return device === 'wasm' ? { enableCpuMemArena: false, enableMemPattern: false } : undefined;
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
  /** The token budget the call ran with (R4b). */
  budget?: number;
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
  checkMaxTokens(opts.maxTokens);
  if (opts.signal?.aborted) throw new AdapterError('aborted', 'the generation was aborted');
  const messages: ChatMessage[] =
    typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
  const requested = opts.maxTokens ?? descriptor.generation?.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS;
  const greedy =
    opts.temperature === 0 || (opts.temperature === undefined && opts.seed !== undefined);
  const kwargs: Record<string, unknown> = {};
  if (greedy) kwargs['do_sample'] = false;
  else if (opts.temperature !== undefined || opts.topP !== undefined) {
    kwargs['do_sample'] = true;
    if (opts.temperature !== undefined) kwargs['temperature'] = opts.temperature;
    if (opts.topP !== undefined) kwargs['top_p'] = opts.topP;
  }
  const templateKwargs = descriptor.generation?.chatTemplateKwargs;
  const copiedKwargs =
    templateKwargs && Object.keys(templateKwargs).length > 0
      ? copyTemplateKwargs(templateKwargs)
      : undefined;
  if (copiedKwargs) kwargs['tokenizer_encode_kwargs'] = copiedKwargs;

  // R4b: the budget. The prompt is rendered and counted with the engine's own tokenizer BEFORE decode; a
  // prompt that leaves no room is context_overflow and the engine never runs. When the tokenizer cannot
  // say (an engine without these functions) the requested count stands and nothing is guessed.
  let budget = requested;
  const promptTokens = countPromptTokens(generator.tokenizer, messages, copiedKwargs);
  if (promptTokens !== undefined) {
    const room = descriptor.contextLength - promptTokens;
    if (room < 1)
      throw new AdapterError(
        'context_overflow',
        'the prompt leaves no room in the context to answer',
      );
    budget = Math.min(requested, room);
  }
  kwargs['max_new_tokens'] = budget;

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
  // R4b: Stop after the first token keeps the partial text; Stop before it is a rejection
  if (aborted && stats.outTokens < 1)
    throw new AdapterError('aborted', 'the generation was aborted');
  const finishReason: GenerateResult['finishReason'] = aborted
    ? 'abort'
    : !stoppedOnString && stats.outTokens >= budget
      ? 'length'
      : 'stop';
  const prefillMs = Math.max(0, (stats.firstTokenAt ?? t1) - t0);
  const decodeMs = Math.max(0, t1 - (stats.firstTokenAt ?? t1));
  return {
    text,
    budget,
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

// ---- embeddings (backend adapter 0.4.0, R14) -------------------------------------------------------

/**
 * The embed() input rules: 1..EMBED_MAX_TEXTS texts, each a well-formed string of 1..EMBED_TEXT_MAX UTF-16
 * units. Anything else is a TypeError, thrown before any work and before any message leaves the page.
 */
export function checkEmbedTexts(texts: unknown): asserts texts is string[] {
  if (!Array.isArray(texts)) throw new TypeError('embed() takes an array of strings');
  if (texts.length < 1 || texts.length > EMBED_MAX_TEXTS)
    throw new TypeError(`embed() takes 1 to ${EMBED_MAX_TEXTS} texts`);
  for (const t of texts) {
    if (typeof t !== 'string') throw new TypeError('embed() takes an array of strings');
    if (t.length < 1 || t.length > EMBED_TEXT_MAX)
      throw new TypeError(`an embed() text has 1 to ${EMBED_TEXT_MAX} UTF-16 units`);
    if (!t.isWellFormed()) throw new TypeError('an embed() text is not well-formed Unicode');
  }
}

/** The pooling and normalisation an embed() call runs with: 'mean' and true unless the caller says otherwise. */
export function resolveEmbedOptions(opts: EmbedOptions | undefined): {
  pooling: 'mean' | 'cls';
  normalize: boolean;
} {
  const pooling = opts?.pooling ?? 'mean';
  if (pooling !== 'mean' && pooling !== 'cls')
    throw new TypeError("embed() pooling is 'mean' or 'cls'");
  const normalize = opts?.normalize ?? true;
  if (typeof normalize !== 'boolean') throw new TypeError('embed() normalize is a boolean');
  return { pooling, normalize };
}

/**
 * The token count of `text` through the engine's own tokenizer, or undefined when the tokenizer cannot say.
 * Used for the context checks (truncation of an embedding input, the prompt of a generation): never a guess.
 */
export function countTokens(
  tokenizer: unknown,
  text: string,
  options: Record<string, unknown>,
): number | undefined {
  try {
    if (typeof tokenizer !== 'function') return undefined;
    const t = (tokenizer as (t: string, o: Record<string, unknown>) => unknown)(text, options) as {
      input_ids?: { dims?: unknown };
    };
    const dims = t?.input_ids?.dims;
    if (!Array.isArray(dims) || dims.length === 0) return undefined;
    const n = dims[dims.length - 1];
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The length, in the model's own tokens, of the chat-templated prompt that generation will feed the engine:
 * the template is rendered the way the text-generation pipeline renders it (add_generation_prompt, the
 * descriptor's chatTemplateKwargs) and the result tokenised without special tokens. undefined when the
 * tokenizer cannot say.
 */
export function countPromptTokens(
  tokenizer: unknown,
  messages: ChatMessage[],
  templateKwargs: Record<string, string | number | boolean> | undefined,
): number | undefined {
  try {
    const t = tokenizer as {
      apply_chat_template?: (m: unknown, o: Record<string, unknown>) => unknown;
    };
    if (!t || typeof t.apply_chat_template !== 'function') return undefined;
    const rendered = t.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
      ...templateKwargs,
    });
    if (typeof rendered !== 'string') return undefined;
    return countTokens(tokenizer, rendered, {
      add_special_tokens: false,
      padding: false,
      truncation: false,
    });
  } catch {
    return undefined;
  }
}

export interface EmbedOutcome {
  vectors: Float32Array[];
  dims: number;
  normalized: boolean;
  /** How many texts were longer than the model's context and were cut. */
  truncated: number;
  totalMs: number;
}

/** One feature-extraction call over `texts` with the engine's pipeline: one Float32Array per text. */
export async function embedTexts(
  extractor: EnginePipeline,
  descriptor: ModelDescriptor,
  texts: string[],
  opts: { pooling: 'mean' | 'cls'; normalize: boolean },
): Promise<EmbedOutcome> {
  const t0 = now();
  let truncated = 0;
  for (const text of texts) {
    const n = countTokens(extractor.tokenizer, text, {
      add_special_tokens: true,
      truncation: false,
      padding: false,
    });
    if (n !== undefined && n > descriptor.contextLength) truncated++;
  }
  const out = (await extractor(texts, { pooling: opts.pooling, normalize: opts.normalize })) as {
    dims?: number[];
    data?: ArrayLike<number>;
  };
  const dims = out?.dims?.[1];
  if (
    !out?.data ||
    typeof dims !== 'number' ||
    !Number.isSafeInteger(dims) ||
    dims < 1 ||
    out.dims?.[0] !== texts.length ||
    out.data.length !== texts.length * dims
  )
    throw new AdapterError(
      'backend',
      'the inference engine returned an unexpected embedding shape',
    );
  const data = Float32Array.from(out.data);
  const vectors = texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
  return {
    vectors,
    dims,
    normalized: opts.normalize,
    truncated,
    totalMs: Math.max(0, now() - t0),
  };
}
