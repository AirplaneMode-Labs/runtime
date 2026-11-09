/**
 * The fallback chain (backend adapter 0.2.0): WebGPU, then WebAssembly, then the Chrome built-in
 * model, then refuse with a plain-language message.
 *
 * Per rung, per adapter, per model (descriptor entry id, in the caller's order) the chain records an
 * attempt: 'skipped' (the device or the profile rules the rung out, the rung is above forceRung, or
 * the built-in rung was not enabled), 'declined' (the download needs consent that was not given),
 * 'failed' (the adapter threw something other than an abort; it is unloaded and every handle it held
 * is released) or 'selected' (the first success). Every attempt emits backend.select. An abort
 * propagates without trying lower rungs; exhaustion emits backend.refused and throws
 * BackendRefusedError.
 *
 * Consent is per rung and cache-only by default. `bytes` is what the store does not already hold
 * verified for that model; with no `beforeDownload` any download is declined, so nothing is fetched
 * unless the caller says yes, and the question is asked again for every rung with that rung's own
 * count. The chain cannot read a descriptor it has not downloaded, so for a model whose descriptor is
 * not yet in the store the count is an upper bound: every manifest entry not yet verified. The
 * Chrome built-in rung runs only when `allowBuiltin` is true; otherwise it is skipped and
 * LanguageModel.availability() and create() are never called (R6).
 *
 * Everything user-facing is built from the enums below, never from engine text (R5).
 *
 * Honest fallback (T1-S2-01). An adapter that can tell that its engine module can no longer create a
 * session in this page (the transformers adapters, once a load failed after the weights were read)
 * exposes engineBlocked(). The chain asks it before it plans or asks consent for a rung: such a rung is
 * recorded as failed with reason 'load_failed' without a download question and without a load, and the
 * refusal message adds one sentence telling the user to reload the page and choose WebAssembly.
 *
 * Consent (S1-053, interim). A file counts as present only when the store holds a verified row AND a
 * stored file of exactly the manifest size; anything else counts toward the rung's bytes, so
 * beforeDownload is asked (or the rung is declined in cache-only mode). 'Nothing was downloaded' is
 * said only when no asset.download.start was observed (on the asset source's event bus or the chain's
 * own sink); when the chain can observe neither, an approval keeps the claim off. Enforcing cache-only
 * inside acquire() (AcquireOptions.cacheOnly) is a Sprint 3 backend-adapter minor.
 */

import {
  AdapterError,
  type AssetSource,
  type BackendAdapter,
  type LoadOptions,
} from '../../spec/backend-adapter';
import { BACKEND_TIER_RANK, type CapabilityProfile } from '../../spec/capability-profile';
import type { Event, EventSink } from '../../spec/event';
import type { ManifestEntry } from '../../spec/manifest';
import { MODEL_DESCRIPTOR_MEDIA_TYPE } from '../../spec/model-descriptor';
import { AssetError } from '../errors';
import { newEvent } from '../events';
import { satisfies } from '../satisfies';
import { BUILTIN_MODEL_ENTRY, createChromePromptAdapter } from './chrome-prompt';
import { parseDescriptor } from './descriptor';
import { createTransformersAdapter, type SessionOptions } from './transformers';

export type Rung = 'webgpu' | 'wasm' | 'builtin';
export type AttemptOutcome = 'selected' | 'skipped' | 'failed' | 'declined';
export type AttemptReason =
  | 'ok'
  | 'no_webgpu'
  | 'tier_too_low'
  | 'profile'
  | 'unavailable'
  | 'load_failed'
  | 'declined'
  | 'forced'
  | 'not_allowed';

export interface Attempt {
  rung: Rung;
  adapter: string;
  /** Descriptor entry id, or null when the attempt did not concern one (a whole rung, the built-in model). */
  model: string | null;
  outcome: AttemptOutcome;
  reason: AttemptReason;
}

/** An AssetSource that can also say what it already holds and list its manifest (AssetManager can). */
export interface ChainAssets extends AssetSource {
  has?(entryId: string): Promise<boolean>;
  /**
   * Bytes of the file the store holds for the entry, or undefined when there is none. Reads no bytes
   * and downloads nothing. A source without it cannot show that a file is intact, so the chain counts
   * every file as missing (S1-053).
   */
  storedSize?(entryId: string): Promise<number | undefined>;
  readonly manifest?: { readonly entries: readonly ManifestEntry[] } | undefined;
  /** The source's event bus, when it has one (AssetManager does): watched for asset.download.start. */
  readonly events?: { subscribe?(listener: (e: Event) => void): () => void } | undefined;
}

/**
 * Optional extension of a BackendAdapter: true while the adapter's engine can no longer create a
 * session in this page. The transformers adapters implement it; the chain never requires it.
 */
export interface EngineStateProbe {
  engineBlocked(): boolean;
}

export interface LoadWithFallbackOptions {
  profile: CapabilityProfile;
  assets: ChainAssets;
  /** Descriptor entry ids in preference order. */
  models: string[];
  /** Adapters the rungs use: see createDefaultAdapters(). */
  adapters?: BackendAdapter[];
  /** Start at this rung; rungs above it are recorded as forced and the chain never moves up. */
  forceRung?: Rung;
  /** The Chrome built-in model is opt-in. Default false. */
  allowBuiltin?: boolean;
  /** Consent for a download, asked per rung with that rung's own byte count. Absent: cache-only. */
  beforeDownload?: (info: { rung: Rung; model: string; bytes: number }) => Promise<boolean>;
  events?: EventSink | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: LoadOptions['onProgress'] | undefined;
}

export interface LoadWithFallbackResult {
  adapter: BackendAdapter;
  rung: Rung;
  /** The descriptor entry id that loaded; null for the built-in model. */
  model: string | null;
  attempts: Attempt[];
}

const RUNGS: readonly Rung[] = ['webgpu', 'wasm', 'builtin'];
const DEFAULT_ADAPTER_ID: Readonly<Record<Rung, string>> = {
  webgpu: 'transformers-js',
  wasm: 'transformers-js',
  builtin: 'chrome-prompt-api',
};

const RUNG_LABEL: Readonly<Record<Rung, string>> = {
  webgpu: 'WebGPU',
  wasm: 'WebAssembly',
  builtin: 'Chrome built-in model',
};

/** The one sentence added when a rung was refused because its engine can no longer start a session. */
export const RELOAD_SENTENCE = 'Reload the page and choose WebAssembly to try again.';

const REASON_TEXT: Readonly<Record<AttemptReason, string>> = {
  ok: 'ready',
  no_webgpu: 'not available on this device',
  tier_too_low: 'this device is too limited for it',
  profile: 'the model needs more than this device offers',
  unavailable: 'not available right now',
  load_failed: 'could not be started',
  declined: 'the download was not approved',
  forced: 'skipped because a lower option was chosen',
  not_allowed: 'not enabled',
};

export class BackendRefusedError extends AdapterError {
  override readonly name = 'AdapterError';
  readonly attempts: readonly Attempt[];
  /** Plain language, built only from the rung and reason enums. */
  readonly userMessage: string;

  constructor(attempts: Attempt[], userMessage: string) {
    super('unavailable', userMessage);
    this.attempts = Object.freeze(attempts.map((a) => ({ ...a })));
    this.userMessage = userMessage;
  }
}

/** transformers-js on webgpu, transformers-js on wasm, chrome-prompt-api, in that order. */
export function createDefaultAdapters(opts: {
  ortFactoryUrl: string;
  verifiedPrefix?: string;
  /** Passed to both engine adapters; see TransformersAdapterOptions.sessionOptions. */
  sessionOptions?: SessionOptions;
}): BackendAdapter[] {
  const common = {
    ortFactoryUrl: opts.ortFactoryUrl,
    ...(opts.verifiedPrefix !== undefined ? { verifiedPrefix: opts.verifiedPrefix } : {}),
    ...(opts.sessionOptions !== undefined ? { sessionOptions: opts.sessionOptions } : {}),
  };
  return [
    createTransformersAdapter({ ...common, device: 'webgpu' }),
    createTransformersAdapter({ ...common, device: 'wasm' }),
    createChromePromptAdapter(),
  ];
}

function isAbort(e: unknown): boolean {
  if (e instanceof AdapterError) return e.code === 'aborted';
  if (e instanceof AssetError) return e.code === 'aborted';
  return e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

function isEngineBlocked(adapter: BackendAdapter): boolean {
  const probe = adapter as Partial<EngineStateProbe>;
  try {
    return typeof probe.engineBlocked === 'function' && probe.engineBlocked() === true;
  } catch {
    return false;
  }
}

/** Why an adapter that said "not available" was skipped: from the profile first, else the device. */
function skipReason(
  rung: Rung,
  adapter: BackendAdapter | undefined,
  p: CapabilityProfile,
): AttemptReason {
  if (rung === 'webgpu') {
    if (p.gpu !== 'webgpu') return 'no_webgpu';
    const needed = adapter?.tier ?? 'webgpu-f32';
    if (BACKEND_TIER_RANK[p.backendTier] < BACKEND_TIER_RANK[needed]) return 'tier_too_low';
    return 'unavailable'; // the profile fits but no device could be created (T1-S2-01)
  }
  if (rung === 'wasm') return 'tier_too_low';
  return 'unavailable';
}

/** Watches for asset.download.start so that 'Nothing was downloaded' is a fact, not a guess (S1-053). */
function watchDownloads(opts: LoadWithFallbackOptions): {
  approved(): void;
  mayHaveDownloaded(): boolean;
  stop(): void;
} {
  let started = false;
  let approvedAny = false;
  let observable = false;
  const unsubscribe: (() => void)[] = [];
  const watch = (e: Event): void => {
    if (e.name === 'asset.download.start') started = true;
  };
  for (const bus of [opts.events, opts.assets.events] as const) {
    const subscribe = (bus as { subscribe?: (l: (e: Event) => void) => () => void } | undefined)
      ?.subscribe;
    if (typeof subscribe !== 'function') continue;
    try {
      unsubscribe.push(subscribe.call(bus, watch));
      observable = true;
    } catch {
      // a bus that refuses a listener cannot be observed
    }
  }
  return {
    approved: () => {
      approvedAny = true;
    },
    // observed: a download started or it did not; unobserved: an approval is the only evidence there is
    mayHaveDownloaded: () => (observable ? started : approvedAny),
    stop: () => {
      for (const u of unsubscribe.splice(0)) {
        try {
          u();
        } catch {
          // best effort
        }
      }
    },
  };
}

function userMessageOf(attempts: Attempt[], mayHaveDownloaded: boolean, reload: boolean): string {
  const lines: string[] = [];
  for (const rung of RUNGS) {
    const reasons = [
      ...new Set(attempts.filter((a) => a.rung === rung).map((a) => REASON_TEXT[a.reason])),
    ];
    if (reasons.length > 0) lines.push(`${RUNG_LABEL[rung]}: ${reasons.join(', ')}.`);
  }
  return [
    'No model could be started on this device.',
    ...lines,
    ...(reload ? [RELOAD_SENTENCE] : []),
    ...(mayHaveDownloaded ? [] : ['Nothing was downloaded.']),
  ].join(' ');
}

export async function loadWithFallback(
  opts: LoadWithFallbackOptions,
): Promise<LoadWithFallbackResult> {
  if (!opts.adapters || opts.adapters.length === 0)
    throw new TypeError(
      'loadWithFallback needs adapters: use createDefaultAdapters({ ortFactoryUrl })',
    );
  const downloads = watchDownloads(opts);
  try {
    return await runChain(opts, opts.adapters, downloads);
  } finally {
    downloads.stop();
  }
}

async function runChain(
  opts: LoadWithFallbackOptions,
  adapters: BackendAdapter[],
  downloads: ReturnType<typeof watchDownloads>,
): Promise<LoadWithFallbackResult> {
  const attempts: Attempt[] = [];
  let reloadAdvice = false;

  const record = (a: Attempt): void => {
    attempts.push(a);
    if (!opts.events) return;
    try {
      opts.events.emit(
        newEvent({
          source: 'runtime',
          kind: 'log',
          name: 'backend.select',
          level: a.outcome === 'selected' ? 'info' : 'warn',
          attrs: {
            rung: a.rung,
            adapter: a.adapter,
            model: a.model ?? '',
            outcome: a.outcome,
            reason: a.reason,
          },
        }),
      );
    } catch {
      // telemetry must never change the outcome
    }
  };
  const throwIfAborted = (): void => {
    if (opts.signal?.aborted) throw new AdapterError('aborted', 'the load was aborted');
  };

  const tryLoad = async (
    rung: Rung,
    adapter: BackendAdapter,
    entry: ManifestEntry,
    model: string | null,
  ): Promise<LoadWithFallbackResult | undefined> => {
    const loadOpts: LoadOptions = { assets: opts.assets, profile: opts.profile };
    if (opts.signal) loadOpts.signal = opts.signal;
    if (opts.events) loadOpts.events = opts.events;
    if (opts.onProgress) loadOpts.onProgress = opts.onProgress;
    try {
      await adapter.load(entry, loadOpts);
    } catch (e) {
      await adapter.unload().catch(() => undefined);
      if (isAbort(e))
        throw e instanceof Error ? e : new AdapterError('aborted', 'the load was aborted');
      const reason: AttemptReason =
        e instanceof AdapterError && e.code === 'unsupported_profile' ? 'profile' : 'load_failed';
      record({
        rung,
        adapter: adapter.id,
        model,
        outcome: reason === 'profile' ? 'skipped' : 'failed',
        reason,
      });
      return undefined;
    }
    record({ rung, adapter: adapter.id, model, outcome: 'selected', reason: 'ok' });
    return { adapter, rung, model, attempts };
  };

  throwIfAborted();
  const start = opts.forceRung ? RUNGS.indexOf(opts.forceRung) : 0;

  for (const rung of RUNGS) {
    throwIfAborted();
    const forRung = adapters.filter((a) => a.device === rung);
    const onRung = forRung.length > 0 ? forRung : [undefined];

    if (RUNGS.indexOf(rung) < start) {
      for (const a of onRung)
        record({
          rung,
          adapter: a?.id ?? DEFAULT_ADAPTER_ID[rung],
          model: null,
          outcome: 'skipped',
          reason: 'forced',
        });
      continue;
    }
    if (rung === 'builtin' && opts.allowBuiltin !== true) {
      // R6: availability() and create() are never called when the rung is not enabled
      for (const a of onRung)
        record({
          rung,
          adapter: a?.id ?? DEFAULT_ADAPTER_ID[rung],
          model: null,
          outcome: 'skipped',
          reason: 'not_allowed',
        });
      continue;
    }

    for (const adapter of onRung) {
      const adapterId = adapter?.id ?? DEFAULT_ADAPTER_ID[rung];
      if (!adapter || !(await adapter.available(opts.profile))) {
        record({
          rung,
          adapter: adapterId,
          model: null,
          outcome: 'skipped',
          reason: skipReason(rung, adapter, opts.profile),
        });
        continue;
      }
      if (isEngineBlocked(adapter)) {
        // T1-S2-01: no consent question and no load for an engine that cannot create a session
        record({ rung, adapter: adapterId, model: null, outcome: 'failed', reason: 'load_failed' });
        reloadAdvice = true;
        continue;
      }
      throwIfAborted();

      if (rung === 'builtin') {
        const outcome = await tryLoad(rung, adapter, BUILTIN_MODEL_ENTRY, null);
        if (outcome) return outcome;
        continue;
      }

      for (const modelId of opts.models) {
        throwIfAborted();
        let entry: ManifestEntry;
        try {
          entry = opts.assets.getEntry(modelId);
        } catch {
          record({
            rung,
            adapter: adapterId,
            model: modelId,
            outcome: 'failed',
            reason: 'load_failed',
          });
          continue;
        }
        if (!satisfies(opts.profile, entry.minProfile)) {
          record({
            rung,
            adapter: adapterId,
            model: modelId,
            outcome: 'skipped',
            reason: 'profile',
          });
          continue;
        }
        const plan = await planDownload(opts.assets, entry);
        if (plan.mismatch(adapter)) {
          record({
            rung,
            adapter: adapterId,
            model: modelId,
            outcome: 'skipped',
            reason: 'profile',
          });
          continue;
        }
        if (plan.bytes > 0) {
          const approved = opts.beforeDownload
            ? await opts.beforeDownload({ rung, model: modelId, bytes: plan.bytes })
            : false;
          if (!approved) {
            record({
              rung,
              adapter: adapterId,
              model: modelId,
              outcome: 'declined',
              reason: 'declined',
            });
            continue;
          }
          downloads.approved();
        }
        throwIfAborted();
        const outcome = await tryLoad(rung, adapter, entry, modelId);
        if (outcome) return outcome;
      }
    }
  }

  const reasons = attempts.map((a) => a.reason).join(',');
  if (opts.events) {
    try {
      opts.events.emit(
        newEvent({
          source: 'runtime',
          kind: 'error',
          name: 'backend.refused',
          level: 'error',
          attrs: { attempts: attempts.length, reasons },
        }),
      );
    } catch {
      // telemetry must never change the outcome
    }
  }
  throw new BackendRefusedError(
    attempts,
    userMessageOf(attempts, downloads.mayHaveDownloaded(), reloadAdvice),
  );
}

interface DownloadPlan {
  /** Bytes the store does not hold verified for this model (an upper bound when not exact). */
  bytes: number;
  /** True when the descriptor was readable and the count is exact. */
  exact: boolean;
  /** True when the (cached) descriptor says it is not for this adapter. */
  mismatch(adapter: BackendAdapter): boolean;
}

/** What loading `entry` would download. Reads only what is already in the store; never the network. */
async function planDownload(assets: ChainAssets, entry: ManifestEntry): Promise<DownloadPlan> {
  // S1-053: present means a verified row AND a stored file of exactly the manifest size. Anything
  // else (row without file, truncated file, a source that cannot tell) counts toward the bytes.
  const present = async (e: ManifestEntry): Promise<boolean> => {
    try {
      if (typeof assets.has !== 'function' || typeof assets.storedSize !== 'function') return false;
      if (!(await assets.has(e.id))) return false;
      return (await assets.storedSize(e.id)) === e.size;
    } catch {
      return false;
    }
  };
  const sum = async (entries: readonly ManifestEntry[]): Promise<number> => {
    let n = 0;
    for (const e of entries) if (!(await present(e))) n += e.size;
    return n;
  };

  if (await present(entry)) {
    try {
      const blob = await assets.getBlob(entry.id, { rehash: true });
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
      const descriptor = parseDescriptor(text);
      const files = descriptor.files.map((f) => assets.getEntry(f.entryId));
      return {
        bytes: await sum(files),
        exact: true,
        mismatch: (adapter) =>
          descriptor.engine !== adapter.id ||
          (adapter.device !== 'builtin' && !descriptor.devices.includes(adapter.device)),
      };
    } catch {
      // unreadable or invalid: fall through to the upper bound; the adapter reports the real problem
    }
  }
  const all = assets.manifest?.entries;
  const candidates = all
    ? all.filter((e) => e.id === entry.id || e.mediaType !== MODEL_DESCRIPTOR_MEDIA_TYPE)
    : [entry];
  return { bytes: await sum(candidates), exact: false, mismatch: () => false };
}
