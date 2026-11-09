/**
 * Backend adapter contract 0.1.0 (see backend-adapter.md for prose).
 *
 * One interface over WebLLM, Transformers.js and the Chrome Prompt API. Sprint 1 ships the
 * interface, AdapterError and a MockAdapter; real adapters are Sprint 2. An adapter never
 * fetches the network itself: every byte comes from an AssetSource (the runtime asset manager),
 * which only hands out fully verified files.
 */

import type { BackendTier, CapabilityProfile } from './capability-profile';
import type { EventSink } from './event';
import type { ManifestEntry } from './manifest';

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

export interface AssetSource {
  /** Verified assets only; rejects with AssetError not_verified otherwise. */
  getBlob(entryId: string, opts?: { rehash?: boolean }): Promise<Blob>;
  /** Optional object URL for the verified blob. */
  getUrl?(entryId: string): Promise<string>;
  getEntry(entryId: string): ManifestEntry;
  /** Refcounted handle; the adapter holds it until unload(). */
  acquire?(entryId: string): Promise<AssetHandle>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  maxTokens?: number;
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
  timings: { prefillMs?: number; decodeMs?: number; tokensPerSecond?: number };
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
}

export interface AdapterCapabilities {
  generate: boolean;
  embed: boolean;
  streaming: boolean;
}

export type BackendAdapterId = 'webllm' | 'transformers-js' | 'chrome-prompt-api' | (string & {});

export interface BackendAdapter {
  readonly id: BackendAdapterId;
  readonly tier: BackendTier;
  capabilities(): AdapterCapabilities;
  /**
   * Rejects with AdapterError "unsupported_profile" if !satisfies(opts.profile, entry.minProfile).
   * Never fetches the network itself; holds an acquired AssetHandle until unload().
   */
  load(entry: ManifestEntry, opts: LoadOptions): Promise<void>;
  generate(prompt: string | ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<EmbedResult>;
  unload(): Promise<void>;
}

export type AdapterErrorCode =
  'not_loaded' | 'unsupported_profile' | 'unsupported_operation' | 'aborted' | 'backend';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
