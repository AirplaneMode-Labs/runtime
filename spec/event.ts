/**
 * Event contract 0.1.5 (airplanemode.event/0.1; the wire string never changes on a patch).
 *
 * Normative JSON Schema: event.schema.json ($id urn:airplanemode:spec:event:0.1.5).
 *
 * 0.1.5 (wire-compatible, spec release 0.6.0; B1 memory hardening and the HNSW index kind): reserves
 * model.unload (RUNTIME_EVENT_NAMES, backend adapter R16); model.generate is emitted on a Stop after the first
 * token with finishReason 'abort' (a Stop after the first token) carrying outTokens and a numeric firstTokenMs
 * (S1-119), and when finishReason is 'error' it gains an optional attr code, an AdapterErrorCode;
 * model.load.failed code and model.embed outcome may be 'out_of_memory' (backend adapter R18);
 * STORAGE_EVENT_NAMES grows from 10 to 11 with storage.index.build (storage API 0.4.0); storage.query gains
 * the attrs requested, index, fallback and ef; storage.index.open gains the attr kind and, for a refused graph,
 * a reason; PIPELINE_REASONS gains 'stream_limit' and 'out_of_memory'; pipeline.answer outcome is one of
 * 'ok' | 'refused' | 'error' | 'aborted' (PIPELINE_ANSWER_OUTCOMES). No event carries text, keys, vectors,
 * worker or engine strings, or pagetriage notes. The schema body is unchanged: only its $id moves.
 *
 * 0.1.4 (wire-compatible, spec release 0.5.0): reserves model.embed and model.memory (RUNTIME_EVENT_NAMES);
 * model.generate gains the attr budget (an integer) and its finishReason may be 'abort'; the reason of
 * manifest.verify.failed may be 'unexpected_id' (manifest 0.1.2, expectId); the model.load.phase 'verify'
 * event is emitted by the worker host with host 'worker' and its bytes equal the total re-hashed in the
 * worker (backend adapter R15); STORAGE_EVENT_NAMES grows from 7 to 10 with storage.doc.put,
 * storage.doc.delete and storage.doc.query (documents API, storage API 0.3.0); and the application events
 * of the dockit pipeline are named: DOCKIT_EVENT_NAMES (source 'dockit'), PIPELINE_STAGES and
 * PIPELINE_REASONS. No event ever carries a file name, document id, title, page text, question, prompt or
 * answer. The schema body is unchanged: only its $id moves.
 *
 * 0.1.3 (wire-compatible, spec release 0.4.0): backend.egress.refused is re-specified so that no
 * worker-supplied string ever reaches an event (S1-074): attrs adapter (the host's own adapter id),
 * reporter ('main' | 'worker'), origin (new URL(x).origin computed by the page, or the fixed string
 * 'worker-reported') and, for a worker report, count. STORAGE_EVENT_NAMES grows from 4 to 7 with
 * storage.query, storage.index.open and storage.index.write (localdata vector index). The schema
 * body is unchanged: only its $id moves.
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
 * Privacy. No prompt, output, document text, storage key or value, storage prefix, query vector,
 * score, engine message, stack, or worker-provided string ever appears in an event: no
 * worker-provided string, without exception. The namespace (attr 'ns') and the descriptor entry id
 * (attr 'model') DO appear in events and in the DevTools snapshot. Applications must not encode
 * personal data or document identifiers in namespace names or entry ids.
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
  /**
   * attrs: manifestId, version, reason (a ManifestRejectReason, or 'state_unavailable'; 'unexpected_id'
   * since manifest 0.1.2, when the caller passed expectId and the validly signed manifest has another id).
   */
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
   * kind error. attrs: adapter, reporter, origin and, for a worker report, count (S1-074, Event 0.1.3).
   * `adapter` is the HOST's own adapter id ('transformers-js', 'webllm' or 'chrome-prompt-api'), never
   * a worker value. `reporter` is 'main' (the page's own guard refused a request) or 'worker' (the engine
   * worker's guard reported a refusal). For reporter 'main', `origin` is new URL(x).origin as the page
   * computes it: scheme://host[:port], or the string 'null' when the origin is opaque (data:, blob: of an
   * opaque origin, file:) or the URL does not parse; never a path or a query. For reporter 'worker',
   * `origin` is the fixed string 'worker-reported': the worker's text never enters an event. `count` is
   * the 1-based number of the worker-reported refusal within one loadId; at most 16 worker-reported
   * events are recorded per loadId and later ones are dropped. `count` is absent for reporter 'main'.
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
   * prefillMs, decodeMs, firstTokenMs (number, or null when no token was produced), host and, since
   * 0.1.4, budget (integer: the token budget of backend adapter R4b); finishReason may be 'abort' (Stop
   * after the first token); top-level durationMs. Never the prompt or the output.
   *
   * Since 0.1.5 (S1-119): a Stop after the first token emits exactly one model.generate with finishReason
   * 'abort', outTokens equal to the tokens delivered and a numeric firstTokenMs (a Stop before the first token
   * rejects 'aborted' and emits none); when finishReason is 'error' it gains an optional attr code, an
   * AdapterErrorCode (never an engine message).
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
  /**
   * kind timing; level info (warn when the outcome is not 'ok'). attrs: adapter, model, device, host
   * 'worker' | 'main', loadId, inputs (integer: the number of texts), truncated (integer: how many were
   * cut to the model's context), dims (integer), outcome 'ok' or an AdapterErrorCode; top-level durationMs.
   * Never the input text or a vector (backend adapter R14).
   */
  'model.embed',
  /**
   * kind memory; level info. attrs: adapter, host 'worker' | 'main', loadId, phase 'load' | 'generate' |
   * 'embed', measure 'wasm-memory' | 'unavailable'; top-level bytes = the peak WebAssembly.Memory
   * buffer.byteLength sampled every 50 ms inside the worker during that phase, omitted when measure is
   * 'unavailable'. Read from the engine's own memory object, never estimated.
   */
  'model.memory',
  /**
   * 0.1.5. kind model-load; level info (warn for reason 'error' and 'out_of_memory'). attrs: adapter, model,
   * device, host 'worker' | 'main', loadId, reason 'unload' | 'abort' | 'error' | 'out_of_memory'; top-level
   * durationMs runs from the unload() call to the worker's terminate() returning (backend adapter R16).
   * Emitted once per ended load, by the host, with the host's own values only: no worker or engine string.
   * model.load.failed code and model.embed outcome may be 'out_of_memory' (R18).
   */
  'model.unload',
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
 * event carries a key, a prefix, a query vector, a score or a value; the namespace (attr 'ns') does
 * appear. Seven names since Event 0.1.3, ten since 0.1.4 (the documents API of storage API 0.3.0), eleven since 0.1.5
 * (storage.index.build, the HNSW index kind of storage API 0.4.0).
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
  /**
   * kind timing; level debug, warn on failure. attrs: ns, driver 'opfs' | 'indexeddb' | 'memory' |
   * 'custom', outcome ('ok' or a StorageErrorCode), k, candidates (rows that matched the filter),
   * metric 'cosine' | 'dot', kernel 'simd' | 'scalar' | 'none'; durationMs. Never the query vector,
   * the filterPrefix, a key, a score or a value.
   *
   * Since 0.1.5 (storage API 0.4.0) also: requested 'flat' | 'hnsw', index 'flat' | 'hnsw' (the index that
   * answered), fallback '' | 'absent' | 'stale' | 'filter' | 'metric' | 'short' | 'refused' | 'trap' and ef (integer or
   * null). `requested` is QueryOptions.index as the caller gave it (default 'flat'); `fallback` is '' when the
   * index that answered is the one requested, otherwise why the flat scan answered a request for 'hnsw'; `ef`
   * is the effective ef of an hnsw answer and null for a flat one. 'short' (fix round 1) means the HNSW path returned fewer than
   * min(k, live rows) hits, so the flat scan answered.
   */
  'storage.query',
  /**
   * kind timing; level debug, warn when the index is corrupt. attrs: ns, driver, outcome ('ok' |
   * 'absent' | a StorageErrorCode), rows, segments, reason ('' or a corrupt reason code), kernel
   * 'simd' | 'scalar' | 'none'; bytes (index bytes) and durationMs.
   *
   * Since 0.1.5: kind 'flat' | 'hnsw' (which index file was opened) and, for a refused graph (kind 'hnsw'),
   * reason 'magic' | 'version' | 'length' | 'dim' | 'ns' | 'generation' | 'bounds' | 'links' | 'crc'.
   */
  'storage.index.open',
  /**
   * kind timing; level debug, warn on failure. attrs: ns, driver, outcome ('ok' or a StorageErrorCode),
   * rows (rows after the call), replaced (rows replaced by the call), segments; bytes and durationMs.
   */
  'storage.index.write',
  /**
   * kind timing; level debug, warn on failure. attrs: ns, driver, outcome ('ok' or a StorageErrorCode),
   * chunks (integer), replaced (boolean: the call replaced a document), rows (live chunk rows in ns after the
   * call); bytes, durationMs. Never docId, title, sha256, meta, chunk text, a vector or a score.
   */
  'storage.doc.put',
  /**
   * kind timing; level debug, warn on failure. attrs: ns, driver, outcome 'removed' | 'absent' |
   * StorageErrorCode; durationMs. Never the docId.
   */
  'storage.doc.delete',
  /**
   * kind timing; level debug, warn on failure. attrs: ns, driver, outcome ('ok' or a StorageErrorCode), k,
   * candidates (chunk rows that matched), metric 'cosine' | 'dot', kernel 'simd' | 'scalar' | 'none';
   * durationMs. Never the query vector, a docId, text or a score.
   *
   * Namespaces. The localdata SDK replaces any ns starting 'dockit.d' with the literal 'dockit.d*' in
   * event attrs. This is a normative SDK rule: a per-document ns prefix registered by the application with
   * redactNamespacePrefix(prefix) is emitted as prefix+'*', so a document id that a namespace carries
   * never reaches an event or the DevTools snapshot.
   */
  'storage.doc.query',
  /**
   * 0.1.5. kind timing; attrs: ns, kind 'hnsw', reason 'build' | 'rebuild' | 'replace', outcome 'ok' or a
   * StorageErrorCode, rows, liveRows, dim, m, efConstruction; top-level bytes = graph bytes written; durationMs;
   * level debug, warn on failure. 'build' is a buildIndex() call on a namespace without a graph, 'replace' one
   * over an existing graph, 'rebuild' the SDK's rebuild of a refused graph (storage API 0.4.0). Never a key, a
   * vector, a score or the seed.
   */
  'storage.index.build',
] as const);

export type StorageEventName = (typeof STORAGE_EVENT_NAMES)[number];

/**
 * Event names of the dockit reference application (source 'dockit'), emitted through the same EventSink.
 * Attrs documented beside each name. No event ever carries a file name, document id, title, page text,
 * question, prompt or answer: the attrs are enums, counts and numbers.
 */
export const DOCKIT_EVENT_NAMES = Object.freeze([
  /**
   * kind timing. attrs: stage (a PipelineStage), outcome 'ok' | 'refused' | 'error' | 'skipped', reason
   * ('' or a PipelineReason), pages, chunks, held (integers; 0 where a stage has no such count);
   * durationMs, bytes.
   */
  'pipeline.stage',
  /**
   * kind timing. attrs: outcome, reason, k, sources, budget (integers), firstTokenMs (number or null),
   * unknownCitations (integer: citations the model invented that matched no retrieved chunk); durationMs.
   * Since 0.1.5: outcome 'ok' | 'refused' | 'error' | 'aborted' (PIPELINE_ANSWER_OUTCOMES; 'aborted' is a Stop,
   * S1-119); reason may be 'stream_limit' or 'out_of_memory'. No event carries text, keys, vectors, worker or
   * engine strings, or pagetriage notes.
   */
  'pipeline.answer',
  /**
   * kind memory. attrs: worker 'analysis', stage, measure 'wasm-memory' | 'unavailable'; bytes = the peak
   * wasm-bindgen memory.buffer.byteLength in the analysis worker.
   */
  'pipeline.memory',
] as const);

export type DockitEventName = (typeof DOCKIT_EVENT_NAMES)[number];

/** The stages of the dockit pipeline, in order (pipeline.stage attrs.stage). */
export const PIPELINE_STAGES = Object.freeze([
  'read',
  'triage',
  'extract',
  'gate',
  'chunk',
  'embed',
  'index',
  'retrieve',
  'generate',
] as const);
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Why a pipeline stage or answer was refused, skipped or failed (attrs.reason; '' when there is none). */
export const PIPELINE_REASONS = Object.freeze([
  'not_pdf',
  'too_large',
  'too_many_pages',
  'encrypted',
  'corrupt',
  'no_text_layer',
  'timeout',
  'model_not_cached',
  'manifest_refused',
  'integrity',
  'unsupported_profile',
  'context_overflow',
  'no_index',
  'ocr_not_yet',
  'legacy_encoding',
  'not_analysed',
  'held_low_score',
  'framed',
  /** 0.1.5: pagetriage stream accounting (pagetriage.streams/0.1) refused the document before pdf.js ran (S1-107). */
  'stream_limit',
  /** 0.1.5: the engine ran out of memory (backend adapter R18), or the memory line refused the load (TD-67). */
  'out_of_memory',
] as const);
export type PipelineReason = (typeof PIPELINE_REASONS)[number];

/** 0.1.5: the outcomes of a pipeline.answer event (attrs.outcome). 'aborted' is a Stop (S1-119). */
export const PIPELINE_ANSWER_OUTCOMES = Object.freeze([
  'ok',
  'refused',
  'error',
  'aborted',
] as const);
export type PipelineAnswerOutcome = (typeof PIPELINE_ANSWER_OUTCOMES)[number];
