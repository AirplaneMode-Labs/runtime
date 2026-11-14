/**
 * Storage API contract 0.2.0 (draft; normative; see storage-api.md for prose).
 *
 * Implemented by @airplanemode/localdata over OPFS with an IndexedDB fallback. The SDK does
 * validation, codec and quota accounting above a StorageDriver.
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
  /** All bytes, including vectorBytes. */
  bytes: number;
  quotaBytes?: number;
  /** KV items only. */
  items: number;
  /** Live vector rows (omitted when there is no index in scope). */
  vectorRows?: number;
  /** Bytes of the vector index (omitted when there is no index in scope). */
  vectorBytes?: number;
}

export interface QueryHit {
  key: string;
  score: number;
  value?: StorableValue;
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
  /** The vector index failed a structural or checksum check; details { ns, file, reason }. */
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
