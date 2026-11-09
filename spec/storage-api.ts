/**
 * Storage API contract 0.1.0 (normative; see storage-api.md for prose).
 *
 * Implemented by @airplanemode/localdata over OPFS with an IndexedDB fallback. The SDK does
 * validation, codec and quota accounting above a StorageDriver. `query()` is frozen now and
 * MUST throw StorageError "not_implemented" (message naming Sprint 4) in 0.1.
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

/** Namespace grammar `^[a-z0-9][a-z0-9._-]{0,63}$`. */
export const STORAGE_NS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Keys are 1..1024 UTF-16 code units and never contain U+0000. */
export const STORAGE_KEY_MAX = 1024;

export type StorageDriverName = 'opfs' | 'indexeddb' | 'memory';

export interface SetOptions {
  /** Time to live in milliseconds; an expired get() returns undefined and lazily deletes. */
  ttlMs?: number;
}

export interface QueryOptions {
  /** Only keys starting with this prefix are candidates. */
  filterPrefix?: string;
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
  bytes: number;
  quotaBytes?: number;
  items: number;
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
  /** 0.1: MUST throw StorageError "not_implemented" whose message names Sprint 4. Signature frozen. */
  query(ns: string, vector: Float32Array, k: number, opts?: QueryOptions): Promise<QueryHit[]>;
  usage(ns?: string): Promise<UsageResult>;
  clear(ns: string): Promise<void>;
  list(ns: string, opts?: ListOptions): Promise<ListResult>;
  readonly driver: StorageDriverName;
  close(): Promise<void>;
}

export type StorageErrorCode =
  | 'not_implemented'
  | 'quota_exceeded'
  | 'invalid_key'
  | 'invalid_namespace'
  | 'invalid_value'
  | 'driver_unavailable'
  | 'io'
  | 'closed';

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
