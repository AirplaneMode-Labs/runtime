/**
 * MockAdapter: the Sprint 1 stand-in for real backends. Echo generation (streams the prompt back
 * token by token) and deterministic 64-dimension embeddings hashed from the text. Used by tests
 * and dockit stubs; it never touches the network and holds an AssetHandle like a real adapter.
 */

import {
  AdapterError,
  type AdapterCapabilities,
  type AssetHandle,
  type BackendAdapter,
  type ChatMessage,
  type EmbedResult,
  type GenerateOptions,
  type GenerateResult,
  type LoadOptions,
} from '../../spec/backend-adapter';
import type { BackendTier } from '../../spec/capability-profile';
import type { ManifestEntry } from '../../spec/manifest';
import { newEvent } from '../events';
import { satisfies } from '../satisfies';
import { sha256 } from '../sha256';

export const MOCK_EMBEDDING_DIMS = 64;

export class MockAdapter implements BackendAdapter {
  readonly id = 'mock';
  readonly tier: BackendTier = 'none';
  private entry: ManifestEntry | undefined;
  private handle: AssetHandle | undefined;

  capabilities(): AdapterCapabilities {
    return { generate: true, embed: true, streaming: true };
  }

  async load(entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    if (!satisfies(opts.profile, entry.minProfile)) {
      throw new AdapterError(
        'unsupported_profile',
        `entry ${entry.id} needs ${JSON.stringify(entry.minProfile)}`,
      );
    }
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'load aborted');
    const t0 = now();
    await this.unload();
    if (typeof opts.assets.acquire === 'function') {
      this.handle = await opts.assets.acquire(entry.id);
    }
    this.entry = entry;
    opts.events?.emit(
      newEvent({
        source: 'runtime',
        kind: 'model-load',
        name: 'model.load',
        level: 'info',
        durationMs: Math.max(0, now() - t0),
        attrs: { adapter: this.id, entryId: entry.id, tier: this.tier },
      }),
    );
  }

  async generate(
    prompt: string | ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    this.requireLoaded();
    const t0 = now();
    const source = typeof prompt === 'string' ? prompt : lastUserContent(prompt);
    const pieces = source.split(/(\s+)/).filter((p) => p.length > 0);
    let text = '';
    let words = 0;
    let finishReason: GenerateResult['finishReason'] = 'stop';
    for (const piece of pieces) {
      if (opts.signal?.aborted) {
        finishReason = 'abort';
        break;
      }
      const isWord = !/^\s+$/.test(piece);
      if (isWord && opts.maxTokens !== undefined && words >= opts.maxTokens) {
        finishReason = 'length';
        break;
      }
      if (!isWord && opts.maxTokens !== undefined && words >= opts.maxTokens) {
        // Do not emit a trailing separator once the budget is spent.
        finishReason = 'length';
        break;
      }
      text += piece;
      if (isWord) words++;
      opts.onToken?.(piece);
      if (opts.stop?.some((s) => s.length > 0 && text.endsWith(s))) break;
    }
    const decodeMs = Math.max(0, now() - t0);
    const timings: GenerateResult['timings'] = { prefillMs: 0, decodeMs };
    if (decodeMs > 0) timings.tokensPerSecond = (words / decodeMs) * 1000;
    return {
      text,
      finishReason,
      usage: { promptTokens: countWords(source), completionTokens: words },
      timings,
    };
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<EmbedResult> {
    this.requireLoaded();
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'embed aborted');
    const enc = new TextEncoder();
    const vectors = texts.map((t) => {
      const d1 = sha256(enc.encode(t));
      const d2 = sha256(d1);
      const v = new Float32Array(MOCK_EMBEDDING_DIMS);
      let norm = 0;
      for (let i = 0; i < MOCK_EMBEDDING_DIMS; i++) {
        const b = i < 32 ? d1[i]! : d2[i - 32]!;
        const x = (b / 255) * 2 - 1;
        v[i] = x;
        norm += x * x;
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < MOCK_EMBEDDING_DIMS; i++) v[i] = v[i]! / norm;
      return v;
    });
    return { vectors, dims: MOCK_EMBEDDING_DIMS, normalized: true };
  }

  async unload(): Promise<void> {
    this.handle?.release();
    this.handle = undefined;
    this.entry = undefined;
  }

  private requireLoaded(): void {
    if (!this.entry) throw new AdapterError('not_loaded', 'call load() first');
  }
}

function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return messages.map((m) => m.content).join('\n');
}

function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
