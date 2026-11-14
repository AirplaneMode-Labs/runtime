/**
 * Backend adapter contract 0.3.0 (see backend-adapter.md for prose).
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
  finishReason: 'stop' | 'length' | 'abort' | 'error';
  usage: { promptTokens?: number; completionTokens?: number };
  timings: {
    prefillMs?: number;
    decodeMs?: number;
    tokensPerSecond?: number;
    /** Milliseconds from the start of generate() to the first generated token; absent when none. */
    firstTokenMs?: number;
  };
}

export interface EmbedResult {
  vectors: Float32Array[];
  dims: number;
  normalized: boolean;
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
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<EmbedResult>;
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
  /** cacheOnly was requested and the file is not stored in full, or the stored file disappeared. */
  | 'not_cached';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
