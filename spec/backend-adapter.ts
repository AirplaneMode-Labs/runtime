/**
 * Backend adapter contract 0.5.0 (see backend-adapter.md for prose).
 *
 * 0.5.0 (minor, spec release 0.6.0; B1 memory hardening): no interface method changes (`unload()` already
 * exists); the error code 'out_of_memory'. backend-adapter.md adds R16 (unload: for host 'worker' it resolves
 * only after the worker is terminated and every AssetHandle is released, and emits model.unload), R17 (engine
 * memory options, informative), R18 (out of memory: classified inside the worker into the code enum only), R19
 * (a re-load after unload is a first load and re-verifies everything) and R20 (the engine consumes exactly the
 * bytes the R15 re-hash covered).
 *
 * 0.4.0 (minor, spec release 0.5.0): `embed(texts, opts?)` takes `EmbedOptions` (`pooling`, `normalize`,
 * `signal`) and returns `EmbedResult` with `truncated` and `timings`; the limits EMBED_MAX_TEXTS and
 * EMBED_TEXT_MAX; the error code 'context_overflow'; `GenerateResult.budget`. backend-adapter.md adds R4b
 * (token budget, context_overflow, Stop), R14 (embeddings through the worker host, with host-side
 * validation of the worker's answer) and R15 (in-worker integrity over every file the engine can read; the
 * main-thread load-time re-hash leaves the load path), and names the worker-support exports
 * installEgressGuard({ allowPathPrefixes }) and startModuleWorker(url, { policyName }).
 *
 * 0.3.1 (spec release 0.4.0, patch): no type changed; backend-adapter.md amends R13 (worker-reported
 * egress refusals are recorded per Event 0.1.3, and the host never forwards worker text; S1-074).
 *
 * One interface over Transformers.js, WebLLM and the Chrome Prompt API. An adapter never fetches
 * the network itself: every byte comes from an AssetSource (the runtime asset manager), which only
 * hands out files that were fetched and SHA-256-verified against a signed manifest entry (rules R1
 * to R13 in backend-adapter.md).
 *
 * 0.3.0 changes over 0.2.0: `AcquireOptions.cacheOnly` and `LoadOptions.cacheOnly` (cache-only is
 * enforced at acquire(), not only in the chain), the error codes 'integrity' and 'not_cached',
 * `GenerateResult.timings.firstTokenMs` and `BackendAdapter.host`. The prose adds R2w and R3w (an
 * engine in a worker) and R7 to R13 (isolation, abort and crash, chain integrity, chain cacheOnly,
 * WebLLM staging, observability, untrusted worker messages).
 *
 * 0.2.0 changes over 0.1.0: `ExecutionDevice`, `AcquireOptions`, `BackendAdapter.device` and
 * `available()`, `LoadOptions.onProgress`, `AssetSource.acquire(entryId, opts)` with a
 * cross-instance hold, and the codes 'unavailable', 'bad_descriptor' and 'egress_refused'.
 * `load(entry)` takes the descriptor entry (see model-descriptor.ts, which this file does not
 * import).
 */

import type { BackendTier, CapabilityProfile } from './capability-profile';
import type { EventSink } from './event';
import type { ManifestEntry } from './manifest';

/** Where an adapter runs inference. 'builtin' is the browser's own model (Chrome Prompt API). */
export type ExecutionDevice = 'webgpu' | 'wasm' | 'builtin';

/** A refcounted reference to a verified asset. Held assets are never evicted. */
export interface AssetHandle {
  readonly entryId: string;
  readonly sha256: string;
  readonly size: number;
  /** True when this handle holds a refcount; false for handles returned by ensure(). */
  readonly held: boolean;
  /** Idempotent. */
  release(): void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  onProgress?: (p: { entryId: string; received: number; total: number }) => void;
  /**
   * When true, acquire() resolves only for an entry that has a verified index row AND a stored,
   * committed file of exactly `entry.size` bytes. A `.part` file, complete or partial, is never
   * read, committed, resumed or reconciled under cacheOnly. Otherwise it rejects with code
   * 'not_cached' before any request: no fetch, no Range header and no asset.download.* event. It
   * does not re-hash: the R2 re-hash happens at getBlob(id, { rehash: true }).
   */
  cacheOnly?: boolean;
}

export interface AssetSource {
  /** Verified assets only; rejects with AssetError not_verified otherwise. */
  getBlob(entryId: string, opts?: { rehash?: boolean }): Promise<Blob>;
  /** Optional object URL for the verified blob. */
  getUrl?(entryId: string): Promise<string>;
  getEntry(entryId: string): ManifestEntry;
  /**
   * Refcounted handle; the adapter holds it until unload(). May download through the asset
   * manager. The refcount and a SHARED Web Lock named `airplanemode-held:<sha256>` are taken inside
   * the asset lock and held until `release()`, so eviction and reconcile in any instance or tab
   * skip held assets.
   */
  acquire?(entryId: string, opts?: AcquireOptions): Promise<AssetHandle>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  maxTokens?: number;
  /** 0, or undefined with `seed` set, means greedy decoding (R4). */
  temperature?: number;
  topP?: number;
  stop?: string[];
  seed?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface GenerateResult {
  text: string;
  /**
   * 'length' when the token budget (R4b) was reached; 'abort' when the signal fired after the first token
   * (the partial text is returned; an abort before the first token rejects 'aborted').
   */
  finishReason: 'stop' | 'length' | 'abort' | 'error';
  /** 0.4.0: the token budget this call ran with (R4b); absent on adapters that do not budget. */
  budget?: number;
  usage: { promptTokens?: number; completionTokens?: number };
  timings: {
    prefillMs?: number;
    decodeMs?: number;
    tokensPerSecond?: number;
    /** Milliseconds from the start of generate() to the first generated token; absent when none. */
    firstTokenMs?: number;
  };
}

/** Texts per embed() call, at most. A count outside 1..EMBED_MAX_TEXTS is a TypeError before any work. */
export const EMBED_MAX_TEXTS = 64;
/** UTF-16 code units per text, at most. A length outside 1..EMBED_TEXT_MAX, or a string that is not well-formed, is a TypeError. */
export const EMBED_TEXT_MAX = 8192;

export interface EmbedOptions {
  signal?: AbortSignal;
  /** Default 'mean'. */
  pooling?: 'mean' | 'cls';
  /** Default true: each vector has unit length. */
  normalize?: boolean;
}

export interface EmbedResult {
  /** One Float32Array of length `dims` per input text, in input order; every value finite. */
  vectors: Float32Array[];
  dims: number;
  normalized: boolean;
  /** True when at least one text was cut to the model's context length. */
  truncated?: boolean;
  timings?: { totalMs: number };
}

export interface LoadOptions {
  assets: AssetSource;
  profile: CapabilityProfile;
  signal?: AbortSignal;
  events?: EventSink;
  /** Download progress of the files acquire() fetches. */
  onProgress?: (p: { entryId: string; received: number; total: number }) => void;
  /** Passed by the adapter to every acquire() it makes (see AcquireOptions.cacheOnly). */
  cacheOnly?: boolean;
}

export interface AdapterCapabilities {
  generate: boolean;
  embed: boolean;
  streaming: boolean;
}

/** 'webllm' runs on device 'webgpu' with tier 'webgpu-f32'; a q4f16 entry carries minProfile.backendTier 'webgpu-f16'. */
export type BackendAdapterId = 'webllm' | 'transformers-js' | 'chrome-prompt-api' | (string & {});

export interface BackendAdapter {
  readonly id: BackendAdapterId;
  /**
   * The minimum BackendTier the adapter needs: transformers-js on webgpu 'webgpu-f32' (a
   * descriptor may demand 'webgpu-f16' through minProfile), transformers-js on wasm 'wasm',
   * chrome-prompt-api 'none'.
   */
  readonly tier: BackendTier;
  readonly device: ExecutionDevice;
  /**
   * Where the engine runs: 'worker' (a dedicated module worker, R2w, R3w and R7 to R13) or 'main'
   * (the page's main thread). Absent on adapters that never run an engine (MockAdapter, the
   * Chrome built-in model), which report neither.
   */
  readonly host?: 'main' | 'worker';
  capabilities(): AdapterCapabilities;
  /** Cheap: no download and no model creation. */
  available(profile: CapabilityProfile): Promise<boolean>;
  /**
   * `entry` is the model descriptor's manifest entry (R1). Rejects with
   * AdapterError "unsupported_profile" if !satisfies(opts.profile, entry.minProfile), or if a file
   * entry's minProfile is not satisfied. Never fetches the network itself; holds every acquired
   * AssetHandle until unload().
   */
  load(entry: ManifestEntry, opts: LoadOptions): Promise<void>;
  generate(prompt: string | ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>;
  unload(): Promise<void>;
}

export type AdapterErrorCode =
  | 'not_loaded'
  | 'unsupported_profile'
  | 'unsupported_operation'
  | 'aborted'
  | 'backend'
  | 'unavailable'
  | 'bad_descriptor'
  | 'egress_refused'
  /** A file failed its SHA-256 check (at download or at the R2 re-hash): never used, never retried in one chain. */
  | 'integrity'
  /** The prompt leaves no room to generate: contextLength - promptTokens < 1 (R4b). Rejected before decode. */
  | 'context_overflow'
  /** cacheOnly was requested and the file is not stored in full, or the stored file disappeared. */
  | 'not_cached'
  /**
   * 0.5.0 (R18): an allocation failure inside the engine (a RangeError from WebAssembly.Memory.grow, or an
   * engine allocation error). Classified inside the worker into this code only; the worker is terminated, the
   * holds are released and there is no retry.
   */
  | 'out_of_memory';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
