/**
 * The runtime-internal RPC between the page and the engine worker (protocol v1), and the strict
 * validation of everything the page receives from a worker (backend-adapter.md R13).
 *
 * A worker is untrusted: it runs an engine and its dependencies. Every message it posts is checked
 * here before anything is built from it. A message with an unknown type, extra keys or a bad shape
 * is a crash (the caller terminates the worker); the valid ones carry only enums, ids, numbers in
 * range and the model's answer text. The worker's own error text and any other string never reach an
 * event, a message or the DOM: `error.cause` is dropped here, the value of `egress.origin` is discarded
 * (S1-074: the host records a fixed string and a count), and a code that is not an AdapterErrorCode
 * becomes 'backend'.
 *
 * This file has no side effects and imports only types and constants, so the worker bundle can load it
 * after the egress guard.
 */

import {
  EMBED_MAX_TEXTS,
  type AdapterErrorCode,
  type ChatMessage,
} from '../../spec/backend-adapter';
import {
  MEMORY_SAMPLE_POINTS,
  MODEL_LOAD_PHASES,
  type MemorySamplePoint,
  type ModelLoadPhase,
} from '../../spec/event';
import type { ModelDescriptor } from '../../spec/model-descriptor';

export const WORKER_PROTOCOL_VERSION = 1 as const;
/** A phase duration above one day is not a duration. */
export const MAX_PHASE_MS = 86_400_000;
const MAX_TOKEN_CHARS = 65_536;
const MAX_RESULT_CHARS = 8 * 1024 * 1024;
const MAX_ERROR_CAUSE_CHARS = 10_000;

// ---- page to worker -------------------------------------------------------------------------------

export interface InitFile {
  path: string;
  entryId: string;
  sha256: string;
  size: number;
  /**
   * The Blob the page got from the asset manager (R2w). Since backend adapter 0.4.0 the page does NOT
   * re-hash it: the worker hashes it against `sha256` and `size` before the engine sees a byte (R15).
   */
  blob: Blob;
}

export interface InitMessage {
  v: 1;
  type: 'init';
  adapter: string;
  device: 'wasm' | 'webgpu';
  loadId: string;
  /** Absolute http(s) URL ending in '__airplanemode/verified/', no query, no fragment. */
  verifiedPrefix: string;
  /** Absolute URL of the ONNX Runtime factory on the page origin. */
  ortFactoryUrl: string;
  descriptorEntryId: string;
  descriptor: ModelDescriptor;
  files: InitFile[];
  /** Path (listed in files) of the engine's WASM runtime. */
  runtimeWasm: string;
  sessionOptions?: { graphOptimizationLevel?: string };
}

export interface GenerateMessage {
  v: 1;
  type: 'generate';
  id: number;
  prompt: string | ChatMessage[];
  opts: { maxTokens?: number; temperature?: number; topP?: number; stop?: string[]; seed?: number };
}
export interface EmbedMessage {
  v: 1;
  type: 'embed';
  id: number;
  texts: string[];
  opts: { pooling?: 'mean' | 'cls'; normalize?: boolean };
}
export interface AbortMessage {
  v: 1;
  type: 'abort';
  id: number;
}
export interface UnloadMessage {
  v: 1;
  type: 'unload';
}

// ---- worker to page (validated) ------------------------------------------------------------------

export type MemoryApi = 'performance.memory' | 'measureUserAgentSpecificMemory' | 'none';

export type PeakPhase = 'load' | 'generate' | 'embed';
export const PEAK_PHASES: readonly PeakPhase[] = ['load', 'generate', 'embed'];

export interface WorkerGenerateResult {
  text: string;
  finishReason: 'stop' | 'length' | 'abort' | 'error';
  /** The token budget this call ran with (R4b). */
  budget?: number;
  usage: { promptTokens?: number; completionTokens?: number };
  timings: {
    prefillMs?: number;
    decodeMs?: number;
    tokensPerSecond?: number;
    firstTokenMs?: number;
  };
}

export type WorkerMessage =
  | { type: 'phase'; phase: ModelLoadPhase; durationMs: number; bytes?: number }
  | {
      type: 'memory';
      scope: 'worker';
      at: MemorySamplePoint;
      api: MemoryApi;
      usedJsHeap: number | null;
      totalJsHeap: number | null;
      jsHeapLimit: number | null;
      wasmMemory: number | null;
    }
  | { type: 'ready' }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; result: WorkerGenerateResult }
  /** Embeddings (R14). The vectors are NOT validated here: the host checks them against the request. */
  | {
      type: 'embedded';
      id: number;
      dims: number;
      vectors: unknown[];
      normalized: boolean;
      truncated: number;
      totalMs: number;
    }
  /** The peak WebAssembly.Memory byteLength the worker read during a phase; bytes only when it could read one. */
  | { type: 'peak'; phase: PeakPhase; measure: 'wasm-memory' | 'unavailable'; bytes?: number }
  | { type: 'error'; code: AdapterErrorCode }
  /** The worker's origin text is validated for shape and discarded (S1-074): the host never forwards it. */
  | { type: 'egress' };

export type ValidatedMessage = { ok: true; message: WorkerMessage } | { ok: false };

const ERROR_CODES: ReadonlySet<string> = new Set<AdapterErrorCode>([
  'not_loaded',
  'unsupported_profile',
  'unsupported_operation',
  'aborted',
  'backend',
  'unavailable',
  'bad_descriptor',
  'egress_refused',
  'integrity',
  'not_cached',
  'context_overflow',
]);
const FINISH: ReadonlySet<string> = new Set(['stop', 'length', 'abort', 'error']);
const APIS: ReadonlySet<string> = new Set([
  'performance.memory',
  'measureUserAgentSpecificMemory',
  'none',
]);

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function plain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Own enumerable string keys exactly equal to `allowed` or a subset that includes `required`. */
function keysOk(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  if (Object.getOwnPropertySymbols(o).length > 0) return false;
  if (keys.length > required.length + optional.length) return false;
  return (
    required.every((k) => own(o, k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

const safeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const intOrNull = (v: unknown): v is number | null => v === null || safeInt(v);
const duration = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PHASE_MS;

/**
 * A validator that remembers which phases it has accepted, so a phase is accepted at most once per
 * load. Create one per load. It never throws.
 */
export function createWorkerMessageValidator(): (raw: unknown) => ValidatedMessage {
  const seenPhases = new Set<string>();
  const fail: ValidatedMessage = { ok: false };
  return (raw) => {
    try {
      if (!plain(raw) || !own(raw, 'v') || raw['v'] !== WORKER_PROTOCOL_VERSION) return fail;
      const type = raw['type'];
      if (typeof type !== 'string') return fail;
      switch (type) {
        case 'phase': {
          if (!keysOk(raw, ['v', 'type', 'phase', 'durationMs'], ['bytes'])) return fail;
          const phase = raw['phase'];
          if (
            typeof phase !== 'string' ||
            !(MODEL_LOAD_PHASES as readonly string[]).includes(phase)
          )
            return fail;
          if (seenPhases.has(phase)) return fail;
          if (!duration(raw['durationMs'])) return fail;
          const bytes = raw['bytes'];
          if (own(raw, 'bytes') && !(bytes === null || safeInt(bytes))) return fail;
          seenPhases.add(phase);
          return {
            ok: true,
            message: {
              type: 'phase',
              phase: phase as ModelLoadPhase,
              durationMs: raw['durationMs'],
              ...(typeof bytes === 'number' ? { bytes } : {}),
            },
          };
        }
        case 'memory': {
          if (
            !keysOk(raw, [
              'v',
              'type',
              'scope',
              'at',
              'api',
              'usedJsHeap',
              'totalJsHeap',
              'jsHeapLimit',
              'wasmMemory',
            ])
          )
            return fail;
          const at = raw['at'];
          const api = raw['api'];
          if (raw['scope'] !== 'worker') return fail;
          if (typeof at !== 'string' || !(MEMORY_SAMPLE_POINTS as readonly string[]).includes(at))
            return fail;
          if (typeof api !== 'string' || !APIS.has(api)) return fail;
          const { usedJsHeap, totalJsHeap, jsHeapLimit, wasmMemory } = raw;
          if (![usedJsHeap, totalJsHeap, jsHeapLimit, wasmMemory].every(intOrNull)) return fail;
          return {
            ok: true,
            message: {
              type: 'memory',
              scope: 'worker',
              at: at as MemorySamplePoint,
              api: api as MemoryApi,
              usedJsHeap: usedJsHeap as number | null,
              totalJsHeap: totalJsHeap as number | null,
              jsHeapLimit: jsHeapLimit as number | null,
              wasmMemory: wasmMemory as number | null,
            },
          };
        }
        case 'ready':
          return keysOk(raw, ['v', 'type']) ? { ok: true, message: { type: 'ready' } } : fail;
        case 'token': {
          if (!keysOk(raw, ['v', 'type', 'id', 'text'])) return fail;
          const { id, text } = raw;
          if (!safeInt(id) || typeof text !== 'string' || text.length > MAX_TOKEN_CHARS)
            return fail;
          return { ok: true, message: { type: 'token', id, text } };
        }
        case 'done': {
          if (!keysOk(raw, ['v', 'type', 'id', 'result'])) return fail;
          const { id, result } = raw;
          if (!safeInt(id) || !plain(result)) return fail;
          if (!keysOk(result, ['text', 'finishReason', 'usage', 'timings'], ['budget']))
            return fail;
          if (own(result, 'budget') && !safeInt(result['budget'])) return fail;
          const { text, finishReason, usage, timings } = result;
          if (typeof text !== 'string' || text.length > MAX_RESULT_CHARS) return fail;
          if (typeof finishReason !== 'string' || !FINISH.has(finishReason)) return fail;
          if (!plain(usage) || !keysOk(usage, [], ['promptTokens', 'completionTokens']))
            return fail;
          if (own(usage, 'promptTokens') && !safeInt(usage['promptTokens'])) return fail;
          if (own(usage, 'completionTokens') && !safeInt(usage['completionTokens'])) return fail;
          if (
            !plain(timings) ||
            !keysOk(timings, [], ['prefillMs', 'decodeMs', 'tokensPerSecond', 'firstTokenMs'])
          )
            return fail;
          for (const k of ['prefillMs', 'decodeMs', 'tokensPerSecond', 'firstTokenMs'])
            if (
              own(timings, k) &&
              !(
                typeof timings[k] === 'number' &&
                Number.isFinite(timings[k]) &&
                (timings[k] as number) >= 0
              )
            )
              return fail;
          return {
            ok: true,
            message: {
              type: 'done',
              id,
              result: {
                text,
                finishReason: finishReason as WorkerGenerateResult['finishReason'],
                ...(own(result, 'budget') ? { budget: result['budget'] as number } : {}),
                usage: {
                  ...(own(usage, 'promptTokens')
                    ? { promptTokens: usage['promptTokens'] as number }
                    : {}),
                  ...(own(usage, 'completionTokens')
                    ? { completionTokens: usage['completionTokens'] as number }
                    : {}),
                },
                timings: Object.fromEntries(
                  ['prefillMs', 'decodeMs', 'tokensPerSecond', 'firstTokenMs']
                    .filter((k) => own(timings, k))
                    .map((k) => [k, timings[k] as number]),
                ),
              },
            },
          };
        }
        case 'embedded': {
          if (
            !keysOk(raw, [
              'v',
              'type',
              'id',
              'dims',
              'vectors',
              'normalized',
              'truncated',
              'totalMs',
            ])
          )
            return fail;
          const { id, dims, vectors, normalized, truncated, totalMs } = raw;
          if (!safeInt(id) || !safeInt(dims) || dims < 1 || dims > 65_536) return fail;
          if (!Array.isArray(vectors) || vectors.length > EMBED_MAX_TEXTS) return fail;
          if (typeof normalized !== 'boolean' || !safeInt(truncated)) return fail;
          if (typeof totalMs !== 'number' || !Number.isFinite(totalMs) || totalMs < 0) return fail;
          // count, length, element type and finiteness of the vectors are the host's job (R14)
          return {
            ok: true,
            message: {
              type: 'embedded',
              id,
              dims,
              vectors: [...vectors],
              normalized,
              truncated,
              totalMs,
            },
          };
        }
        case 'peak': {
          if (!keysOk(raw, ['v', 'type', 'phase', 'measure'], ['bytes'])) return fail;
          const { phase, measure } = raw;
          if (typeof phase !== 'string' || !(PEAK_PHASES as readonly string[]).includes(phase))
            return fail;
          if (measure !== 'wasm-memory' && measure !== 'unavailable') return fail;
          // nothing is estimated: a figure comes with 'wasm-memory' and only with it
          if (measure === 'wasm-memory') {
            if (!safeInt(raw['bytes'])) return fail;
            return {
              ok: true,
              message: { type: 'peak', phase: phase as PeakPhase, measure, bytes: raw['bytes'] },
            };
          }
          if (own(raw, 'bytes')) return fail;
          return { ok: true, message: { type: 'peak', phase: phase as PeakPhase, measure } };
        }
        case 'error': {
          if (!keysOk(raw, ['v', 'type', 'code'], ['cause'])) return fail;
          const cause = raw['cause'];
          if (typeof cause === 'string' && cause.length > MAX_ERROR_CAUSE_CHARS) return fail;
          const code = raw['code'];
          // the cause is dropped on purpose: engine text never reaches an event or a message
          return {
            ok: true,
            message: {
              type: 'error',
              code:
                typeof code === 'string' && ERROR_CODES.has(code)
                  ? (code as AdapterErrorCode)
                  : 'backend',
            },
          };
        }
        case 'egress': {
          if (!keysOk(raw, ['v', 'type', 'origin'])) return fail;
          // the value of origin is discarded whatever it is: no worker string reaches an event
          return { ok: true, message: { type: 'egress' } };
        }
        default:
          return fail;
      }
    } catch {
      return fail;
    }
  };
}
