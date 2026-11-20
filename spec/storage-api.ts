/**
 * Storage API contract 0.4.1 (draft; normative; see storage-api.md for prose).
 *
 * Implemented by @airplanemode/localdata over OPFS with an IndexedDB fallback. The SDK does
 * validation, codec and quota accounting above a StorageDriver.
 *
 * 0.4.1 (wording patch, spec release 0.6.1; TD-109, TD-110, TD-111): no type, constant or method changes.
 * At HNSW_MAX_GRAPHS resident graphs, buildIndex first releases the in-memory instance (never the stored bytes) of
 * the least-recently-used idle graph: no operation running or queued, and not being built. That is the TD-94 rule.
 * It throws max_graphs only when every resident graph is busy. dropIndex frees a slot only if the graph was resident.
 * Format: a graph refused for an older internal format (reason 'version') is rebuilt from the stored vectors at most once per
 * generation, guarded by a persisted marker; the rebuild goes through the same quota, max_index_bytes and wasm_memory
 * refusals as a fresh build. Params: a stored graph whose header params differ from the stored params record is refused
 * (reason 'params') before any reservation.
 *
 * 0.4.0 (minor, spec release 0.6.0) adds the approximate vector index (HNSW), with the index kind chosen by
 * the caller: `buildIndex()` and `dropIndex()`, `QueryOptions.index` and `QueryOptions.ef`,
 * `VectorIndexInfo.ann`, `UsageResult.annBytes`, the types `VectorIndexKind = 'flat' | 'hnsw'`,
 * `BuildIndexOptions`, `BuildIndexResult` and `AnnIndexInfo`, and the constants HNSW_M_MIN, HNSW_M_MAX,
 * HNSW_M_DEFAULT, HNSW_EF_CONSTRUCTION_DEFAULT, HNSW_EF_CONSTRUCTION_MAX, HNSW_EF_MAX, HNSW_EF_DEFAULT_MIN,
 * HNSW_MAX_LEVEL and ANN_NS_PREFIX = '__ld_ann.'. Flat stays the default and the fallback: a query that asks
 * for 'hnsw' and cannot be answered by a current, valid graph answers with the flat scan and reports why in
 * the event. HNSW hits are re-scored with the exact flat scoring function from the stored vectors, so a
 * crafted graph can only lower recall. Nothing of 0.3.0 changes (storage-api.md, Approximate index (0.4.0)).
 *
 * 0.3.0 (minor, spec release 0.5.0) adds the documents API for the dockit pipeline: `putDocument()`,
 * `getDocument()`, `listDocuments()`, `deleteDocument()`, `queryChunks()` and `redactNamespacePrefix()`, the
 * types `DocumentInput`, `DocumentInfo`, `ChunkInput`, `PutDocumentResult`, `ChunkHit` and
 * `QueryChunksOptions`, the constants DOC_ID_PATTERN, DOC_TITLE_MAX, DOC_META_KEYS_MAX,
 * CHUNK_TEXT_UTF8_MAX, DOC_CHUNKS_MAX, CHUNK_GATE_KEYS_MAX and DOC_QUERY_K_MAX, and `UsageResult.documents`.
 * Document data lives in the SDK-reserved driver namespace '__ld_doc.' + ns, apart from the key-value
 * data and the generic vector index of ns. putDocument is ALL-OR-NOTHING; `clear(ns)` MUST physically
 * remove every file or record of the document namespace (storage-api.md, Documents (0.3.0)). Nothing of
 * 0.2.0 changes.
 *
 * 0.2.0 (minor, spec release 0.4.0) implements `query()` and adds the vector index API: `putVectors()`,
 * `indexInfo()`, `VectorRow`, `VectorMetric`, `QueryOptions.metric` and `values`, the error code
 * 'corrupt', and `UsageResult.vectorRows` and `vectorBytes`. KV values and the vector index sit side
 * by side in one namespace; a Float32Array passed to set() is NOT indexed. The semantics (all-or-nothing
 * writes, query validation order, bit-exact scoring, ordering, corruption, namespace isolation, error
 * hygiene) are normative in storage-api.md. The on-disk format is localdata-internal: the contract
 * promises only that behaviour. The driver namespace prefix '__ld_' is reserved for the SDK.
 */

export type Primitive = string | number | boolean | null;

export type Binary =
  | ArrayBuffer
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | Blob;

/**
 * Anything set() accepts. Functions, symbols, class instances, Map and Set are rejected with
 * StorageError "invalid_value".
 */
export type StorableValue =
  Primitive | Binary | Date | StorableValue[] | { [key: string]: StorableValue };

/**
 * Namespace grammar `^[a-z0-9][a-z0-9._-]{0,63}$`. The prefix '__ld_' is reserved for the SDK's own
 * driver namespaces (the vector index of namespace `ns` lives in '__ld_vec.' + ns); the grammar already
 * forbids a leading '_' and '/', so no caller namespace can collide with it.
 */
export const STORAGE_NS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Keys are 1..1024 UTF-16 code units and never contain U+0000. */
export const STORAGE_KEY_MAX = 1024;

export type StorageDriverName = 'opfs' | 'indexeddb' | 'memory';

export interface SetOptions {
  /** Time to live in milliseconds; an expired get() returns undefined and lazily deletes. */
  ttlMs?: number;
}

/** Maximum vector length (components). */
export const VECTOR_DIM_MAX = 4096;
/** Maximum UTF-8 length of a vector row key, in bytes. */
export const VECTOR_KEY_UTF8_MAX = 4096;
/** Maximum encoded size of a vector row's value, in bytes (1 MiB). */
export const VECTOR_VALUE_BYTES_MAX = 1048576;

/** 'cosine' or 'dot' (storage-api.md, Scoring). Default 'cosine'. */
export type VectorMetric = 'cosine' | 'dot';

// ---- approximate index (0.4.0) -----------------------------------------------------------------

/** 0.4.0: which index answers a query. 'flat' is the default and the fallback. */
export type VectorIndexKind = 'flat' | 'hnsw';
/** Smallest and largest HNSW `m` (links per node above layer 0; layer 0 holds up to 2m), and the default. */
export const HNSW_M_MIN = 4;
export const HNSW_M_MAX = 64;
export const HNSW_M_DEFAULT = 16;
/** HNSW efConstruction: the default and the largest value; the smallest is `m`. */
export const HNSW_EF_CONSTRUCTION_DEFAULT = 200;
export const HNSW_EF_CONSTRUCTION_MAX = 1000;
/** Largest `ef` of a query (an integer 1..HNSW_EF_MAX). */
export const HNSW_EF_MAX = 1000;
/** The effective ef of a query is max(ef ?? max(HNSW_EF_DEFAULT_MIN, k), k). */
export const HNSW_EF_DEFAULT_MIN = 64;
/** The highest layer a node can have. A graph that declares a higher level is refused. */
export const HNSW_MAX_LEVEL = 16;
/** Fix round 1: graphs loaded per open store; a buildIndex that would exceed it throws quota_exceeded reason 'max_graphs'. */
export const HNSW_MAX_GRAPHS = 64;
/**
 * The SDK-reserved driver namespace prefix of a namespace's HNSW graph: ANN_NS_PREFIX + ns. It sits next to
 * '__ld_vec.' (the flat index) and '__ld_doc.' (documents) under the reserved '__ld_' prefix, so no caller
 * namespace can name it.
 */
export const ANN_NS_PREFIX = '__ld_ann.' as const;

/**
 * One row of the vector index. `key`: the storage key rules, String.prototype.isWellFormed(), and a UTF-8
 * length <= VECTOR_KEY_UTF8_MAX, else invalid_key. `vector`: length 1..VECTOR_DIM_MAX and equal to the
 * namespace dim, every component finite, selfDot <= 1e30, else invalid_value. `value`: encoded size <=
 * VECTOR_VALUE_BYTES_MAX, else invalid_value.
 */
export interface VectorRow {
  key: string;
  vector: Float32Array;
  value?: StorableValue;
}

export interface PutVectorsResult {
  /** Rows written by this call (new and replaced). */
  written: number;
  /** Of those, rows that replaced a live row with the same key. */
  replaced: number;
  /** Live rows in the namespace's index after the call. */
  rows: number;
}

export interface QueryOptions {
  /** Only keys starting with this prefix (compared as UTF-8 bytes) are candidates. */
  filterPrefix?: string;
  /** Default 'cosine'. */
  metric?: VectorMetric;
  /** false leaves `value` off every hit. Default: values are returned when the row has one. */
  values?: boolean;
  /**
   * 0.4.0. The index the caller asks for; default 'flat'. 'hnsw' answers from a current, valid graph, else the
   * flat scan answers (same results as flat) and the event reports the fallback.
   */
  index?: VectorIndexKind;
  /** 0.4.0. HNSW search breadth, an integer 1..HNSW_EF_MAX; effective ef = max(ef ?? max(64, k), k). Ignored by flat. */
  ef?: number;
}

/** 0.4.0. What buildIndex() builds. */
export interface BuildIndexOptions {
  kind: 'hnsw';
  /** Default 'cosine'. A query with another metric falls back to flat ('metric'). */
  metric?: VectorMetric;
  /** HNSW_M_MIN..HNSW_M_MAX, default HNSW_M_DEFAULT. */
  m?: number;
  /** m..HNSW_EF_CONSTRUCTION_MAX, default HNSW_EF_CONSTRUCTION_DEFAULT. */
  efConstruction?: number;
  /** uint32, default 1. Build is deterministic for (rows, order, metric, m, efConstruction, seed). */
  seed?: number;
}

export interface BuildIndexResult {
  kind: 'hnsw';
  /** Rows the graph was built over (the live flat rows at the HEAD generation). */
  rows: number;
  liveRows: number;
  /** Graph bytes written. */
  bytes: number;
  /** The flat HEAD generation the graph is current for. */
  generation: number;
  /** True when the call replaced an existing graph. */
  replaced: boolean;
}

/** 0.4.0. Facts about the namespace's HNSW graph (VectorIndexInfo.ann). */
export interface AnnIndexInfo {
  kind: 'hnsw';
  metric: VectorMetric;
  m: number;
  efConstruction: number;
  seed: number;
  nodes: number;
  liveNodes: number;
  bytes: number;
  generation: number;
  /** True only when the graph generation EQUALS the flat HEAD generation. */
  current: boolean;
}

export interface VectorIndexInfo {
  formatVersion: 1;
  dtype: 'f32';
  dim: number;
  /** Live rows. */
  rows: number;
  /** Rows on disk including replaced and deleted ones (no compaction in 0.2). */
  totalRows: number;
  segments: number;
  /** Index bytes on the driver (vector, meta, key and HEAD parts). */
  bytes: number;
  generation: number;
  /** The scan kernel in use. */
  kernel: 'simd' | 'scalar';
  /** 0.4.0: the HNSW graph, when the namespace has one (a refused graph is not reported). */
  ann?: AnnIndexInfo;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  keys: string[];
  cursor?: string;
}

export interface UsageResult {
  /** All bytes, including vectorBytes and the bytes of the documents. */
  bytes: number;
  quotaBytes?: number;
  /** KV items only. */
  items: number;
  /** Live vector rows (omitted when there is no index in scope). */
  vectorRows?: number;
  /** Bytes of the vector index (omitted when there is no index in scope). */
  vectorBytes?: number;
  /** 0.3.0: live documents (omitted when there is no document namespace in scope). */
  documents?: number;
  /** 0.4.0: bytes of the HNSW graph, included in `bytes` (omitted when no graph is in scope). */
  annBytes?: number;
}

export interface QueryHit {
  key: string;
  score: number;
  value?: StorableValue;
}

// ---- documents API (0.3.0) -----------------------------------------------------------------------

/** A document id: `^[a-z0-9][a-z0-9_-]{0,63}$`. 'constructor' and 'prototype' are legal ids. */
export const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Maximum DocumentInput.title length, in UTF-16 code units; String.prototype.isWellFormed() must hold. */
export const DOC_TITLE_MAX = 256;
/** Maximum number of keys in DocumentInput.meta. */
export const DOC_META_KEYS_MAX = 16;
/** Maximum UTF-8 length of ChunkInput.text, in bytes. */
export const CHUNK_TEXT_UTF8_MAX = 16384;
/** Maximum number of chunks of one document (ordinals 0..DOC_CHUNKS_MAX - 1). */
export const DOC_CHUNKS_MAX = 20000;
/** Maximum number of keys in ChunkInput.gate. */
export const CHUNK_GATE_KEYS_MAX = 8;
/** Maximum k of queryChunks(). */
export const DOC_QUERY_K_MAX = 1000;

/**
 * What the application says about a document. `sha256` is computed by the application over the source
 * bytes (64 lowercase hex). `meta` has at most DOC_META_KEYS_MAX keys matching
 * `^[A-Za-z][A-Za-z0-9_]{0,63}$`; only __proto__, constructor and prototype are refused (details.reason
 * 'reserved_key'): toString, valueOf, hasOwnProperty and the like are legal and round-trip as own members.
 * String values are at most 1024 UTF-16 units.
 */
export interface DocumentInput {
  docId: string;
  title: string;
  sha256: string;
  /** Integer 0..2^53-1. */
  bytes: number;
  /** Integer 0..100000. */
  pages: number;
  meta?: Record<string, Primitive>;
}

export interface DocumentInfo extends DocumentInput {
  /** Chunks stored for the document. */
  chunks: number;
  /** The vector length of the document's namespace; 0 when `chunks` is 0. */
  dim: number;
  /** Epoch milliseconds, set by the SDK at the commit. */
  createdAt: number;
}

/**
 * One text chunk of a document with its vector. `ordinal` is an integer 0..DOC_CHUNKS_MAX-1, unique in the
 * call; `pageStart` is 1..pages and `pageEnd` is pageStart..pages; `text` is 1..CHUNK_TEXT_UTF8_MAX UTF-8
 * bytes and well-formed; `vector` follows the VectorRow rules and has the namespace dim; `gate` (at most
 * CHUNK_GATE_KEYS_MAX keys, the meta key rules) carries the extraction gate's verdict for the chunk.
 */
export interface ChunkInput {
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  vector: Float32Array;
  gate?: Record<string, Primitive>;
}

export interface PutDocumentResult {
  docId: string;
  chunks: number;
  /** True when the call replaced a document with the same docId (in the same commit). */
  replaced: boolean;
  /** Live chunk rows in ns after the call. */
  rows: number;
}

export interface ChunkHit {
  docId: string;
  title: string;
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  score: number;
}

export interface QueryChunksOptions {
  /** Only chunks of this document are candidates. */
  docId?: string;
  /** Default 'cosine'. */
  metric?: VectorMetric;
}

export interface StorageApi {
  /** Overwrites any existing value. Throws quota_exceeded BEFORE writing when the configured quota would be exceeded. */
  set(ns: string, key: string, value: StorableValue, opts?: SetOptions): Promise<void>;
  /** Binary round-trips byte-exact; JSON-like values by deep equality (Date -> Date, NaN and -0 preserved). */
  get<T extends StorableValue = StorableValue>(ns: string, key: string): Promise<T | undefined>;
  /** Resolves true when a value was removed. */
  delete(ns: string, key: string): Promise<boolean>;
  /**
   * Brute-force top-k over the namespace's vector index: score descending, then key ascending by UTF-8
   * bytes; length min(k, candidates). Validation order and scoring are normative (storage-api.md).
   * Resolves [] when the namespace has no index. A structural or checksum failure rejects 'corrupt'.
   */
  query(ns: string, vector: Float32Array, k: number, opts?: QueryOptions): Promise<QueryHit[]>;
  /**
   * Adds or replaces rows in the namespace's vector index. ALL-OR-NOTHING per call: rows become visible
   * only when the whole call commits. See storage-api.md for the failure cases (duplicate_key, dim,
   * quota_exceeded with reason max_index_bytes or wasm_memory, generation).
   */
  putVectors(
    ns: string,
    rows: Iterable<VectorRow> | AsyncIterable<VectorRow>,
  ): Promise<PutVectorsResult>;
  /** Index facts, or undefined when the namespace has no index. */
  indexInfo(ns: string): Promise<VectorIndexInfo | undefined>;
  /**
   * 0.4.0. Builds the HNSW graph over the live rows, in stored order, deterministically for (rows, order,
   * metric, m, efConstruction, seed), and replaces any existing graph in one commit under the writer lock.
   * Throws quota_exceeded (reason 'quota' | 'max_index_bytes' | 'wasm_memory' | 'max_graphs') before writing. Allowed on an
   * empty namespace. Validation: ns, then opts (invalid_value with details.reason 'kind' | 'm' |
   * 'efConstruction' | 'seed' | 'metric').
   */
  buildIndex(ns: string, opts: BuildIndexOptions): Promise<BuildIndexResult>;
  /** 0.4.0. Removes the namespace's graph (the flat index is untouched). Resolves true when one existed. */
  dropIndex(ns: string, kind: 'hnsw'): Promise<boolean>;
  /**
   * 0.3.0. Stores a document and every chunk in ONE commit (all-or-nothing); a document with the same
   * docId is replaced in that same commit (replaced: true). Zero chunks is allowed. Validation order and
   * the details.reason values are normative (storage-api.md, Documents (0.3.0)).
   */
  putDocument(
    ns: string,
    doc: DocumentInput,
    chunks: Iterable<ChunkInput> | AsyncIterable<ChunkInput>,
  ): Promise<PutDocumentResult>;
  /** 0.3.0. The document, or undefined. */
  getDocument(ns: string, docId: string): Promise<DocumentInfo | undefined>;
  /** 0.3.0. Every document of ns, sorted by docId (UTF-8 bytes). */
  listDocuments(ns: string): Promise<DocumentInfo[]>;
  /**
   * 0.3.0. One commit. After it resolves true no queryChunks returns the document's chunks, including after
   * a reopen. The bytes may remain in the driver until clear(ns) (no compaction).
   */
  deleteDocument(ns: string, docId: string): Promise<boolean>;
  /**
   * 0.3.0. Brute-force top-k over the document chunks of ns: score descending, then docId ascending by
   * UTF-8 bytes, then ordinal ascending; length min(k, candidates), [] when there are no documents. k is an
   * integer 1..DOC_QUERY_K_MAX.
   */
  queryChunks(
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: QueryChunksOptions,
  ): Promise<ChunkHit[]>;
  /**
   * 0.3.0, events only. A namespace that starts with `prefix` is emitted in event attrs as prefix + '*'
   * (an application registers 'dockit.d' so that 'dockit.d<docId>' never reaches an event). The SDK
   * registers 'dockit.d' itself.
   */
  redactNamespacePrefix(prefix: string): void;
  usage(ns?: string): Promise<UsageResult>;
  clear(ns: string): Promise<void>;
  list(ns: string, opts?: ListOptions): Promise<ListResult>;
  readonly driver: StorageDriverName;
  close(): Promise<void>;
}

export type StorageErrorCode =
  /** Thrown by 0.1 query(); kept so a 0.1 consumer still compiles. A 0.2 implementation never throws it. */
  | 'not_implemented'
  | 'quota_exceeded'
  | 'invalid_key'
  | 'invalid_namespace'
  | 'invalid_value'
  | 'driver_unavailable'
  | 'io'
  | 'closed'
  /** A vector index or document record failed a structural or checksum check; details { ns, file, reason }. */
  | 'corrupt';

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;
  readonly details: Record<string, Primitive> | undefined;

  constructor(code: StorageErrorCode, message: string, details?: Record<string, Primitive>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface DriverPutMeta {
  size: number;
  expiresAt?: number;
}

export interface DriverRecord {
  bytes: Uint8Array;
  meta: DriverPutMeta;
}

/** Low-level byte store. All methods are async. The SDK validates and encodes above it. */
export interface StorageDriver {
  readonly name: StorageDriverName;
  open(): Promise<void>;
  close(): Promise<void>;
  put(ns: string, key: string, bytes: Uint8Array, meta: DriverPutMeta): Promise<void>;
  getBytes(ns: string, key: string): Promise<DriverRecord | undefined>;
  del(ns: string, key: string): Promise<boolean>;
  keys(ns: string, prefix?: string): Promise<string[]>;
  clear(ns: string): Promise<void>;
  usage(ns?: string): Promise<{ bytes: number; items: number }>;
}
