/**
 * Event contract 0.1.0 (airplanemode.event/0.1).
 *
 * Normative JSON Schema: event.schema.json ($id urn:airplanemode:spec:event:0.1.0).
 *
 * One JSON event shape for logs, timings, memory, model-load and asset records. Every library
 * emits through an EventSink; no library ever has a network sink. The runtime's `newEvent()`
 * enforces the attrs rules in code (key pattern, 32-key cap, 1024-unit strings, query-string
 * stripping, forbidden key names).
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
   * attrs: usage, quota, needed. `quota` is the browser's navigator.storage.estimate().quota (or
   * the quotaBytes test override), not the limit the browser enforces: Chrome does not reflect a
   * per-origin quota override in estimate() and under-reports IndexedDB usage, so this number is
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
] as const);

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];
