/**
 * Chrome Prompt API adapter (backend adapter 0.2.0, rule R6): the browser's own model, opt-in and
 * outside the governance chain.
 *
 * The model is Google-controlled: it is not in the signed manifest, its bytes are never hash-verified
 * and its quality (Hindi included) is not under our control, so `model.load` carries `verified:
 * false`. This adapter never acquires an asset and ignores descriptors. `create()` is called only
 * when `availability()` is exactly 'available': in every other state (downloadable, downloading,
 * unavailable) `create()` would start a third-party model download, so load() rejects 'unavailable'
 * instead. The chain only asks for this rung when the caller passed `allowBuiltin: true`.
 */

import {
  AdapterError,
  type AdapterCapabilities,
  type BackendAdapter,
  type ChatMessage,
  type EmbedResult,
  type ExecutionDevice,
  type GenerateOptions,
  type GenerateResult,
  type LoadOptions,
} from '../../spec/backend-adapter';
import type { BackendTier, CapabilityProfile } from '../../spec/capability-profile';
import type { EventSink } from '../../spec/event';
import type { ManifestEntry } from '../../spec/manifest';
import { newEvent } from '../events';

/** The model id events carry for the built-in model. */
export const BUILTIN_MODEL_ID = 'browser-builtin';

/**
 * A placeholder passed to load() by the chain: the built-in model has no manifest entry, so this
 * object is never part of a manifest, never verified and never read by the adapter.
 */
export const BUILTIN_MODEL_ENTRY: ManifestEntry = Object.freeze({
  id: BUILTIN_MODEL_ID,
  kind: 'model',
  url: 'builtin:',
  sha256: '0'.repeat(64),
  size: 0,
  version: '0.0.0',
  licence: 'LicenseRef-browser-builtin',
  minProfile: Object.freeze({}),
}) as ManifestEntry;

// ---- the slice of the Prompt API we use ---------------------------------------------------------

export interface LanguageModelSessionLike {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

export interface LanguageModelLike {
  availability(options?: unknown): Promise<string>;
  create(options?: unknown): Promise<LanguageModelSessionLike>;
}

export interface ChromePromptAdapterOptions {
  /** Default: the page's global LanguageModel, read at call time. */
  languageModel?: LanguageModelLike | undefined;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function isAbortLike(e: unknown): boolean {
  return e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

function safeEmit(sink: EventSink | undefined, build: () => ReturnType<typeof newEvent>): void {
  if (!sink) return;
  try {
    sink.emit(build());
  } catch {
    // telemetry must never change the outcome
  }
}

export class ChromePromptAdapter implements BackendAdapter {
  readonly id = 'chrome-prompt-api';
  readonly tier: BackendTier = 'none';
  readonly device: ExecutionDevice = 'builtin';
  private readonly injected: LanguageModelLike | undefined;
  private session: LanguageModelSessionLike | undefined;
  private events: EventSink | undefined;

  constructor(opts: ChromePromptAdapterOptions = {}) {
    this.injected = opts.languageModel;
  }

  capabilities(): AdapterCapabilities {
    return { generate: true, embed: false, streaming: true };
  }

  private languageModel(): LanguageModelLike | undefined {
    if (this.injected) return this.injected;
    const lm = (globalThis as { LanguageModel?: LanguageModelLike }).LanguageModel;
    return lm && typeof lm.availability === 'function' && typeof lm.create === 'function'
      ? lm
      : undefined;
  }

  private async availability(): Promise<string> {
    const lm = this.languageModel();
    if (!lm) return 'unavailable';
    try {
      return await lm.availability();
    } catch {
      return 'unavailable';
    }
  }

  /** True only if LanguageModel exists and availability() === 'available'. */
  async available(_profile: CapabilityProfile): Promise<boolean> {
    return (await this.availability()) === 'available';
  }

  async load(_entry: ManifestEntry, opts: LoadOptions): Promise<void> {
    const t0 = now();
    await this.unload();
    const fail = (
      code: 'unavailable' | 'aborted' | 'backend',
      message: string,
      cause?: unknown,
    ) => {
      safeEmit(opts.events, () =>
        newEvent({
          source: 'runtime',
          kind: 'model-load',
          name: 'model.load.failed',
          level: 'error',
          attrs: { adapter: this.id, model: BUILTIN_MODEL_ID, device: this.device, code },
        }),
      );
      return new AdapterError(code, message, cause === undefined ? undefined : { cause });
    };
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'the load was aborted');
    const lm = this.languageModel();
    if (!lm || (await this.availability()) !== 'available')
      throw fail('unavailable', 'the browser has no built-in model ready to use');
    try {
      this.session = await lm.create();
    } catch (e) {
      throw fail('backend', 'the browser could not start its built-in model', e);
    }
    this.events = opts.events;
    safeEmit(opts.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'model-load',
        name: 'model.load',
        level: 'info',
        durationMs: Math.max(0, now() - t0),
        attrs: {
          adapter: this.id,
          model: BUILTIN_MODEL_ID,
          device: this.device,
          dtype: '',
          files: 0,
          tier: this.tier,
          verified: false,
        },
      }),
    );
  }

  async generate(
    prompt: string | ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const base = this.session;
    if (!base) throw new AdapterError('not_loaded', 'call load() first');
    if (opts.signal?.aborted) return { text: '', finishReason: 'abort', usage: {}, timings: {} };

    let input: string;
    let session = base;
    let temporary: LanguageModelSessionLike | undefined;
    const signalOpts = opts.signal ? { signal: opts.signal } : undefined;
    try {
      if (typeof prompt === 'string') input = prompt;
      else {
        let last = -1;
        prompt.forEach((m, i) => {
          if (m.role === 'user') last = i;
        });
        if (last < 0)
          throw new AdapterError('unsupported_operation', 'a chat needs a user message');
        input = prompt[last]!.content;
        const history = prompt.slice(0, last);
        if (history.length > 0) {
          // earlier turns and system messages become the initial prompts of a fresh session
          const lm = this.languageModel();
          if (!lm || (await this.availability()) !== 'available')
            throw new AdapterError('unavailable', 'the browser has no built-in model ready to use');
          temporary = await lm.create({
            initialPrompts: history.map((m) => ({ role: m.role, content: m.content })),
          });
          session = temporary;
        }
      }
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError('backend', 'the browser could not start its built-in model', {
        cause: e,
      });
    }

    const t0 = now();
    let text = '';
    let aborted = false;
    try {
      if (opts.onToken) {
        const reader = session.promptStreaming(input, signalOpts).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += value;
          try {
            opts.onToken(value);
          } catch {
            // a token listener must not break generation
          }
          if (opts.signal?.aborted) {
            aborted = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      } else {
        text = await session.prompt(input, signalOpts);
      }
    } catch (e) {
      if (isAbortLike(e) || opts.signal?.aborted) aborted = true;
      else throw new AdapterError('backend', 'the browser failed while generating', { cause: e });
    } finally {
      temporary?.destroy();
    }
    const elapsed = Math.max(0, now() - t0);
    const finishReason: GenerateResult['finishReason'] = aborted ? 'abort' : 'stop';
    safeEmit(this.events, () =>
      newEvent({
        source: 'runtime',
        kind: 'timing',
        name: 'model.generate',
        level: 'info',
        durationMs: elapsed,
        attrs: { adapter: this.id, device: this.device, finishReason, decodeMs: elapsed },
      }),
    );
    return { text, finishReason, usage: {}, timings: { decodeMs: elapsed } };
  }

  async embed(_texts: string[], _opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    throw new AdapterError(
      'unsupported_operation',
      'the built-in model does not produce embeddings',
    );
  }

  async unload(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    this.events = undefined;
    try {
      s?.destroy();
    } catch {
      // nothing to do: the session is gone either way
    }
  }
}

export function createChromePromptAdapter(
  opts: ChromePromptAdapterOptions = {},
): ChromePromptAdapter {
  return new ChromePromptAdapter(opts);
}
