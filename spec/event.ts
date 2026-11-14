/**
 * Event contract 0.1.2 (airplanemode.event/0.1; the wire string never changes on a patch).
 *
 * Normative JSON Schema: event.schema.json ($id urn:airplanemode:spec:event:0.1.2).
 *
 * 0.1.2 (wire-compatible, spec release 0.3.0): reserves asset.hold.unknown (S1-066), adds the reason
 * 'integrity' and the adapter 'webllm' to backend.select, adds loadId and host to model.load and
 * model.load.failed (whose code is now any AdapterErrorCode, including 'integrity' and
 * 'not_cached'), adds firstTokenMs and host to model.generate, and reserves model.load.phase,
 * memory.sample and backend.worker. It also names the storage.* events that localdata emits
 * (STORAGE_EVENT_NAMES). The schema body is unchanged: only its $id moves.
 *
 * 0.1.1 (wire-compatible): asset.quota documents usageSource, and the backend and model names
 * backend.select, backend.refused, backend.egress.refused, model.load, model.load.failed and
 * model.generate are reserved with their attrs. No event ever carries prompt text, output text or
 * an engine error message or stack (backend-adapter.md R5).
 *
 * One JSON event shape for logs, timings, memory, model-load and asset records. Every library
 * emits through an EventSink; no library ever has a network sink. The runtime's `newEvent()`
 * enforces the attrs rules in code (key pattern, 32-key cap, 1024-unit strings, query-string
 * stripping, forbidden key names).
 *
 * Privacy. No prompt, output, document text, storage key or value, storage prefix, engine message,
 * worker-provided string or stack ever appears in an event. The namespace (attr 'ns') and the
 * descriptor entry id (attr 'model') DO appear in events and in the DevTools snapshot.
 * Applications must not encode personal data or document identifiers in namespace names or entry
 * ids.
 */

export const EVENT_SPEC = 'airplanemode.event/0.1' as const;
export type EventSpec = typeof EVENT_SPEC;

export type EventKind = 'log' | 'timing' | 'memory' | 'model-load' | 'asset' | 'error';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventAttrValue = string | number | boolean | null;

/** Flat attributes: keys `^[A-Za-z][A-Za-z0-9_]{0,63}$`, at most 32, strings <= 1024 UTF-16 units. */
export type EventAttrs = Record<string, EventAttrValue>;

export interface Event {
  spec: EventSpec;
  /** UUID v4. */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** performance.now() at emission, when available. */
  mono?: number;
  /** Random id per page load; never persisted or user-derived. */
  session: string;
  /** `^[a-z0-9][a-z0-9.-]{0,63}$`: runtime, localdata, glyphsift, pagetriage, dockit or an app id. */
  source: string;
  kind: EventKind;
  /** `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)*$`, for example asset.download.progress. */
  name: string;
  level: EventLevel;
  durationMs?: number;
  bytes?: number;
  /** Never URLs with query strings, document text, prompts or user identifiers. */
  attrs: EventAttrs;
}

export interface EventSink {
  emit(e: Event): void;
}

/** Maximum number of attrs keys. */
export const EVENT_ATTRS_MAX_KEYS = 32;
/** Maximum length of a string attrs value in UTF-16 code units. */
export const EVENT_ATTR_STRING_MAX = 1024;
export const EVENT_ATTR_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)*$/;
export const EVENT_SOURCE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** Keys matching this are refused by newEvent() with a TypeError (always, not only in dev builds). */
export const EVENT_FORBIDDEN_KEY_PATTERN = /prompt|text|content|document|ua|userAgent/i;

/**
 * Event names reserved by the runtime asset manager, capability detector and manifest verifier.
 * Attrs documented beside each name.
 */
export const RUNTIME_EVENT_NAMES = Object.freeze([
  /** attrs: entryId, total */
  'asset.download.start',
  /** attrs: entryId, received, total, resumedFrom */
  'asset.download.progress',
  /** attrs: entryId, resumedFrom */
  'asset.download.resumed',
  /** attrs: entryId, reason: status-200 | content-range | part-mismatch | part-short | ignore-range */
  'asset.download.restarted',
  /** attrs: entryId, origin, reason: policy */
  'asset.download.blocked',
  /** attrs: entryId, total; durationMs */
  'asset.download.complete',
  /** attrs: entryId, sha256 */
  'asset.verify.ok',
  /** attrs: entryId, reason: hash_mismatch | size_changed | oversize */
  'asset.verify.failed',
  /** attrs: entryId, sha256, bytes, reason: quota | explicit */
  'asset.evict',
  /**
   * attrs: usage, quota, needed, usageSource. `usage` = max(estimate().usage, the manager's
   * accounted bytes of index rows plus in-flight parts) and `usageSource` names where that figure
   * came from: 'estimate' | 'accounted'. `quota` is the browser's navigator.storage.estimate().quota
   * (or the quotaBytes test override), not the limit the browser enforces: Chrome does not reflect
   * a per-origin quota override in estimate() and under-reports IndexedDB usage, so this number is
   * a planning estimate and the reactive QuotaExceededError path is the real guard.
   */
  'asset.quota',
  /** attrs: orphansRemoved, rowsDropped, stalePartsRemoved */
  'asset.reconcile',
  /** attrs: gpu, backendTier; durationMs */
  'capability.measured',
  /** attrs: manifestId, version */
  'manifest.verify.ok',
  /** attrs: manifestId, reason */
  'manifest.verify.failed',
  /**
   * kind log; level info (selected) or warn (anything else).
   * attrs: rung 'webgpu' | 'wasm' | 'builtin'; adapter (adapter id: 'transformers-js', 'webllm' or
   * 'chrome-prompt-api'); model (descriptor entry id, or '' when none); outcome 'selected' |
   * 'skipped' | 'failed' | 'declined'; reason 'ok' | 'no_webgpu' | 'tier_too_low' | 'profile' |
   * 'unavailable' | 'load_failed' | 'declined' | 'forced' | 'not_allowed' | 'integrity' (a file
   * failed its hash check; the rung that needs the same file is not retried).
   */
  'backend.select',
  /** kind error. attrs: attempts (integer), reasons (comma-joined reason codes, never engine text) */
  'backend.refused',
  /**
   * kind error. attrs: adapter, origin. `origin` is scheme://host[:port] for hierarchical URLs,
   * '<scheme>:' alone for data:, blob:, file: and other schemes, or '' when unparsable; never a
   * path or a query.
   */
  'backend.egress.refused',
  /**
   * kind model-load. attrs: adapter, model, device, dtype, files (integer), tier, verified
   * (boolean: true only for adapters that obey backend-adapter.md R2, false for
   * chrome-prompt-api), loadId (16 lowercase hex, random per load(); also on every
   * model.load.phase and memory.sample of that load), host ('worker' | 'main': where the engine
   * runs); top-level bytes and durationMs. MockAdapter keeps an entryId attr.
   */
  'model.load',
  /**
   * kind model-load; level error. attrs: adapter, model, device, code (any AdapterErrorCode,
   * including 'integrity' and 'not_cached'), loadId, host. The phases that completed before the
   * failure were already emitted as model.load.phase.
   */
  'model.load.failed',
  /**
   * kind timing. attrs: adapter, device, finishReason, inTokens, outTokens, tokensPerSecond,
   * prefillMs, decodeMs, firstTokenMs (number, or null when no token was produced), host; top-level
   * durationMs. Never the prompt or the output.
   */
  'model.generate',
  /**
   * kind asset; level warn. attrs: reason 'lock_state_unavailable'. Emitted once per asset manager
   * when the lock provider cannot say whether an asset is held, which counts as held (S1-066).
   */
  'asset.hold.unknown',
  /**
   * kind timing; level info. attrs: loadId, adapter, device, model, phase (a ModelLoadPhase:
   * acquire | verify | handoff | session | first_token), host ('worker' | 'main'). durationMs is
   * required. bytes: for acquire the bytes downloaded during this load (0 when every file was
   * cached), for verify the bytes re-hashed, for handoff the bytes given to the engine; absent for
   * session and first_token. Exactly one event per phase per successful load; first_token is
   * emitted on the first generate() after the load. On a failed load the completed phases are
   * emitted, then model.load.failed. Emitted by the main-thread host and by the worker host.
   */
  'model.load.phase',
  /**
   * kind memory; level info. attrs: loadId ('' when the sample belongs to no load), scope
   * 'page' | 'worker', at (a MemorySamplePoint: before_load | after_session | after_first_token |
   * on_demand), api 'performance.memory' | 'measureUserAgentSpecificMemory' | 'none', usedJsHeap,
   * totalJsHeap, jsHeapLimit, wasmMemory (each an integer number of bytes, or null). Top-level
   * bytes = usedJsHeap when it is known. The values are read from the browser, never estimated or
   * computed: every figure is null where the browser does not expose it (performance.memory is
   * Chrome-only, coarse and quantised, and absent in workers).
   */
  'memory.sample',
  /**
   * kind log; level info (warn when state is 'crashed'). attrs: adapter, device, state
   * ('started' | 'ready' | 'terminated' | 'crashed'), reason ('load' | 'unload' | 'load_failed' |
   * 'abort' | 'error'). durationMs is the spawn-to-ready time on state 'ready'.
   */
  'backend.worker',
] as const);

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

/** The five phases of a model load, in order (model.load.phase attrs.phase). */
export const MODEL_LOAD_PHASES = Object.freeze([
  'acquire',
  'verify',
  'handoff',
  'session',
  'first_token',
] as const);
export type ModelLoadPhase = (typeof MODEL_LOAD_PHASES)[number];

/** The points at which memory.sample is taken (memory.sample attrs.at). */
export const MEMORY_SAMPLE_POINTS = Object.freeze([
  'before_load',
  'after_session',
  'after_first_token',
  'on_demand',
] as const);
export type MemorySamplePoint = (typeof MEMORY_SAMPLE_POINTS)[number];

/**
 * Event names localdata emits (source 'localdata'), through an optional EventSink outside the
 * Storage API contract. The sink is called synchronously inside try/catch and never awaited. No
 * event carries a key, a prefix or a value; the namespace (attr 'ns') does appear.
 */
export const STORAGE_EVENT_NAMES = Object.freeze([
  /** kind timing. attrs: ns, driver 'opfs' | 'indexeddb' | 'memory', outcome 'ok' | StorageErrorCode; bytes; durationMs. */
  'storage.set',
  /** kind timing. attrs: ns, driver, outcome 'hit' | 'miss' | 'expired' | StorageErrorCode; bytes on a hit; durationMs. */
  'storage.get',
  /** kind timing. attrs: ns, driver, outcome 'removed' | 'absent' | StorageErrorCode; durationMs. */
  'storage.delete',
  /**
   * kind log; level warn on a refused set, otherwise debug. attrs: driver, ns ('' for all
   * namespaces), usage, quota (number or null), needed (0 when emitted by usage()).
   */
  'storage.quota',
] as const);

export type StorageEventName = (typeof STORAGE_EVENT_NAMES)[number];
